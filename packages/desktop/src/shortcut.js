/**
 * Global summon shortcut.
 *
 * Wraps Electron's `globalShortcut` so registration is testable and so failure
 * is a reported outcome rather than a silent no-op. A clipboard manager whose
 * shortcut quietly failed to bind is indistinguishable from one that is
 * broken, and the user has no way to tell which.
 *
 * The default lives in engine settings (`ui.summonShortcut`), already validated
 * as an accelerator, so it is configurable later without touching this file.
 */

/**
 * Why `CommandOrControl+Shift+V`:
 *  - `Cmd/Ctrl+V` is paste, so the paste-adjacent muscle memory is right.
 *  - Adding Shift avoids every default paste binding on both platforms.
 *  - `CommandOrControl` resolves to Cmd on macOS and Ctrl on Windows/Linux,
 *    so there is no platform branch here.
 */
export const DEFAULT_SUMMON_SHORTCUT = 'CommandOrControl+Shift+V';

/**
 * Fallbacks tried in order when the preferred accelerator is taken.
 *
 * Registration fails when another application already owns the combination.
 * Silently giving up would leave the product unusable, so we try a small,
 * predictable ladder and report exactly which one bound.
 */
export const FALLBACK_SHORTCUTS = Object.freeze([
  'CommandOrControl+Shift+C',
  'Alt+Shift+V',
]);

/**
 * @param {Object} options
 * @param {{register: Function, unregister: Function, isRegistered: Function}} options.globalShortcut
 * @param {string} [options.accelerator]
 * @param {string[]} [options.fallbacks]
 * @param {() => void} options.onSummon
 */
export function createShortcutManager({
  globalShortcut,
  accelerator = DEFAULT_SUMMON_SHORTCUT,
  fallbacks = FALLBACK_SHORTCUTS,
  onSummon,
}) {
  if (!globalShortcut || typeof globalShortcut.register !== 'function') {
    throw new TypeError('createShortcutManager requires Electron globalShortcut');
  }
  if (typeof onSummon !== 'function') {
    throw new TypeError('createShortcutManager requires an onSummon callback');
  }

  let bound = null;
  /** Diagnostics the tray and logs can surface. Never contains clipboard data. */
  let lastError = null;
  const attempts = [];

  function tryRegister(candidate) {
    try {
      // `register` returns false when the OS refuses the binding; some
      // platforms throw instead. Both mean the same thing here.
      const ok = globalShortcut.register(candidate, onSummon) !== false;
      attempts.push({ accelerator: candidate, ok, error: null });
      return ok;
    } catch (err) {
      attempts.push({ accelerator: candidate, ok: false, error: err?.message ?? String(err) });
      return false;
    }
  }

  return {
    get accelerator() {
      return bound;
    },

    get registered() {
      return bound !== null;
    },

    /** Attempts, in order, with the reason each one failed. */
    get diagnostics() {
      return { bound, requested: accelerator, attempts: [...attempts], lastError };
    },

    /**
     * @returns {{ok: boolean, accelerator: string|null, fellBack: boolean, error: string|null}}
     */
    register() {
      attempts.length = 0;
      lastError = null;

      for (const candidate of [accelerator, ...fallbacks]) {
        if (tryRegister(candidate)) {
          bound = candidate;
          return {
            ok: true,
            accelerator: candidate,
            fellBack: candidate !== accelerator,
            error: null,
          };
        }
      }

      bound = null;
      lastError =
        `could not bind ${accelerator} or any fallback; ` +
        'another application is likely holding these combinations';
      return { ok: false, accelerator: null, fellBack: false, error: lastError };
    },

    unregister() {
      if (bound === null) return false;
      try {
        globalShortcut.unregister(bound);
      } catch {
        // Unregistering during shutdown is best-effort; the OS releases the
        // binding when the process exits regardless.
      }
      bound = null;
      return true;
    },
  };
}
