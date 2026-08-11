#!/usr/bin/env electron
/**
 * Cross-process concealed-marker verification (M1, CI).
 *
 * Proves the chain that matters:
 *
 *   external native process -> real OS clipboard -> Electron -> Cliptide refusal
 *
 * The Linux result this supersedes only ever proved that a single Electron
 * process could read back a pasteboard type it had written itself. That leaves
 * the real question open: can Electron see a marker placed by a *different*
 * application through the platform's own clipboard API? A password manager is a
 * different application, so that is the case that counts.
 *
 * Here the marker is written by a separate OS process — a compiled Swift binary
 * on macOS, a PowerShell/Win32 script on Windows — using the genuine platform
 * API. Electron never writes the marker. The writer's pid is reported so the
 * separation is auditable rather than asserted.
 *
 * WHAT THIS DOES NOT PROVE — stated here because it is easy to overclaim:
 * that 1Password, Bitwarden, Keeper, or Apple Passwords set THIS marker. They
 * may use a different type, or none. That remains a manual test on a real
 * desktop with a real manager, and this script is not a substitute for it.
 *
 * PRIVACY: the payload is a fixed synthetic string defined in the helper. It is
 * never printed, never stored, and never written to the report.
 *
 *   macOS:   npx electron packages/desktop/scripts/verify-cross-process.js
 *   Windows: npx electron packages/desktop/scripts/verify-cross-process.js
 */

import { app, clipboard } from 'electron';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClipStore } from '@cliptide/engine';
import { createElectronClipboardSource } from '../src/clipboard/electron-source.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const checks = [];

function check(name, passed, detail = '') {
  checks.push({ name, passed: !!passed, detail: String(detail) });
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

/**
 * Run the platform's native marker writer as a separate process.
 * @returns {{ok: boolean, code: number|null, fields: object, reason: string}}
 */
function runNativeWriter(tmpDir) {
  if (process.platform === 'darwin') {
    const source = path.join(HERE, 'platform', 'write-concealed-macos.swift');
    const binary = path.join(tmpDir, 'cliptide-concealed-writer');

    const build = spawnSync('swiftc', ['-O', '-o', binary, source], { encoding: 'utf8' });
    if (build.status !== 0) {
      return { ok: false, code: build.status, fields: {}, reason: `swiftc failed: ${String(build.stderr).slice(0, 300)}` };
    }
    const run = spawnSync(binary, [], { encoding: 'utf8' });
    return { ok: run.status === 0, code: run.status, fields: parseFields(run.stdout), reason: String(run.stderr).slice(0, 300) };
  }

  if (process.platform === 'win32') {
    const script = path.join(HERE, 'platform', 'write-concealed-windows.ps1');
    const run = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-File', script],
      { encoding: 'utf8' },
    );
    return { ok: run.status === 0, code: run.status, fields: parseFields(run.stdout), reason: String(run.stderr).slice(0, 300) };
  }

  return { ok: false, code: null, fields: {}, reason: `no native writer for platform '${process.platform}'` };
}

/** Helpers emit `key=value` lines. None of them carry the payload. */
function parseFields(stdout) {
  const fields = {};
  for (const line of String(stdout).split(/\r?\n/)) {
    const match = line.match(/^([a-z_]+)=(.*)$/);
    if (match) fields[match[1]] = match[2];
  }
  return fields;
}

async function run(tmpDir) {
  console.log('\n=== ENVIRONMENT ===');
  console.log(`  platform      ${process.platform} ${process.arch} (${os.release()})`);
  console.log(`  electron      ${process.versions.electron}`);
  console.log(`  electron pid  ${process.pid}`);

  const expectedMarker =
    process.platform === 'win32'
      ? 'ExcludeClipboardContentFromMonitorProcessing'
      : 'org.nspasteboard.ConcealedType';

  console.log('\n=== CHECKS ===');

  // Establish a clean, non-concealed baseline so a stale marker cannot make
  // the test pass on its own.
  clipboard.writeText('cliptide-cross-process-baseline');
  const source = createElectronClipboardSource({ clipboard, platform: process.platform });
  const baselineToken = await source.changeToken();
  check('baseline clipboard is not concealed', baselineToken !== 'concealed', `token=${baselineToken}`);

  // --- The external process writes the marker -----------------------------
  const writer = runNativeWriter(tmpDir);
  check(
    'native writer process ran successfully',
    writer.ok,
    writer.ok ? `exit=${writer.code}` : `exit=${writer.code} ${writer.reason}`,
  );
  if (!writer.ok) return { expectedMarker, writer, aborted: true };

  const writerPid = writer.fields.writer_pid;
  check(
    'marker was written by a DIFFERENT process than Electron',
    writerPid && String(writerPid) !== String(process.pid),
    `writer_pid=${writerPid} electron_pid=${process.pid}`,
  );

  // --- Can Electron see it? ------------------------------------------------
  let seen = false;
  try {
    seen = clipboard.has(expectedMarker) === true;
  } catch (err) {
    seen = false;
  }
  check(`clipboard.has('${expectedMarker}') sees the external marker`, seen);

  // --- Does the source refuse before reading the payload? ------------------
  const token = await source.changeToken();
  const snapshot = await source.read();

  check('changeToken() reports concealed', token === 'concealed', `token=${token}`);
  check(
    'read() returns markers and an empty payload',
    snapshot?.text === '' && Array.isArray(snapshot?.markers) && snapshot.markers.length > 0,
    `markers=${JSON.stringify(snapshot?.markers ?? [])}`,
  );

  // --- Does the engine actually refuse to store it? ------------------------
  const store = await ClipStore.open({ dataDir: path.join(tmpDir, 'store') });
  const result = await store.add(snapshot);
  check('the engine refuses to store it', result.stored === false, `reason=${result.reason}`);
  check('history is empty afterwards', store.size === 0, `size=${store.size}`);
  await store.close();

  return {
    expectedMarker,
    writer: { code: writer.code, fields: writer.fields },
    electronSawMarker: seen,
    token,
    markers: snapshot?.markers ?? [],
    aborted: false,
  };
}

app.whenReady().then(async () => {
  console.log('\nCliptide M1 — cross-process concealed-marker verification');
  console.log('An external native process writes the marker; Electron only reads.');

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cliptide-xproc-'));
  let details = null;
  let thrown = null;

  try {
    details = await run(tmpDir);
  } catch (err) {
    thrown = err;
    console.error(`\nVERIFICATION THREW on ${process.platform}:`);
    console.error(err?.stack ?? String(err));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    try {
      clipboard.clear();
    } catch {
      /* nothing to clean */
    }
  }

  const failed = thrown ? -1 : checks.filter((c) => !c.passed).length;
  const report = {
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    electron: process.versions.electron,
    electronPid: process.pid,
    ...(details ?? {}),
    error: thrown ? String(thrown?.message ?? thrown) : undefined,
    checks,
    passed: checks.filter((c) => c.passed).length,
    failed: checks.filter((c) => !c.passed).length,
    scopeLimit:
      'Proves an external native process can set a marker Electron detects. Does NOT prove any specific password manager sets this marker.',
  };

  console.log('\n=== RESULT ===');
  console.log(`  platform  ${process.platform} ${process.arch} / electron ${process.versions.electron}`);
  console.log(`  passed    ${report.passed}`);
  console.log(`  failed    ${report.failed}`);
  for (const c of checks.filter((c) => !c.passed)) console.log(`    FAILED: ${c.name}  (${c.detail})`);
  console.log(`\n  ${failed === 0 ? 'OVERALL: PASS' : 'OVERALL: FAIL'}\n`);
  console.log(`===CLIPTIDE_XPROC_JSON===\n${JSON.stringify(report, null, 2)}`);

  // app.quit() discards process.exitCode; app.exit() sets it directly.
  app.exit(failed === 0 ? 0 : 1);
});

app.on('window-all-closed', () => {});
