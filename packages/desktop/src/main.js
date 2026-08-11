/**
 * Cliptide desktop host — M1 spike scope.
 *
 * This is the Electron main process and nothing else: it wires the native
 * clipboard source into the engine and starts monitoring. There is no window,
 * no tray, and no global shortcut — those are later milestones, deliberately
 * absent so this file stays reviewable as a single question: does the pipeline
 * OS clipboard -> Electron -> engine actually work?
 *
 * LOGGING RULE: counts, kinds, and reasons only. A clipboard manager that
 * prints what you copied into a terminal or a log file has defeated itself.
 * Nothing here ever touches item.text or a payload.
 */

import { app, clipboard } from 'electron';
import { createCliptide } from '@cliptide/engine';
import { createElectronClipboardSource } from './clipboard/electron-source.js';

/** Optional native change counter, wired in when the addon exists (not yet). */
function loadChangeCounter() {
  // Intentionally not implemented. See docs/M1-SPIKE.md for the scoped design.
  // When it lands it is injected here and nothing else in the app changes.
  return null;
}

export async function startCliptideHost({ dataDir = null } = {}) {
  const source = createElectronClipboardSource({
    clipboard,
    platform: process.platform,
    changeCounter: loadChangeCounter(),
  });

  const cliptide = await createCliptide({ ...(dataDir ? { dataDir } : {}), source });

  cliptide.monitor.on('captured', ({ item }) => {
    console.log(`[cliptide] captured  kind=${item.kind} bytes=${item.bytes} sensitive=${item.sensitive}`);
  });
  cliptide.monitor.on('promoted', ({ item }) => {
    console.log(`[cliptide] promoted  copyCount=${item.copyCount}`);
  });
  cliptide.monitor.on('skipped', ({ reason }) => {
    console.log(`[cliptide] skipped   reason=${reason}`);
  });
  cliptide.monitor.on('error', ({ error, backoffMs }) => {
    console.error(`[cliptide] source error, backing off ${backoffMs}ms:`, error?.message);
  });

  await cliptide.start();

  console.log(
    `[cliptide] monitoring via ${source.name} ` +
      `(mechanism=${source.mechanism}, cheapToken=${source.cheapToken}) ` +
      `interval=${cliptide.monitor.pollIntervalMs}ms`,
  );

  return cliptide;
}

// Only auto-start when Electron runs this file as the app entry point.
if (app?.whenReady) {
  app.whenReady().then(async () => {
    const host = await startCliptideHost();
    app.on('before-quit', () => host.stop());
  });

  // No windows exist, so this must not be treated as "app finished".
  app.on('window-all-closed', () => {});
}
