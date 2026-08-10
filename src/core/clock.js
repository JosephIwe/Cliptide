/**
 * Injectable time source.
 *
 * Every module that needs "now" or a timer takes a Clock. Tests then drive
 * time explicitly instead of sleeping, which is what keeps the capture and
 * retention suites fast and deterministic. Production code uses systemClock.
 */

/**
 * @typedef {Object} Clock
 * @property {() => number} now Milliseconds since the UNIX epoch.
 * @property {(fn: Function, ms: number) => any} setTimeout
 * @property {(handle: any) => void} clearTimeout
 */

/** The real clock. Timers are unref'd so a pending tick never holds the process open. */
export const systemClock = Object.freeze({
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    if (typeof handle?.unref === 'function') handle.unref();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle),
});

/**
 * A manually advanced clock for tests.
 *
 * Timers fire when `advance()` passes their due time, in due order. Callbacks
 * scheduled during an advance are honored within the same advance if they fall
 * inside the window, so a self-rescheduling poll loop can be stepped naturally.
 *
 * @param {number} [start] initial epoch milliseconds
 */
export function createManualClock(start = 1_700_000_000_000) {
  let current = start;
  let nextHandle = 1;
  /** @type {Map<number, {due: number, fn: Function}>} */
  const timers = new Map();

  return {
    now: () => current,

    setTimeout(fn, ms) {
      const handle = nextHandle++;
      timers.set(handle, { due: current + Math.max(0, ms), fn });
      return handle;
    },

    clearTimeout(handle) {
      timers.delete(handle);
    },

    /** Move time forward, firing every timer that comes due. */
    async advance(ms) {
      const target = current + ms;
      // Loop rather than iterate once: a fired timer may schedule another that
      // also falls inside this window (the monitor's poll loop does exactly that).
      for (;;) {
        let nextHandleDue = null;
        let earliest = Infinity;
        for (const [handle, timer] of timers) {
          if (timer.due <= target && timer.due < earliest) {
            earliest = timer.due;
            nextHandleDue = handle;
          }
        }
        if (nextHandleDue === null) break;
        const timer = timers.get(nextHandleDue);
        timers.delete(nextHandleDue);
        // An overdue timer — one whose due time `jump()` already passed — fires
        // at the present, not in the past. Time must never run backwards here,
        // or code that measures the gap between ticks (the monitor's sleep
        // detection) would see a nonsensical interval.
        current = Math.max(current, timer.due);
        await timer.fn();
      }
      current = Math.max(current, target);
    },

    /** Jump forward without firing timers — simulates the machine sleeping. */
    jump(ms) {
      current += ms;
    },

    get pendingTimers() {
      return timers.size;
    },
  };
}
