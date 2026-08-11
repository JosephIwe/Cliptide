/**
 * Fakes for the Electron pieces the desktop app injects.
 *
 * Shaped from the real API surface so the lifecycle, tray, shortcut, and IPC
 * wiring can be exercised on a machine with no display server. These stand in
 * for structure and call sequencing — they do not claim to reproduce GUI
 * behaviour, which is why the overlay's on-screen appearance remains a
 * documented manual check.
 */

export class FakeBrowserWindow {
  constructor(options = {}) {
    this.options = options;
    this.visible = false;
    this.destroyed = false;
    this.loadedFile = null;
    this.position = null;
    this.focused = false;
    this.listeners = new Map();
  }

  loadFile(file) {
    this.loadedFile = file;
  }

  on(event, handler) {
    this.listeners.set(event, handler);
    return this;
  }

  emit(event, ...args) {
    this.listeners.get(event)?.(...args);
  }

  show() {
    this.visible = true;
  }

  hide() {
    this.visible = false;
  }

  focus() {
    this.focused = true;
  }

  isVisible() {
    return this.visible;
  }

  setPosition(x, y) {
    this.position = { x, y };
  }

  center() {
    this.position = { x: 0, y: 0 };
  }

  destroy() {
    this.destroyed = true;
    this.visible = false;
  }
}

export class FakeTray {
  constructor(icon) {
    this.icon = icon;
    this.tooltip = null;
    this.menu = null;
    this.destroyed = false;
    this.listeners = new Map();
  }

  setToolTip(text) {
    this.tooltip = text;
  }

  setContextMenu(menu) {
    this.menu = menu;
  }

  on(event, handler) {
    this.listeners.set(event, handler);
  }

  emit(event) {
    this.listeners.get(event)?.();
  }

  destroy() {
    this.destroyed = true;
  }
}

/**
 * @param {Object} [options]
 * @param {string[]} [options.refuseShortcuts] accelerators the OS "already owns"
 * @param {string[]} [options.throwShortcuts] accelerators whose registration throws
 */
export function createFakeElectron({ refuseShortcuts = [], throwShortcuts = [] } = {}) {
  const state = {
    quit: false,
    hidden: false,
    dockHidden: false,
    windows: [],
    trays: [],
    registered: new Map(),
    handlers: new Map(),
  };

  const electron = {
    app: {
      quit: () => {
        state.quit = true;
      },
      hide: () => {
        state.hidden = true;
      },
      dock: {
        hide: () => {
          state.dockHidden = true;
        },
      },
    },

    BrowserWindow: class extends FakeBrowserWindow {
      constructor(options) {
        super(options);
        state.windows.push(this);
      }
    },

    Tray: class extends FakeTray {
      constructor(icon) {
        super(icon);
        state.trays.push(this);
      }
    },

    Menu: {
      buildFromTemplate: (template) => ({ template }),
    },

    nativeImage: {
      createFromBuffer: (buffer) => ({ buffer, kind: 'nativeImage' }),
    },

    globalShortcut: {
      register(accelerator, handler) {
        if (throwShortcuts.includes(accelerator)) {
          throw new Error(`cannot register ${accelerator}`);
        }
        if (refuseShortcuts.includes(accelerator)) return false;
        state.registered.set(accelerator, handler);
        return true;
      },
      unregister(accelerator) {
        state.registered.delete(accelerator);
      },
      isRegistered: (accelerator) => state.registered.has(accelerator),
    },

    ipcMain: {
      handle(channel, handler) {
        state.handlers.set(channel, handler);
      },
      removeHandler(channel) {
        state.handlers.delete(channel);
      },
    },

    screen: {
      getCursorScreenPoint: () => ({ x: 100, y: 100 }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    },
  };

  return {
    electron,
    state,
    /** Fire the bound global shortcut, as the OS would. */
    pressShortcut(accelerator) {
      const handler = state.registered.get(accelerator);
      if (!handler) throw new Error(`no handler bound to ${accelerator}`);
      return handler();
    },
    /** Invoke a registered IPC handler, as the renderer would. */
    invoke(channel, payload) {
      const handler = state.handlers.get(channel);
      if (!handler) throw new Error(`no handler registered for ${channel}`);
      return handler({}, payload);
    },
  };
}
