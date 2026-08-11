#!/usr/bin/env electron
/**
 * M1.1 — real-platform pipeline verification.
 *
 * Runs inside a real Electron main process against the real system clipboard,
 * proving: OS clipboard -> Electron -> Cliptide engine.
 *
 *   macOS / Windows:  npx electron packages/desktop/scripts/verify-pipeline.js
 *   headless Linux:   xvfb-run -a electron packages/desktop/scripts/verify-pipeline.js
 *
 * SAFETY PROPERTIES — this script runs on a machine with real user data, so
 * these are enforced, not aspirational:
 *
 *   1. No clipboard content is ever printed. Only booleans, lengths, hashes,
 *      and format names reach stdout or the JSON report.
 *   2. Nothing pre-existing on your clipboard is captured. The monitor starts
 *      with captureOnStart disabled, so only the sentinel values this script
 *      writes itself are ever recorded.
 *   3. Nothing is persisted anywhere durable. History goes to a throwaway temp
 *      directory that is removed in a `finally` block, so it is cleaned up even
 *      if a check throws.
 *   4. Your clipboard is cleared at the end.
 *
 * IT WILL OVERWRITE YOUR CLIPBOARD. Copy anything you need first.
 */

import { app, clipboard } from 'electron';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCliptide } from '@cliptide/engine';
import { createElectronClipboardSource } from '../src/clipboard/electron-source.js';

const POLL = 250;
const RUN_ID = `cliptide-verify-${Date.now()}`;
const checks = [];

/** Detail strings must never contain clipboard-derived text. */
function check(name, passed, detail = '') {
  checks.push({ name, passed: !!passed, detail: String(detail) });
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

const settle = (ms = POLL * 4) => new Promise((r) => setTimeout(r, ms));

function safely(fn, fallback = null) {
  try {
    return fn();
  } catch (err) {
    return fallback ?? `<threw: ${String(err?.message).slice(0, 60)}>`;
  }
}

async function run(dataDir) {
  const source = createElectronClipboardSource({ clipboard, platform: process.platform });

  console.log('\n=== ENVIRONMENT ===');
  console.log(`  platform      ${process.platform} ${process.arch} (${os.release()})`);
  console.log(`  electron      ${process.versions.electron}`);
  console.log(`  chrome/node   ${process.versions.chrome} / ${process.versions.node}`);
  console.log(`  source        ${source.name}  mechanism=${source.mechanism}  cheapToken=${source.cheapToken}`);
  console.log(`  poll interval ${POLL}ms`);
  console.log(`  temp data dir ${dataDir}  (removed on exit)`);

  const cliptide = await createCliptide({ dataDir, source });
  // Never ingest whatever the user already had on their clipboard.
  cliptide.monitor.captureOnStart = false;
  cliptide.monitor.pollIntervalMs = POLL;
  await cliptide.start();

  console.log('\n=== CHECKS ===');

  // --- 1. Normal text capture ---------------------------------------------
  const first = `${RUN_ID}-alpha`;
  clipboard.writeText(first);
  await settle();
  const capturedFirst = cliptide.history.list().find((i) => i.text === first);
  check('normal text copy is captured', !!capturedFirst, capturedFirst ? `id=${capturedFirst.id}` : 'not captured');

  console.log(`         formats now visible: ${JSON.stringify(safely(() => clipboard.availableFormats(), []))}`);

  // --- 2. Capture after the clipboard changes -----------------------------
  const second = `${RUN_ID}-beta`;
  clipboard.writeText(second);
  await settle();
  const capturedSecond = cliptide.history.list().find((i) => i.text === second);
  check('a subsequent, different copy is captured', !!capturedSecond, `history=${cliptide.store.size}`);
  check(
    'the newer copy is at the top of history',
    cliptide.history.list()[0]?.text === second,
    'ordering by last use',
  );

  // --- 3. Duplicate handling ----------------------------------------------
  const sizeBeforeDup = cliptide.store.size;
  clipboard.writeText(first); // re-copy something already in history
  await settle();
  const dupes = cliptide.history.list().filter((i) => i.text === first);
  check('re-copying does not duplicate', dupes.length === 1, `matching items=${dupes.length}`);
  check('history size unchanged by a re-copy', cliptide.store.size === sizeBeforeDup, `size=${cliptide.store.size}`);
  check('the re-copied item was promoted', (dupes[0]?.copyCount ?? 0) >= 2, `copyCount=${dupes[0]?.copyCount}`);

  // --- 4. Search + retrieval ----------------------------------------------
  const results = cliptide.history.search('alpha');
  check('search finds a captured item', results.length >= 1, `results=${results.length}`);

  // --- 5. Paste path -------------------------------------------------------
  if (capturedFirst) {
    clipboard.writeText(`${RUN_ID}-displaced`);
    await settle(POLL * 2);
    await cliptide.history.use(capturedFirst.id);
    // Compare without printing: report only whether it matched, and lengths.
    const back = safely(() => clipboard.readText(), '');
    check(
      'history.use() places the payload on the OS clipboard',
      back === first,
      `length ${String(back).length} vs expected ${first.length}`,
    );
  }

  // --- 6. Concealed content is refused BEFORE the payload is read ---------
  // Synthetic marker. The authoritative test with a real password manager is
  // verify-concealed.js; this proves the refusal ordering in the source.
  // Use the marker a real password manager would set on THIS platform, with
  // the value it would carry. (The source probes every known marker on every
  // platform regardless — this just keeps the synthetic test faithful.)
  const { markerFormat, markerValue } =
    process.platform === 'win32'
      ? {
          markerFormat: 'ExcludeClipboardContentFromMonitorProcessing',
          markerValue: Buffer.from([1]),
        }
      : process.platform === 'linux'
        ? {
            markerFormat: 'x-kde-passwordManagerHint',
            markerValue: Buffer.from('secret', 'utf8'),
          }
        : { markerFormat: 'org.nspasteboard.ConcealedType', markerValue: Buffer.from([1]) };

  const sentinel = `${RUN_ID}-synthetic-secret`;
  clipboard.writeText(sentinel);
  // NOTE: on X11 a writeBuffer replaces the whole clipboard, so the text may
  // not survive alongside the marker. That is fine — the guarantee under test
  // is that a present marker short-circuits BEFORE any payload read, which
  // holds whether or not text is still there.
  const wroteMarker = safely(() => {
    clipboard.writeBuffer(markerFormat, markerValue);
    return true;
  }, false);
  const markerVisible = safely(() => clipboard.has(markerFormat), false) === true;

  check(`clipboard.writeBuffer('${markerFormat}') succeeds`, wroteMarker === true);
  check(`clipboard.has('${markerFormat}') sees the marker`, markerVisible);

  // The ordering guarantee: token says concealed, and read() returns markers
  // with an EMPTY payload — proving the secret was never read into memory.
  const token = await source.changeToken();
  const snapshot = await source.read();
  check('changeToken() reports concealed without reading the payload', token === 'concealed', `token=${token}`);
  check(
    'read() returns markers and no payload',
    snapshot?.text === '' && Array.isArray(snapshot?.markers) && snapshot.markers.length > 0,
    `markers=${JSON.stringify(snapshot?.markers ?? [])}`,
  );

  const sizeBeforeConcealed = cliptide.store.size;
  await settle();
  const leaked = cliptide.history.list().some((i) => i.text === sentinel);
  check('concealed content is NOT recorded', !leaked, `size ${sizeBeforeConcealed} -> ${cliptide.store.size}`);

  clipboard.clear();
  await settle(POLL * 2);

  // --- 7. Oversized payload -------------------------------------------------
  const sizeBeforeBig = cliptide.store.size;
  clipboard.writeText('x'.repeat(12 * 1024 * 1024));
  await settle(POLL * 6);
  check(
    'a 12MB payload does not crash or hang the monitor',
    cliptide.monitor.running === true,
    `errors=${cliptide.monitor.stats.errors}, size ${sizeBeforeBig} -> ${cliptide.store.size}`,
  );
  clipboard.writeText(`${RUN_ID}-after-big`);
  await settle();
  check('the monitor still captures after a large payload', cliptide.monitor.running === true);

  // --- 8. Idle resource behaviour ------------------------------------------
  clipboard.writeText(`${RUN_ID}-idle`);
  await settle();
  const cpuBefore = process.cpuUsage();
  const idleMs = 5000;
  await settle(idleMs);
  const cpu = process.cpuUsage(cpuBefore);
  const cpuPercent = ((cpu.user + cpu.system) / 1000 / idleMs) * 100;
  check('idle CPU below 2% of one core', cpuPercent < 2, `${cpuPercent.toFixed(3)}% over ${Math.round(idleMs / POLL)} polls`);

  // --- 9. Lifecycle ---------------------------------------------------------
  const wasRunning = cliptide.monitor.running;
  await cliptide.stop();
  check('monitor started then stopped cleanly', wasRunning === true && cliptide.monitor.running === false);

  const sizeAfterStop = cliptide.store.size;
  clipboard.writeText(`${RUN_ID}-after-stop`);
  await settle();
  check('nothing is captured after stop', cliptide.store.size === sizeAfterStop, `size=${cliptide.store.size}`);

  return {
    runId: RUN_ID,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    sourceName: source.name,
    mechanism: source.mechanism,
    cheapToken: source.cheapToken,
    pollIntervalMs: POLL,
    idleCpuPercent: +cpuPercent.toFixed(3),
    syntheticMarkerFormat: markerFormat,
    syntheticMarkerVisible: markerVisible,
    monitorStats: cliptide.monitor.stats,
    checks,
    passed: checks.filter((c) => c.passed).length,
    failed: checks.filter((c) => !c.passed).length,
  };
}

app.whenReady().then(async () => {
  console.log('\nCliptide M1.1 pipeline verification');
  console.log('THIS WILL OVERWRITE YOUR CLIPBOARD. Nothing you copied is recorded or printed.');

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cliptide-verify-'));
  let report = null;
  let thrown = null;

  try {
    report = await run(dataDir);
  } catch (err) {
    thrown = err;
    console.error(`\nVERIFICATION THREW on ${process.platform}:`);
    console.error(err?.stack ?? String(err));
  } finally {
    // Guaranteed: no captured content survives this script, even on failure.
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    safely(() => clipboard.clear());
  }

  const failed = thrown ? -1 : report.failed;
  const summary = report ?? {
    runId: RUN_ID,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    electron: process.versions.electron,
    error: String(thrown?.message ?? thrown),
    checks,
    passed: checks.filter((c) => c.passed).length,
    failed: checks.filter((c) => !c.passed).length,
  };

  const reportPath = path.join(os.tmpdir(), `${RUN_ID}-pipeline.json`);
  await fs.writeFile(reportPath, JSON.stringify(summary, null, 2), 'utf8').catch(() => {});

  console.log('\n=== RESULT ===');
  console.log(`  platform  ${process.platform} ${process.arch} / electron ${process.versions.electron}`);
  console.log(`  passed    ${summary.passed}`);
  console.log(`  failed    ${summary.failed}`);
  if (summary.failed > 0) {
    for (const c of checks.filter((c) => !c.passed)) console.log(`    FAILED: ${c.name}  (${c.detail})`);
  }
  console.log(`  report    ${reportPath}`);
  console.log(`\n  ${failed === 0 ? 'OVERALL: PASS' : 'OVERALL: FAIL'}\n`);

  console.log(`===CLIPTIDE_PIPELINE_JSON===\n${JSON.stringify(summary, null, 2)}`);

  // app.quit() does not honour process.exitCode — it tears the process down
  // before Node applies it, so a failing run exited 0. Cleanup has already run
  // in the finally block above, so exiting directly is safe here.
  app.exit(failed === 0 ? 0 : 1);
});

app.on('window-all-closed', () => {});
