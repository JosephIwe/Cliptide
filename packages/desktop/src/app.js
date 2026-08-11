/**
 * Desktop application orchestration.
 *
 * Wires the engine, tray, global shortcut, overlay window, and IPC into one
 * lifecycle. Every Electron dependency is injected, so the whole lifecycle —
 * start, summon, dismiss, quit — is exercised in tests with fakes, on a
 * machine with no display server.
 *
 * LOGGING RULE, inherited and enforced: counts, kinds, and reasons only. No
 * clipboard payload and no preview ever reaches a log line. The monitor
 * listeners below are the only place tempted to break that, and they don't.
 */

import { createIpcHandlers, IPC_CHANNELS } from './ipc.js';
import { createShortcutManager } from './shortcut.js';
import { createTrayController } from './tray.js';
import { createOverlayWindow } from './overlay/window.js';

/**
 * @param {Object} options
 * @param {object} options.electron `{app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, ipcMain, screen}`
 * @param {object} options.cliptide a started or startable engine from createCliptide()
 * @param {string} [options.platform]
 * @param {(line: string) => void} [options.log]
 */
export function createDesktopApp({ electron, cliptide, platform = process.platform, log = console.log }) {
  if (!electron) throw new TypeError('createDesktopApp requires electron bindings');
  if (!cliptide) throw new TypeError('createDesktopApp requires a Cliptide engine');

  const { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, ipcMain, screen } = electron;

  let overlay = null;
  let tray = null;
  let shortcut = null;
  let started = false;
  const registeredChannels = [];

  const summon = () => {
    if (!overlay) return false;
    // Toggle rather than always-show: pressing the shortcut again is the
    // fastest way to dismiss something you opened by mistake.
    return overlay.toggle();
  };

  const hideOverlay = () => {
    overlay?.hide();
  };

  const quit = async () => {
    await stop();
    app.quit();
  };

  async function start() {
    if (started) return api;
    started = true;

    // 1. Engine first: capture should be running before any UI exists, so a
    //    copy made during startup is not missed.
    await cliptide.start();

    cliptide.monitor.on('captured', ({ item }) => {
      log(`[cliptide] captured kind=${item.kind} bytes=${item.bytes} sensitive=${item.sensitive}`);
    });
    cliptide.monitor.on('skipped', ({ reason }) => {
      log(`[cliptide] skipped reason=${reason}`);
    });
    cliptide.monitor.on('error', ({ error, backoffMs }) => {
      log(`[cliptide] source error, backing off ${backoffMs}ms: ${error?.message ?? 'unknown'}`);
    });

    // 2. Overlay window, created hidden. Building it up front means the
    //    summon path is show() rather than construct-then-show.
    overlay = createOverlayWindow({ BrowserWindow, screen, app, platform });
    overlay.create();

    // 3. IPC.
    const handlers = createIpcHandlers({
      history: cliptide.history,
      onClose: hideOverlay,
    });
    for (const [channel, handler] of Object.entries(handlers)) {
      ipcMain.handle(channel, (_event, payload) => handler(payload));
      registeredChannels.push(channel);
    }

    // 4. Global shortcut. Failure is reported, never silent.
    const configured = cliptide.settings?.get()?.ui?.summonShortcut;
    shortcut = createShortcutManager({
      globalShortcut,
      ...(configured ? { accelerator: configured } : {}),
      onSummon: summon,
    });
    const registration = shortcut.register();

    if (registration.ok) {
      log(
        `[cliptide] summon shortcut ${registration.accelerator}` +
          (registration.fellBack ? ' (fell back; preferred binding was taken)' : ''),
      );
    } else {
      // Actionable, and surfaced in the tray too — a clipboard manager whose
      // shortcut silently failed looks identical to one that is broken.
      log(`[cliptide] WARNING: ${registration.error}. Open Cliptide from the tray instead.`);
    }

    // 5. Tray, last, so it can display the accelerator that actually bound.
    tray = createTrayController({
      Tray,
      Menu,
      nativeImage,
      onOpen: () => overlay.show(),
      onQuit: () => void quit(),
      getShortcut: () => shortcut?.accelerator ?? null,
    });
    tray.create();

    // No dock icon: this is a background utility, not a windowed app.
    if (platform === 'darwin' && app.dock?.hide) app.dock.hide();

    return api;
  }

  async function stop() {
    if (!started) return api;
    started = false;

    shortcut?.unregister();
    tray?.destroy();
    overlay?.destroy();

    for (const channel of registeredChannels) {
      ipcMain.removeHandler?.(channel);
    }
    registeredChannels.length = 0;

    // Engine last: the monitor keeps running until every UI surface is gone,
    // so nothing tries to read history from a closed store.
    await cliptide.stop();
    return api;
  }

  const api = {
    start,
    stop,
    summon,
    get overlay() {
      return overlay;
    },
    get tray() {
      return tray;
    },
    get shortcut() {
      return shortcut;
    },
    get started() {
      return started;
    },
    /** Diagnostics for the tray and for support questions. Never payloads. */
    get diagnostics() {
      return {
        started,
        shortcut: shortcut?.diagnostics ?? null,
        overlayVisible: overlay?.isVisible ?? false,
        channels: [...registeredChannels],
      };
    },
  };

  return api;
}

export { IPC_CHANNELS };
