import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClipStore, HistoryService, SettingsStore } from '@cliptide/engine';
import { createIpcHandlers, IPC_CHANNELS } from '../src/ipc.js';
import { PAYLOAD_FIELDS } from '../src/overlay/view-model.js';
import { FakeClipboard } from './helpers/fake-clipboard.js';
import { createElectronClipboardSource } from '../src/clipboard/electron-source.js';

async function harness(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cliptide-ipc-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));

  const clipboard = new FakeClipboard();
  const source = createElectronClipboardSource({ clipboard, platform: 'darwin' });
  const store = await ClipStore.open({ dataDir });
  const settings = await SettingsStore.open(path.join(dataDir, 'settings.json'));
  const history = new HistoryService({ store, source, settings });
  t.after(() => store.close());

  let closed = 0;
  const handlers = createIpcHandlers({ history, onClose: () => (closed += 1) });

  return { store, history, clipboard, handlers, closedCount: () => closed };
}

const addText = (store, text) => store.add({ kind: 'text', text });

test('list returns recent history as view models', async (t) => {
  const { store, handlers } = await harness(t);
  await addText(store, 'first item');
  await addText(store, 'second item');

  const items = await handlers[IPC_CHANNELS.LIST]({});

  assert.equal(items.length, 2);
  assert.equal(items[0].preview, 'second item', 'newest use first');
  assert.ok(items[0].id && items[0].kindLabel && items[0].relativeAge);
});

test('view models carry no clipboard payload', async (t) => {
  const { store, handlers } = await harness(t);
  await addText(store, 'sensitive-looking payload contents');

  const [item] = await handlers[IPC_CHANNELS.LIST]({});

  for (const field of PAYLOAD_FIELDS) {
    assert.equal(field in item, false, `view model must not carry '${field}'`);
  }
  assert.deepEqual(
    Object.keys(item).sort(),
    ['bytes', 'id', 'kind', 'kindLabel', 'pinned', 'preview', 'relativeAge', 'sensitive', 'updatedAt'],
  );
});

test('a large payload does not travel to the renderer', async (t) => {
  const { store, handlers } = await harness(t);
  const big = 'X'.repeat(400 * 1024);
  await store.add({ kind: 'text', text: big });

  const [item] = await handlers[IPC_CHANNELS.LIST]({});
  const serialized = JSON.stringify(item);

  assert.ok(item.bytes >= 400 * 1024, 'size is reported');
  assert.ok(serialized.length < 2000, `view model stays small (${serialized.length} bytes)`);
});

test('search filters through the engine and an empty query restores recent history', async (t) => {
  const { store, handlers } = await harness(t);
  await addText(store, 'invoice for acme corp');
  await addText(store, 'unrelated shopping list');

  const found = await handlers[IPC_CHANNELS.SEARCH]({ query: 'invoice' });
  assert.equal(found.length, 1);
  assert.equal(found[0].preview, 'invoice for acme corp');

  for (const query of ['', '   ']) {
    const all = await handlers[IPC_CHANNELS.SEARCH]({ query });
    assert.equal(all.length, 2, `clearing the query (${JSON.stringify(query)}) restores history`);
  }
});

test('search results are view models with no payload', async (t) => {
  const { store, handlers } = await harness(t);
  await addText(store, 'searchable content here');

  const [result] = await handlers[IPC_CHANNELS.SEARCH]({ query: 'searchable' });

  for (const field of PAYLOAD_FIELDS) assert.equal(field in result, false, field);
});

test('use puts the payload on the clipboard and reports no content back', async (t) => {
  const { store, handlers, clipboard } = await harness(t);
  const { item } = await addText(store, 'paste me back');

  const result = await handlers[IPC_CHANNELS.USE]({ id: item.id });

  assert.deepEqual(result, { ok: true, kind: 'text' }, 'response carries no payload or preview');
  assert.equal(clipboard.readText(), 'paste me back');
});

test('use resolves a spilled blob so the whole payload is restored', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cliptide-ipc-blob-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));

  const clipboard = new FakeClipboard();
  const source = createElectronClipboardSource({ clipboard, platform: 'darwin' });
  const store = await ClipStore.open({ dataDir, inlineLimitBytes: 512 });
  t.after(() => store.close());
  const history = new HistoryService({ store, source });
  const handlers = createIpcHandlers({ history });

  const big = 'Z'.repeat(4096);
  const { item } = await store.add({ kind: 'text', text: big });

  assert.equal((await handlers[IPC_CHANNELS.USE]({ id: item.id })).ok, true);
  assert.equal(clipboard.readText(), big, 'not the truncated head');
});

test('use reports a missing or unknown id without throwing', async (t) => {
  const { handlers } = await harness(t);

  assert.deepEqual(await handlers[IPC_CHANNELS.USE]({}), { ok: false, reason: 'missing_id' });
  assert.deepEqual(await handlers[IPC_CHANNELS.USE]({ id: 42 }), { ok: false, reason: 'missing_id' });
  assert.deepEqual(await handlers[IPC_CHANNELS.USE]({ id: '0'.repeat(26) }), {
    ok: false,
    reason: 'not_found',
  });
});

test('use surfaces a storage failure instead of pasting a fragment', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cliptide-ipc-fail-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));

  const clipboard = new FakeClipboard();
  clipboard.setText('previous clipboard');
  const source = createElectronClipboardSource({ clipboard, platform: 'darwin' });
  const store = await ClipStore.open({ dataDir, inlineLimitBytes: 256 });
  t.after(() => store.close());
  const history = new HistoryService({ store, source });
  const handlers = createIpcHandlers({ history });

  const { item } = await store.add({ kind: 'text', text: 'Y'.repeat(2048) });
  await store.blobs.delete(item.blobRef);

  const result = await handlers[IPC_CHANNELS.USE]({ id: item.id });

  assert.equal(result.ok, false);
  assert.equal(clipboard.readText(), 'previous clipboard', 'clipboard untouched on failure');
});

test('pinned state is represented in the view model', async (t) => {
  const { store, history, handlers } = await harness(t);
  const { item } = await addText(store, 'pin me');
  await history.pin(item.id);

  const [view] = await handlers[IPC_CHANNELS.LIST]({});
  assert.equal(view.pinned, true);
});

test('sensitive items appear with the engine-masked preview, never the raw value', async (t) => {
  const { store, handlers } = await harness(t);
  await addText(store, 'export AWS_KEY=AKIAIOSFODNN7EXAMPLE');

  const [view] = await handlers[IPC_CHANNELS.LIST]({});

  assert.equal(view.sensitive, true, 'flagged so the UI can mark it');
  assert.ok(!view.preview.includes('AKIAIOSFODNN7EXAMPLE'), 'raw credential never reaches the UI');
  assert.ok(view.preview.includes('•'));
});

test('close asks the host to hide the overlay', async (t) => {
  const { handlers, closedCount } = await harness(t);

  assert.deepEqual(await handlers[IPC_CHANNELS.CLOSE](), { ok: true });
  assert.equal(closedCount(), 1);
});

test('the limit is honoured', async (t) => {
  const { store, handlers } = await harness(t);
  for (let i = 0; i < 10; i++) await addText(store, `item ${i}`);

  assert.equal((await handlers[IPC_CHANNELS.LIST]({ limit: 3 })).length, 3);
  assert.equal((await handlers[IPC_CHANNELS.SEARCH]({ query: 'item', limit: 2 })).length, 2);
});

test('constructing handlers without a history service fails loudly', () => {
  assert.throws(() => createIpcHandlers({}), TypeError);
});
