/**
 * Cliptide desktop entry point.
 *
 * Binds real Electron to the orchestration in `app.js` and nothing else. All
 * behaviour lives in injectable modules so it can be tested without a display
 * server; this file exists to supply the real dependencies.
 *
 * LOGGING RULE: counts, kinds, and reasons only. Clipboard payloads and
 * previews never reach a log line.
 */

import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  clipboard,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen,
} from 'electron';
import { createCliptide } from '@cliptide/engine';
import { createElectronClipboardSource } from './clipboard/electron-source.js';
import { createDesktopApp } from './app.js';

/** Optional native change counter, wired in when the addon exists (not yet). */
function loadChangeCounter() {
  // Intentionally not implemented. See docs/M1-SPIKE.md for the scoped design.
  return null;
}

/**
 * Build the desktop application against real Electron.
 * Exported so a harness can construct it without triggering auto-start.
 */
export async function createCliptideDesktop({ dataDir = null } = {}) {
  const source = createElectronClipboardSource({
    clipboard,
    platform: process.platform,
    changeCounter: loadChangeCounter(),
  });

  const cliptide = await createCliptide({ ...(dataDir ? { dataDir } : {}), source });

  return createDesktopApp({
    electron: { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, ipcMain, screen },
    cliptide,
    platform: process.platform,
  });
}

// Only auto-start when Electron runs this file as the app entry point.
if (app?.whenReady) {
  // A second instance would fight the first for the global shortcut and the
  // history log, so the newcomer defers and summons the existing one.
  const isPrimary = app.requestSingleInstanceLock?.() ?? true;

  if (!isPrimary) {
    app.quit();
  } else {
    let desktop = null;

    app.on('second-instance', () => desktop?.summon());

    app.whenReady().then(async () => {
      desktop = await createCliptideDesktop();
      await desktop.start();
    });

    // The overlay hides rather than closes, and there is no main window, so
    // "all windows closed" must not be read as "the app is finished".
    app.on('window-all-closed', () => {});

    app.on('will-quit', async () => {
      await desktop?.stop();
    });
  }
}
