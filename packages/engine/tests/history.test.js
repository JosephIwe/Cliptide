import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { HistoryService } from '../src/history/index.js';
import { ClipStore } from '../src/storage/store.js';
import { ClipboardMonitor } from '../src/capture/monitor.js';
import { MemoryClipboardSource } from '../src/capture/source.js';
import { SettingsStore } from '../src/settings/store.js';
import { createManualClock } from '../src/core/clock.js';
import { createIdFactory } from '../src/core/ids.js';
import { tempDir, textSnapshot } from './helpers/tempdir.js';

const POLL = 400;

async function harness(t, options = {}) {
  const dataDir = await tempDir(t);
  const clock = createManualClock();
  const store = await ClipStore.open({
    dataDir,
    clock,
    idFactory: createIdFactory({ clock }),
    ...options.store,
  });
  const source = new MemoryClipboardSource();
  const monitor = new ClipboardMonitor({
    source,
    store,
    clock,
    pollIntervalMs: POLL,
    captureOnStart: false,
  });
  const settings = await SettingsStore.open(path.join(dataDir, 'settings.json'));
  const history = new HistoryService({ store, source, monitor, settings, clock });

  t.after(async () => {
    monitor.stop();
    await store.close();
  });

  return { history, store, source, monitor, settings, clock };
}

/** Copy a series of values through the store, advancing time between each. */
async function seed(store, clock, values) {
  const created = [];
  for (const value of values) {
    created.push((await store.add(textSnapshot(value))).item);
    clock.jump(1000);
  }
  return created;
}

test('the service requires a store', () => {
  assert.throws(() => new HistoryService({}), { kind: 'validation' });
});

test('list returns history newest-use first', async (t) => {
  const { history, store, clock } = await harness(t);
  await seed(store, clock, ['first', 'second', 'third']);

  assert.deepEqual(
    history.list().map((item) => item.text),
    ['third', 'second', 'first'],
  );
});

test('search ranks and respects the configured result limit', async (t) => {
  const { history, store, settings, clock } = await harness(t);
  await seed(store, clock, ['invoice acme', 'invoice globex', 'unrelated']);

  const results = history.search('invoice');
  assert.equal(results.length, 2);

  await settings.update({ ui: { resultLimit: 1 } });
  assert.equal(history.search('invoice').length, 1, 'the limit comes from settings');
});

test('an empty search returns full history', async (t) => {
  const { history, store, clock } = await harness(t);
  await seed(store, clock, ['a', 'b']);

  assert.equal(history.search('').length, 2);
});

test('use puts the payload on the clipboard and promotes the item', async (t) => {
  const { history, store, source, clock } = await harness(t);
  const [target] = await seed(store, clock, ['paste me', 'something else']);

  const result = await history.use(target.id);

  assert.equal(source.current.text, 'paste me', 'the clipboard now holds it');
  assert.equal(result.item.copyCount, 2, 'selecting is a use');
  assert.equal(history.list()[0].id, target.id, 'and moves it to the top');
});

test('use resolves a spilled blob so the whole payload is pasted', async (t) => {
  const { history, store, source } = await harness(t, { store: { inlineLimitBytes: 512 } });
  const big = 'Z'.repeat(4096);
  const { item } = await store.add(textSnapshot(big));

  await history.use(item.id);

  assert.equal(source.current.text, big, 'not the truncated head');
});

test('use leaves the clipboard untouched when the payload cannot be read', async (t) => {
  const { history, store, source } = await harness(t, { store: { inlineLimitBytes: 256 } });
  const { item } = await store.add(textSnapshot('Y'.repeat(2048)));
  await source.write(textSnapshot('previous clipboard'));
  await store.blobs.delete(item.blobRef);

  await assert.rejects(() => history.use(item.id), { kind: 'storage' });

  assert.equal(source.current.text, 'previous clipboard', 'no partial value was written');
});

test('using an item does not make the monitor record it as a fresh copy', async (t) => {
  const { history, store, monitor, clock } = await harness(t);
  const [target] = await seed(store, clock, ['reuse me', 'other']);
  await monitor.start();
  await clock.advance(POLL);

  await history.use(target.id);
  await clock.advance(POLL * 3);

  assert.equal(store.size, 2, 'no duplicate entry appeared');
  assert.equal(store.get(target.id).copyCount, 2, 'counted once, not twice');
});

test('use rejects an unknown id and a service with no source', async (t) => {
  const { history, store } = await harness(t);
  const { item } = await store.add(textSnapshot('exists'));

  await assert.rejects(() => history.use('0'.repeat(26)), { kind: 'validation' });

  const readOnly = new HistoryService({ store });
  await assert.rejects(() => readOnly.use(item.id), { kind: 'validation' });
});

test('readPayload returns content without touching the clipboard', async (t) => {
  const { history, store, source } = await harness(t);
  const { item } = await store.add(textSnapshot('inspect me'));

  assert.equal(await history.readPayload(item.id), 'inspect me');
  assert.equal(source.current, null, 'the clipboard was not written');
  await assert.rejects(() => history.readPayload('0'.repeat(26)), { kind: 'validation' });
});

test('pin, unpin, and togglePin move an item in and out of favourites', async (t) => {
  const { history, store } = await harness(t);
  const { item } = await store.add(textSnapshot('favourite'));

  assert.equal((await history.pin(item.id)).pinned, true);
  assert.equal((await history.unpin(item.id)).pinned, false);
  assert.equal((await history.togglePin(item.id)).pinned, true);
  assert.equal((await history.togglePin(item.id)).pinned, false);
  assert.equal(await history.togglePin('0'.repeat(26)), null);
});

test('pinned items surface first when settings ask for it', async (t) => {
  const { history, store, settings, clock } = await harness(t);
  const [old] = await seed(store, clock, ['old pinned note', 'newer note']);
  await history.pin(old.id);

  await settings.update({ ui: { pinnedFirst: true } });
  assert.equal(history.search('')[0].item.id, old.id);

  await settings.update({ ui: { pinnedFirst: false } });
  assert.equal(history.search('note')[0].item.id, old.id, 'the pin boost still applies');
});

test('delete removes an item and clear keeps pins', async (t) => {
  const { history, store, clock } = await harness(t);
  const [first, second] = await seed(store, clock, ['delete me', 'keep me']);
  await history.pin(second.id);

  assert.equal(await history.delete(first.id), true);
  assert.equal(history.list().length, 1);

  await history.clear();
  assert.equal(history.list().length, 1, 'the pin survived clear');

  await history.clear({ keepPinned: false });
  assert.equal(history.list().length, 0);
});

test('retention uses the configured policy by default', async (t) => {
  const { history, store, settings, clock } = await harness(t);
  await seed(store, clock, ['ancient']);
  await settings.update({ retention: { maxAgeMinutes: 1 } });

  clock.jump(60 * 60_000);
  const report = await history.applyRetention();

  assert.equal(report.expired.length, 1);
  assert.equal(report.expired[0].reason, 'max_age');
  assert.equal(history.list().length, 0);
});

test('retention never expires a pinned item', async (t) => {
  const { history, store, settings, clock } = await harness(t);
  const [item] = await seed(store, clock, ['pinned forever']);
  await history.pin(item.id);
  await settings.update({ retention: { maxAgeMinutes: 1, maxItems: 1 } });

  clock.jump(365 * 24 * 60 * 60_000);
  const report = await history.applyRetention();

  assert.deepEqual(report.expired, []);
  assert.equal(history.list().length, 1);
});

test('stats combine storage and monitor counters', async (t) => {
  const { history, store, monitor, source, clock } = await harness(t);
  await monitor.start();
  source.set(textSnapshot('captured through the monitor'));
  await clock.advance(POLL);

  const stats = await history.stats();

  assert.equal(stats.items, 1);
  assert.equal(stats.monitor.captured, 1);
  assert.ok(stats.dataDir);
});

test('a read-only service still lists and searches', async (t) => {
  const { store, clock } = await harness(t);
  await seed(store, clock, ['readable']);
  const readOnly = new HistoryService({ store });

  assert.equal(readOnly.list().length, 1);
  assert.equal(readOnly.search('readable').length, 1);
  assert.equal(readOnly.get(store.list()[0].id).text, 'readable');
});

test('the full product loop works end to end', async (t) => {
  const { history, store, source, monitor, clock } = await harness(t);
  await monitor.start();

  // Copy → Remember
  source.set(textSnapshot('ssh user@prod.example.com'));
  await clock.advance(POLL);
  source.set(textSnapshot('meeting link https://example.com/room/42'));
  await clock.advance(POLL);
  source.set(textSnapshot('git rebase --onto main feature'));
  await clock.advance(POLL);
  assert.equal(store.size, 3);

  // Summon → Select. Time passes while the user reads the overlay, which is
  // what keeps `updatedAt` a total order rather than a tie with the last copy.
  clock.jump(5000);
  const results = history.search('prod');
  assert.equal(results.length, 1);

  // Paste
  await history.use(results[0].item.id);
  assert.equal(source.current.text, 'ssh user@prod.example.com');

  // The clipboard change caused by our own paste is not recorded twice.
  await clock.advance(POLL * 3);
  assert.equal(store.size, 3);
  assert.equal(history.list()[0].text, 'ssh user@prod.example.com', 'and it is now on top');
});
