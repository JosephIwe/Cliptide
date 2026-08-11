#!/usr/bin/env node
/**
 * M2 latency measurements — the engine-side half, runnable anywhere.
 *
 * Measures the work that happens between a keystroke and rows appearing:
 * history read, view-model projection, and search. The Electron-side half
 * (process start, shortcut to window visible) is measured by
 * `measure-overlay-electron.js`, which needs a real Electron process.
 *
 * Measured, not guessed. Numbers land in docs/M2-OVERLAY.md.
 *
 *   node packages/desktop/scripts/measure-overlay.mjs
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClipStore, HistoryService } from '@cliptide/engine';
import { createIpcHandlers, IPC_CHANNELS } from '../src/ipc.js';

const SIZES = [100, 500, 2000];
const SAMPLES = 25;

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function time(label, fn, samples = SAMPLES) {
  await fn(); // warm-up
  const durations = [];
  for (let i = 0; i < samples; i++) {
    const started = process.hrtime.bigint();
    await fn();
    durations.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  return {
    label,
    samples,
    medianMs: +percentile(durations, 50).toFixed(3),
    p95Ms: +percentile(durations, 95).toFixed(3),
    maxMs: +Math.max(...durations).toFixed(3),
  };
}

async function measureAt(count) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cliptide-perf-'));
  const store = await ClipStore.open({ dataDir });
  const history = new HistoryService({ store });
  const handlers = createIpcHandlers({ history });

  for (let i = 0; i < count; i++) {
    await store.add({ kind: 'text', text: `history entry ${i} — some representative filler text` });
  }
  // A large item and an image, so the numbers reflect a realistic mix rather
  // than a uniform corpus of small strings.
  await store.add({ kind: 'text', text: 'L'.repeat(2 * 1024 * 1024) });
  await store.add({ kind: 'image', bytes: Buffer.alloc(512 * 1024, 7), format: 'image/png' });

  const results = [
    await time('history render (list + project 50)', () => handlers[IPC_CHANNELS.LIST]({ limit: 50 })),
    await time('search "entry"', () => handlers[IPC_CHANNELS.SEARCH]({ query: 'entry', limit: 50 })),
    await time('search miss', () => handlers[IPC_CHANNELS.SEARCH]({ query: 'zzzznomatch', limit: 50 })),
    await time('clear query (restore recent)', () => handlers[IPC_CHANNELS.SEARCH]({ query: '', limit: 50 })),
  ];

  const openStarted = process.hrtime.bigint();
  const reopened = await ClipStore.open({ dataDir });
  const openMs = Number(process.hrtime.bigint() - openStarted) / 1e6;
  await reopened.close();

  // Payload weight actually shipped to the renderer for one screenful.
  const projected = await handlers[IPC_CHANNELS.LIST]({ limit: 50 });
  const transferBytes = Buffer.byteLength(JSON.stringify(projected), 'utf8');

  await store.close();
  await fs.rm(dataDir, { recursive: true, force: true });

  return { items: count + 2, results, storeOpenMs: +openMs.toFixed(3), transferBytes };
}

const report = { node: process.version, platform: process.platform, arch: process.arch, sizes: [] };

for (const size of SIZES) {
  const measured = await measureAt(size);
  report.sizes.push(measured);

  console.log(`\n=== ${measured.items} items ===`);
  console.log(`  store open (cold replay)          ${measured.storeOpenMs} ms`);
  for (const r of measured.results) {
    console.log(`  ${r.label.padEnd(34)} median ${String(r.medianMs).padStart(7)} ms   p95 ${String(r.p95Ms).padStart(7)} ms`);
  }
  console.log(`  renderer transfer for 50 rows     ${measured.transferBytes} bytes`);
}

console.log(`\n===CLIPTIDE_PERF_JSON===\n${JSON.stringify(report, null, 2)}`);
