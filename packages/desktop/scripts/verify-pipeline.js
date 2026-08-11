#!/usr/bin/env electron
/**
 * Live pipeline verification: OS clipboard -> Electron -> Cliptide engine.
 *
 * Runs inside a real Electron main process against the real system clipboard.
 * Every assertion below exercises the actual OS clipboard, not a fake — that
 * is the whole point of this script and the reason it cannot run under plain
 * Node.
 *
 *   xvfb-run -a electron scripts/verify-pipeline.js     (headless Linux)
 *   npx electron scripts/verify-pipeline.js             (macOS / Windows)
 *
 * Results are printed as JSON so runs from different machines can be compared.
 * Exit code is non-zero if any check fails.
 */

import { app, clipboard } from 'electron';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCliptide } from '@cliptide/engine';
import { createElectronClipboardSource } from '../src/clipboard/electron-source.js';

const POLL = 200;
const checks = [];

function check(name, passed, detail = '') {
  checks.push({ name, passed: !!passed, detail: String(detail) });
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const settle = (ms = POLL * 4) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cliptide-pipeline-'));
  const source = createElectronClipboardSource({ clipboard, platform: process.platform });

  const app_ = await createCliptide({ dataDir, source });
  app_.monitor.pollIntervalMs = POLL;
  await app_.start();

  console.log(`\nplatform=${process.platform} electron=${process.versions.electron}`);
  console.log(`source=${source.name} mechanism=${source.mechanism} cheapToken=${source.cheapToken}\n`);

  // --- 1. A real copy is captured -----------------------------------------
  const unique = `cliptide-pipeline-${Date.now()}`;
  clipboard.writeText(unique);
  await settle();
  const captured = app_.history.list().find((i) => i.text === unique);
  check('OS clipboard write is captured by the engine', !!captured, captured ? `id=${captured.id}` : 'not found');

  // --- 2. Re-copying identical content promotes, never duplicates ----------
  const before = app_.store.size;
  clipboard.writeText('cliptide-dup-probe');
  await settle();
  clipboard.writeText('cliptide-dup-probe');
  await settle();
  const dupItems = app_.history.list().filter((i) => i.text === 'cliptide-dup-probe');
  check('duplicate copy produces one item', dupItems.length === 1, `count=${dupItems.length}`);
  check('history grew by exactly one', app_.store.size === before + 1, `${before} -> ${app_.store.size}`);

  // --- 3. Search finds it --------------------------------------------------
  const found = app_.history.search('pipeline');
  check('search retrieves the captured item', found.length >= 1, `results=${found.length}`);

  // --- 4. Paste puts the payload back on the real clipboard ----------------
  if (captured) {
    clipboard.writeText('something-else-entirely');
    await settle(POLL * 2);
    await app_.history.use(captured.id);
    const onClipboard = clipboard.readText();
    check('history.use() writes the payload to the OS clipboard', onClipboard === unique, `read=${onClipboard.slice(0, 40)}`);
  }

  // --- 5. Concealed marker is honoured ------------------------------------
  const beforeConcealed = app_.store.size;
  const marker =
    process.platform === 'win32'
      ? 'ExcludeClipboardContentFromMonitorProcessing'
      : 'org.nspasteboard.ConcealedType';
  clipboard.writeText('cliptide-fake-password-value');
  try {
    clipboard.writeBuffer(marker, Buffer.from([1]));
  } catch (err) {
    console.log(`  (writeBuffer(${marker}) threw: ${err.message})`);
  }
  const markerVisible = (() => {
    try {
      return clipboard.has(marker);
    } catch {
      return false;
    }
  })();
  check(`clipboard.has('${marker}') sees the marker`, markerVisible);
  await settle();
  const leaked = app_.history.list().some((i) => i.text === 'cliptide-fake-password-value');
  check('concealed content is NOT recorded', !leaked, `store ${beforeConcealed} -> ${app_.store.size}`);

  // --- 6. Idle resource behaviour -----------------------------------------
  clipboard.writeText('cliptide-idle-baseline');
  await settle();
  const cpuBefore = process.cpuUsage();
  const idleMs = 5000;
  await settle(idleMs);
  const cpuAfter = process.cpuUsage(cpuBefore);
  const cpuPercent = ((cpuAfter.user + cpuAfter.system) / 1000 / idleMs) * 100;
  const ticks = Math.round(idleMs / POLL);
  check('idle CPU below 2% of one core', cpuPercent < 2, `${cpuPercent.toFixed(3)}% over ${ticks} polls`);

  // --- 7. Lifecycle --------------------------------------------------------
  const wasRunning = app_.monitor.running;
  await app_.stop();
  check('monitor starts and stops cleanly', wasRunning && !app_.monitor.running);

  const beforeStop = app_.store.size;
  clipboard.writeText(`after-stop-${Date.now()}`);
  await settle();
  check('nothing is captured after stop', app_.store.size === beforeStop, `size=${app_.store.size}`);

  const report = {
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    mechanism: source.mechanism,
    cheapToken: source.cheapToken,
    pollIntervalMs: POLL,
    idleCpuPercent: +cpuPercent.toFixed(3),
    monitorStats: app_.monitor.stats,
    checks,
    passed: checks.filter((c) => c.passed).length,
    failed: checks.filter((c) => !c.passed).length,
  };

  await fs.rm(dataDir, { recursive: true, force: true });
  console.log(`\n===CLIPTIDE_PIPELINE_JSON===\n${JSON.stringify(report, null, 2)}`);
  return report.failed === 0;
}

app.whenReady().then(async () => {
  let ok = false;
  try {
    ok = await run();
  } catch (err) {
    console.error('\nverification threw:', err?.stack ?? err);
  } finally {
    process.exitCode = ok ? 0 : 1;
    app.quit();
  }
});

app.on('window-all-closed', () => {});
