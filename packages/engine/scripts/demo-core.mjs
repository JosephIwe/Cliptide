#!/usr/bin/env node
/**
 * Cliptide engine demo.
 *
 * Runs the whole product loop headlessly — no desktop, no display server —
 * against an in-memory clipboard and a manually driven clock, into a throwaway
 * data directory. Nothing touches a real clipboard or a real history file.
 *
 *   node scripts/demo-core.mjs
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCliptide } from '../src/index.js';
import { MemoryClipboardSource } from '../src/capture/source.js';
import { createManualClock } from '../src/core/clock.js';

const POLL = 400;

function heading(title) {
  console.log(`\n${title}`);
  console.log('─'.repeat(title.length));
}

function row(item, extra = '', indent = '  ') {
  const flags = [item.pinned ? 'pinned' : null, item.sensitive ? 'secret' : null]
    .filter(Boolean)
    .join(', ');
  const tag = flags ? `  [${flags}]` : '';
  console.log(`${indent}${item.preview}${tag}${extra}`);
}

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cliptide-demo-'));
  const clock = createManualClock(new Date('2026-08-10T09:00:00').getTime());
  const source = new MemoryClipboardSource();

  const app = await createCliptide({
    dataDir,
    clock,
    source,
    platform: process.platform,
    env: {},
  });
  await app.start();

  /** Simulate the user copying something, then a poll tick observing it. */
  const copy = async (snapshot, gapMs = 90_000) => {
    source.set(snapshot);
    await clock.advance(POLL);
    clock.jump(gapMs);
  };

  heading('1. Copy → Remember');
  await copy({ kind: 'text', text: 'ssh deploy@prod.example.com' });
  await copy({ kind: 'text', text: 'https://example.com/standup-notes-2026-08-10' });
  await copy({ kind: 'text', text: 'git rebase --onto main feature/overlay' });
  await copy({ kind: 'text', text: 'invoice 4417 — Acme Corp — due 2026-09-01' });
  await copy({ kind: 'files', files: ['/Users/ada/Documents/contract.pdf'] });
  console.log(`  captured ${app.monitor.stats.captured} items`);

  heading('2. Duplicates are promoted, not duplicated');
  await copy({ kind: 'text', text: 'git rebase --onto main feature/overlay' });
  const promoted = app.history.list()[0];
  const copyEvents = app.monitor.stats.captured + app.monitor.stats.promoted;
  console.log(`  re-copying moved it back to the top, copyCount=${promoted.copyCount}`);
  console.log(`  ${copyEvents} copy events produced ${app.store.size} history items`);

  heading('3. Password managers are never recorded');
  const before = app.store.size;
  await copy({
    kind: 'text',
    text: 'correct-horse-battery-staple',
    markers: ['org.nspasteboard.ConcealedType'],
  });
  console.log(`  concealed content skipped; history still holds ${app.store.size} (was ${before})`);

  heading('4. Credentials are stored but never shown in full');
  await copy({ kind: 'text', text: 'export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE' });
  const secret = app.history.list()[0];
  row(secret);
  console.log(`  full value still retrievable: ${(await app.history.readPayload(secret.id)).slice(0, 24)}…`);

  heading('5. Summon → search');
  for (const query of ['invoice', 'rebase', 'notes']) {
    const results = app.history.search(query, { limit: 3 });
    console.log(`  "${query}" → ${results.length} result(s)`);
    for (const result of results) row(result.item, `  (score ${result.score.toFixed(1)})`, '    ');
  }

  heading('6. Pin a favourite');
  const [invoice] = app.history.search('invoice');
  await app.history.pin(invoice.item.id);
  for (const item of app.history.list({ pinnedOnly: true })) row(item);

  heading('7. Select → Paste');
  const [target] = app.history.search('rebase');
  clock.jump(3000);
  await app.history.use(target.item.id);
  console.log(`  clipboard now holds: ${source.current.text}`);
  await clock.advance(POLL * 2);
  console.log(`  our own paste was not recorded as a new copy: ${app.store.size} items`);

  heading('8. Ask in plain language (local, no AI provider)');
  for (const request of [
    'find the acme invoice',
    'what did I copy today',
    'show my pinned items',
    'the aws key',
    'how many items do I have',
  ]) {
    const response = await app.ask(request);
    const summary =
      response.plan.intent === 'stats'
        ? `${response.stats.items} items, ${response.stats.pinned} pinned`
        : `${response.results.length} result(s)`;
    console.log(`  "${request}"`);
    console.log(`    → ${response.plan.intent}: ${summary}`);
    console.log(`      ${response.explanation}`);
  }

  heading('9. Retention expires secrets early and never touches pins');
  console.log(`  before: ${app.store.size} items`);
  clock.jump(20 * 60_000);
  const report = await app.history.applyRetention({ secretRetentionMinutes: 15 });
  for (const expired of report.expired) console.log(`  expired ${expired.id} (${expired.reason})`);
  console.log(`  after: ${app.store.size} items, pinned survivors intact`);

  heading('10. Durability');
  const stats = await app.history.stats();
  console.log(`  log records: ${stats.logRecords}, log bytes: ${stats.logBytes}`);
  console.log(`  corrupt lines recovered: ${stats.recovery.corruptLines.length}`);
  await app.stop();

  const reopened = await createCliptide({ dataDir, clock, source, platform: process.platform, env: {} });
  console.log(`  after restart: ${reopened.history.list().length} items still present`);
  for (const item of reopened.history.list()) row(item);
  await reopened.stop();

  await fs.rm(dataDir, { recursive: true, force: true });
  console.log('\nDemo complete. Temporary data directory removed.\n');
}

main().catch((err) => {
  console.error('demo failed:', err);
  process.exitCode = 1;
});
