#!/usr/bin/env electron
/**
 * M2 latency measurements — the Electron half.
 *
 * Measures what the engine-side script cannot: process start to app-ready,
 * overlay window construction, and the summon path (hidden window to visible
 * and focused). Requires a real Electron process.
 *
 *   xvfb-run -a electron packages/desktop/scripts/measure-overlay-electron.js
 *   npx electron packages/desktop/scripts/measure-overlay-electron.js
 *
 * Tray creation is attempted and reported separately: a headless Linux session
 * has no system tray host, so a failure there is an environment limitation,
 * not a product defect. It is recorded rather than hidden.
 */

import { app, BrowserWindow, Menu, Tray, clipboard, globalShortcut, ipcMain, nativeImage, screen } from 'electron';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCliptide } from '@cliptide/engine';
import { createElectronClipboardSource } from '../src/clipboard/electron-source.js';
import { createDesktopApp } from '../src/app.js';
import { IPC_CHANNELS } from '../src/ipc.js';

const PROCESS_START = Date.now();
const SUMMON_SAMPLES = 20;

const ms = (start) => +(Number(process.hrtime.bigint() - start) / 1e6).toFixed(3);
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

app.whenReady().then(async () => {
  const readyMs = Date.now() - PROCESS_START;
  const report = {
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    processStartToAppReadyMs: readyMs,
  };

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cliptide-perf-electron-'));
  let desktop = null;

  try {
    const source = createElectronClipboardSource({ clipboard, platform: process.platform });
    const cliptide = await createCliptide({ dataDir, source });

    // Seed enough history that the summon path does real work.
    for (let i = 0; i < 300; i++) {
      await cliptide.store.add({ kind: 'text', text: `measured history entry ${i} with filler` });
    }
    await cliptide.store.add({ kind: 'text', text: 'B'.repeat(2 * 1024 * 1024) });

    desktop = createDesktopApp({
      electron: { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, ipcMain, screen },
      cliptide,
      platform: process.platform,
      log: () => {},
    });

    const startAt = process.hrtime.bigint();
    try {
      await desktop.start();
      report.appStartMs = ms(startAt);
      report.trayCreated = desktop.tray?.tray != null;
    } catch (err) {
      // Most likely the tray on a headless session. Record and continue with
      // the window measurements, which are the latency-critical ones.
      report.appStartError = String(err?.message ?? err).slice(0, 200);
      report.trayCreated = false;
    }

    report.shortcutBound = desktop.shortcut?.accelerator ?? null;

    // Summon latency: hidden -> visible + focused, the path behind the keystroke.
    if (desktop.overlay) {
      const summonTimings = [];
      for (let i = 0; i < SUMMON_SAMPLES; i++) {
        desktop.overlay.hide();
        const at = process.hrtime.bigint();
        desktop.overlay.show();
        summonTimings.push(ms(at));
      }
      desktop.overlay.hide();
      report.summonMedianMs = +median(summonTimings).toFixed(3);
      report.summonMaxMs = +Math.max(...summonTimings).toFixed(3);
    }

    // IPC round trip: what the renderer waits on before painting rows.
    const listAt = process.hrtime.bigint();
    const items = await cliptide.history.list({ limit: 50 });
    report.historyListMs = ms(listAt);
    report.historyItems = items.length;
    report.storeSize = cliptide.store.size;
    report.channels = Object.values(IPC_CHANNELS);
    report.rssMb = +(process.memoryUsage().rss / 1024 / 1024).toFixed(1);
  } catch (err) {
    report.error = String(err?.stack ?? err).slice(0, 500);
  } finally {
    if (desktop?.started) await desktop.stop().catch(() => {});
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }

  console.log('\n=== ELECTRON-SIDE MEASUREMENTS ===');
  for (const [key, value] of Object.entries(report)) {
    if (key === 'channels') continue;
    console.log(`  ${key.padEnd(28)} ${Array.isArray(value) ? value.join(', ') : value}`);
  }
  console.log(`\n===CLIPTIDE_PERF_ELECTRON_JSON===\n${JSON.stringify(report, null, 2)}`);

  app.exit(report.error ? 1 : 0);
});

app.on('window-all-closed', () => {});
