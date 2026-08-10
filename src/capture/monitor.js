/**
 * The clipboard monitor.
 *
 * Polls a ClipboardSource, and hands anything new to the store. Polling rather
 * than subscribing is not a shortcut: no mainstream desktop OS offers a
 * reliable, permission-free clipboard change notification. The cost is kept
 * near zero by reading a cheap change token first and only reading the payload
 * when that token moves.
 *
 * The loop is built to survive a long-running background process:
 *
 *  - **Source failures back off** exponentially and recover. A display server
 *    restart or a locked pasteboard must not kill the process.
 *  - **Sleep/wake is detected** by measuring the gap between ticks. Waking does
 *    not fire a burst of catch-up ticks, and it resets any backoff.
 *  - **Pause keeps polling the token** but stops reading and storing, so
 *    resuming does not suddenly capture whatever was copied while paused.
 *  - **A tick never throws.** The next tick is always scheduled in `finally`;
 *    a monitor that dies silently is worse than one that logs an error.
 *
 * Deduplication is deliberately left to the store: it owns the content hash
 * index, and an app that re-sets the clipboard to identical content should
 * promote the existing entry, not create a twin.
 */

import { EventEmitter } from 'node:events';
import { systemClock } from '../core/clock.js';
import { assertClipboardSource } from './source.js';

export const MONITOR_EVENTS = Object.freeze({
  CAPTURED: 'captured',
  PROMOTED: 'promoted',
  SKIPPED: 'skipped',
  ERROR: 'error',
  WAKE: 'wake',
  PAUSED: 'paused',
  RESUMED: 'resumed',
  STARTED: 'started',
  STOPPED: 'stopped',
});

/** Fast enough to feel instant, slow enough to stay invisible in a CPU graph. */
export const DEFAULT_POLL_INTERVAL_MS = 400;

/** A gap this much larger than the poll interval means the machine slept. */
export const DEFAULT_SLEEP_THRESHOLD_MS = 30_000;

/** Backoff ceiling: a broken source is retried at least this often. */
export const DEFAULT_MAX_BACKOFF_MS = 30_000;

export class ClipboardMonitor extends EventEmitter {
  #timer = null;
  #running = false;
  #paused = false;
  #lastToken = null;
  #lastTickAt = 0;
  #backoffMs = 0;
  #ticking = false;

  /**
   * @param {Object} options
   * @param {import('./source.js').ClipboardSource} options.source
   * @param {import('../storage/store.js').ClipStore} options.store
   * @param {import('../core/clock.js').Clock} [options.clock]
   * @param {number} [options.pollIntervalMs]
   * @param {number} [options.sleepThresholdMs]
   * @param {number} [options.maxBackoffMs]
   * @param {boolean} [options.captureOnStart] record whatever is already on the
   *   clipboard when the agent launches. It still passes every privacy check.
   */
  constructor({
    source,
    store,
    clock = systemClock,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    sleepThresholdMs = DEFAULT_SLEEP_THRESHOLD_MS,
    maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
    captureOnStart = true,
  }) {
    super();
    this.source = assertClipboardSource(source);
    this.store = store;
    this.clock = clock;
    this.pollIntervalMs = pollIntervalMs;
    this.sleepThresholdMs = sleepThresholdMs;
    this.maxBackoffMs = maxBackoffMs;
    this.captureOnStart = captureOnStart;

    this.stats = { ticks: 0, captured: 0, promoted: 0, skipped: 0, errors: 0, wakes: 0 };
  }

  get running() {
    return this.#running;
  }

  get paused() {
    return this.#paused;
  }

  /** Emit without letting a listener's exception escape into the poll loop. */
  #emitSafely(event, payload) {
    try {
      this.emit(event, payload);
    } catch {
      // A crashing listener must not stop clipboard monitoring.
    }
  }

  async start() {
    if (this.#running) return this;
    this.#running = true;
    this.#lastTickAt = this.clock.now();

    if (!this.captureOnStart) {
      // Establish the baseline without recording: the user launched the agent,
      // they did not just copy this.
      this.#lastToken = await this.source.changeToken().catch(() => null);
    }

    this.#emitSafely(MONITOR_EVENTS.STARTED, { pollIntervalMs: this.pollIntervalMs });
    this.#schedule(0);
    return this;
  }

  stop() {
    if (!this.#running) return this;
    this.#running = false;
    if (this.#timer !== null) {
      this.clock.clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#emitSafely(MONITOR_EVENTS.STOPPED, { ...this.stats });
    return this;
  }

  /**
   * Stop recording without stopping the loop.
   *
   * The token keeps advancing while paused, so resuming captures the *next*
   * copy rather than replaying everything copied during the pause. That is the
   * behavior a user means by "pause": stop watching, not watch silently.
   */
  pause() {
    if (this.#paused) return this;
    this.#paused = true;
    this.#emitSafely(MONITOR_EVENTS.PAUSED, {});
    return this;
  }

  resume() {
    if (!this.#paused) return this;
    this.#paused = false;
    this.#emitSafely(MONITOR_EVENTS.RESUMED, {});
    return this;
  }

  #schedule(delayMs) {
    if (!this.#running) return;
    const delay = delayMs ?? (this.#backoffMs || this.pollIntervalMs);
    this.#timer = this.clock.setTimeout(() => this.#tick(), delay);
  }

  #noteFailure(err) {
    this.stats.errors += 1;
    this.#backoffMs = Math.min(
      Math.max(this.pollIntervalMs, this.#backoffMs * 2 || this.pollIntervalMs * 2),
      this.maxBackoffMs,
    );
    this.#emitSafely(MONITOR_EVENTS.ERROR, { error: err, backoffMs: this.#backoffMs });
  }

  async #tick() {
    this.#timer = null;
    if (!this.#running) return;
    // A slow read must not overlap the next scheduled tick.
    if (this.#ticking) {
      this.#schedule();
      return;
    }
    this.#ticking = true;
    this.stats.ticks += 1;

    const now = this.clock.now();
    const gap = now - this.#lastTickAt;
    this.#lastTickAt = now;

    if (gap > this.sleepThresholdMs) {
      // The machine slept or the process was suspended. Do not fire catch-up
      // ticks for the missed interval; just resume the normal cadence.
      this.stats.wakes += 1;
      this.#backoffMs = 0;
      this.#emitSafely(MONITOR_EVENTS.WAKE, { gapMs: gap });
    }

    try {
      const token = await this.source.changeToken();
      this.#backoffMs = 0;

      if (token === this.#lastToken) return;
      this.#lastToken = token;

      if (this.#paused) return;

      const snapshot = await this.source.read();
      if (!snapshot) return;

      await this.#ingest(snapshot);
    } catch (err) {
      this.#noteFailure(err);
    } finally {
      this.#ticking = false;
      this.#schedule();
    }
  }

  async #ingest(snapshot) {
    const result = await this.store.add(snapshot);

    if (!result.stored) {
      this.stats.skipped += 1;
      this.#emitSafely(MONITOR_EVENTS.SKIPPED, { reason: result.reason });
      return result;
    }
    if (result.created) {
      this.stats.captured += 1;
      this.#emitSafely(MONITOR_EVENTS.CAPTURED, { item: result.item });
    } else {
      this.stats.promoted += 1;
      this.#emitSafely(MONITOR_EVENTS.PROMOTED, { item: result.item });
    }
    return result;
  }

  /**
   * Read and record the clipboard right now, ignoring the change token.
   *
   * Used when the app cannot trust its token — after a source is replaced, or
   * when the user explicitly asks to capture the current clipboard.
   */
  async captureNow() {
    const snapshot = await this.source.read();
    this.#lastToken = await this.source.changeToken().catch(() => this.#lastToken);
    if (!snapshot) return { stored: false, created: false, item: null, reason: 'empty' };
    return this.#ingest(snapshot);
  }
}
