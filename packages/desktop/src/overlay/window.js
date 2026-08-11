/**
 * The overlay window.
 *
 * A frameless, always-on-top strip that is created once and then shown and
 * hidden. Recreating it per summon would add window-construction latency to
 * the interaction that must feel instant, and would throw away the renderer's
 * warm state each time.
 *
 * FOCUS RETURN — the part that makes this usable:
 *
 * On dismiss the window hides, and the OS returns focus to whatever the user
 * was working in. On macOS `app.hide()` is used because hiding a single window
 * leaves the app itself frontmost, which would strand the user in Cliptide
 * rather than back in their editor.
 *
 * AUTOMATIC PASTE is deliberately not attempted. Electron's `sendInputEvent`
 * only reaches Electron's own webContents — it cannot deliver a keystroke to
 * another application. Doing so needs OS-level synthetic input (macOS CGEvent
 * behind an Accessibility grant; Windows SendInput), which is a platform hack
 * with a permission prompt attached. M2 restores the clipboard and returns
 * focus; the user presses paste. See docs/M2-OVERLAY.md.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Wide enough for a readable preview, short enough to stay a strip. */
export const OVERLAY_WIDTH = 680;
export const OVERLAY_HEIGHT = 420;

/**
 * @param {Object} options
 * @param {any} options.BrowserWindow
 * @param {any} options.screen Electron screen module, for cursor placement
 * @param {any} [options.app] used for macOS focus return
 * @param {string} [options.platform]
 */
export function createOverlayWindow({ BrowserWindow, screen, app = null, platform = process.platform }) {
  if (typeof BrowserWindow !== 'function') {
    throw new TypeError('createOverlayWindow requires Electron BrowserWindow');
  }

  let window = null;

  /** Place the overlay on whichever display the cursor is on. */
  function positionForCursor(win) {
    try {
      const cursor = screen.getCursorScreenPoint();
      const display = screen.getDisplayNearestPoint(cursor);
      const { x, y, width, height } = display.workArea;
      win.setPosition(
        Math.round(x + (width - OVERLAY_WIDTH) / 2),
        // Slightly above centre: closer to where the eye already is, and clear
        // of the dock/taskbar.
        Math.round(y + Math.max(0, height * 0.28)),
      );
    } catch {
      win.center?.();
    }
  }

  return {
    get window() {
      return window;
    },

    get isVisible() {
      return window !== null && typeof window.isVisible === 'function' && window.isVisible();
    },

    create() {
      if (window) return window;

      window = new BrowserWindow({
        width: OVERLAY_WIDTH,
        height: OVERLAY_HEIGHT,
        show: false,
        frame: false,
        resizable: false,
        movable: true,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        // A utility panel on macOS floats over full-screen spaces.
        type: platform === 'darwin' ? 'panel' : undefined,
        webPreferences: {
          preload: path.join(HERE, '..', 'preload.cjs'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          // Nothing here needs the network, and keeping web security on is one
          // more structural guarantee that clipboard data cannot leave.
          webSecurity: true,
        },
      });

      window.loadFile(path.join(HERE, 'renderer.html'));

      // A utility overlay that lingers after you click elsewhere is clutter.
      window.on('blur', () => this.hide());

      return window;
    },

    show() {
      if (!window) this.create();
      positionForCursor(window);
      window.show();
      window.focus();
      return window;
    },

    hide() {
      if (!window || !window.isVisible?.()) return false;
      window.hide();
      // Hiding one window leaves the app frontmost on macOS, which would keep
      // the user in Cliptide instead of returning them to their work.
      if (platform === 'darwin' && app?.hide) app.hide();
      return true;
    },

    toggle() {
      return this.isVisible ? (this.hide(), false) : (this.show(), true);
    },

    destroy() {
      if (!window) return false;
      window.destroy?.();
      window = null;
      return true;
    },
  };
}
