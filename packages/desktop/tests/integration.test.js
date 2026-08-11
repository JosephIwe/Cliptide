/**
 * The native source driven by the real engine monitor and store.
 *
 * These are category-A tests: they run in any environment because the Electron
 * clipboard is replaced by a fake shaped from measured Electron behaviour. They
 * cover the pipeline wiring — duplicate handling, lifecycle, concealed content,
 * pause/resume — leaving only genuinely OS-specific behaviour for the real
 * machines.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClipStore, ClipboardMonitor } from '@cliptide/engine';
import { createElectronClipboardSource } from '../src/clipboard/electron-source.js';
import { FakeClipboard, FakeNativeImage } from './helpers/fake-clipboard.js';

const POLL = 400;

async function harness(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cliptide-desktop-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));

  const clipboard = new FakeClipboard();
  const source = createElectronClipboardSource({ clipboard, platform: 'darwin', ...options });
  const store = await ClipStore.open({ dataDir });
  const monitor = new ClipboardMonitor({
    source,
    store,
    pollIntervalMs: POLL,
    captureOnStart: false,
  });

  const events = [];
  for (const name of ['captured', 'promoted', 'skipped', 'error']) {
    monitor.on(name, (payload) => events.push({ name, payload }));
  }

  t.after(async () => {
    monitor.stop();
    await store.close();
  });

  return { clipboard, source, store, monitor, events };
}

/** Drive one poll cycle explicitly rather than waiting on wall-clock timers. */
async function tick(monitor, source, store) {
  const token = await source.changeToken();
  if (token === monitor._lastSeen) return null;
  monitor._lastSeen = token;
  const snapshot = await source.read();
  if (!snapshot) return null;
  return store.add(snapshot);
}

test('a copy flows through the source into the store', async (t) => {
  const { clipboard, source, store, monitor } = await harness(t);

  clipboard.setText('captured through the native source');
  const result = await tick(monitor, source, store);

  assert.equal(result.stored, true);
  assert.equal(store.size, 1);
  assert.equal(store.list()[0].text, 'captured through the native source');
});

test('re-copying identical content promotes instead of duplicating', async (t) => {
  const { clipboard, source, store, monitor } = await harness(t);

  clipboard.setText('same content');
  const first = await tick(monitor, source, store);
  clipboard.setText('other');
  await tick(monitor, source, store);
  clipboard.setText('same content');
  const again = await tick(monitor, source, store);

  assert.equal(store.size, 2, 'two distinct items, not three');
  assert.equal(again.stored, true);
  assert.equal(again.created, false, 'the store recognized the content and promoted it');
  assert.equal(again.item.id, first.item.id, 'identity preserved');
  assert.equal(again.item.copyCount, 2);
});

test('consecutively re-copying identical content is deduped before any read', async (t) => {
  const { clipboard, source, store, monitor } = await harness(t);

  clipboard.setText('unchanged');
  await tick(monitor, source, store);

  const readsBefore = clipboard.calls.readText;
  const repeat = await tick(monitor, source, store);

  assert.equal(repeat, null, 'the token matched, so no store write happened');
  assert.equal(clipboard.calls.readText, readsBefore + 1, 'only the token read, no payload read');
});

test('distinct copies each produce an item', async (t) => {
  const { clipboard, source, store, monitor } = await harness(t);

  for (const text of ['one', 'two', 'three']) {
    clipboard.setText(text);
    await tick(monitor, source, store);
  }

  assert.equal(store.size, 3);
});

test('concealed content never reaches the store', async (t) => {
  const { clipboard, source, store, monitor } = await harness(t);

  clipboard.setConcealed('my-master-password', 'org.nspasteboard.ConcealedType');
  const result = await tick(monitor, source, store);

  assert.equal(result.stored, false);
  assert.equal(result.reason, 'concealed');
  assert.equal(store.size, 0);

  const { records } = await store.log.readAll();
  assert.equal(records.length, 0, 'nothing about it reached the durable log');
});

test('an image flows through as a blob-backed item', async (t) => {
  const { clipboard, source, store, monitor } = await harness(t);

  clipboard.setImage(new FakeNativeImage({ width: 4, height: 4, png: Buffer.alloc(256, 1) }));
  const result = await tick(monitor, source, store);

  assert.equal(result.stored, true);
  assert.equal(result.item.kind, 'image');
  assert.equal(result.item.bytes, 256);
  assert.ok(result.item.blobRef);
});

test('the monitor starts, captures on its own timer, and stops', async (t) => {
  const { clipboard, monitor, store, events } = await harness(t);

  await monitor.start();
  assert.equal(monitor.running, true);

  clipboard.setText('captured by the running monitor');
  await new Promise((r) => setTimeout(r, POLL * 3));

  assert.equal(store.size, 1, 'the poll loop captured it without manual ticking');
  assert.equal(events.filter((e) => e.name === 'captured').length, 1);

  monitor.stop();
  assert.equal(monitor.running, false);

  clipboard.setText('after stop');
  await new Promise((r) => setTimeout(r, POLL * 3));
  assert.equal(store.size, 1, 'nothing captured after stop');
});

test('pause stops recording but resume does not replay the backlog', async (t) => {
  const { clipboard, monitor, store } = await harness(t);
  await monitor.start();

  monitor.pause();
  clipboard.setText('copied while paused');
  await new Promise((r) => setTimeout(r, POLL * 3));
  assert.equal(store.size, 0);

  monitor.resume();
  await new Promise((r) => setTimeout(r, POLL * 3));
  assert.equal(store.size, 0, 'the paused copy is not retroactively captured');

  clipboard.setText('copied after resume');
  await new Promise((r) => setTimeout(r, POLL * 3));
  assert.equal(store.size, 1);
});

test('a throwing clipboard backs off instead of killing the loop', async (t) => {
  const { clipboard, monitor, store, events } = await harness(t);
  await monitor.start();

  clipboard.throwOnHas.add('org.nspasteboard.ConcealedType');
  const originalReadText = clipboard.readText.bind(clipboard);
  let failures = 2;
  clipboard.readText = () => {
    if (failures-- > 0) throw new Error('clipboard locked by another process');
    return originalReadText();
  };

  await new Promise((r) => setTimeout(r, POLL * 3));
  assert.ok(events.some((e) => e.name === 'error'), 'the failure was surfaced');
  assert.equal(monitor.running, true, 'the monitor survived');

  clipboard.setText('recovered');
  await new Promise((r) => setTimeout(r, POLL * 12));
  assert.equal(store.size, 1, 'and recovered on its own');
});

test('a native change counter drives the same pipeline with no content reads', async (t) => {
  let counter = 1;
  const { clipboard, source, store, monitor } = await harness(t, {
    changeCounter: () => counter,
  });

  clipboard.setText('counter driven');
  const readsBeforeToken = clipboard.calls.readText;
  await tick(monitor, source, store);

  assert.equal(store.size, 1);
  assert.equal(store.list()[0].text, 'counter driven');
  assert.ok(clipboard.calls.readText > readsBeforeToken, 'content read once, on capture');

  // Same counter value: no change, no work.
  const before = clipboard.calls.readText;
  await tick(monitor, source, store);
  assert.equal(clipboard.calls.readText, before, 'a stable counter costs zero reads');

  counter = 2;
  clipboard.setText('next value');
  await tick(monitor, source, store);
  assert.equal(store.size, 2);
});
