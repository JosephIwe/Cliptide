import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ClipStore, SKIP_REASONS, SECRET_POLICIES } from '../src/storage/store.js';
import { RETENTION_REASONS } from '../src/storage/retention.js';
import { createManualClock } from '../src/core/clock.js';
import { createIdFactory } from '../src/core/ids.js';
import { tempDir, textSnapshot } from './helpers/tempdir.js';

async function openStore(t, options = {}) {
  const dataDir = options.dataDir ?? (await tempDir(t));
  const clock = options.clock ?? createManualClock();
  const store = await ClipStore.open({
    dataDir,
    clock,
    idFactory: createIdFactory({ clock }),
    ...options,
  });
  t.after(() => store.close());
  return { store, clock, dataDir };
}

test('a snapshot becomes a retrievable item', async (t) => {
  const { store } = await openStore(t);

  const result = await store.add(textSnapshot('hello world'));

  assert.equal(result.stored, true);
  assert.equal(result.created, true);
  assert.equal(store.size, 1);
  assert.equal(store.get(result.item.id).text, 'hello world');
  assert.equal(await store.readPayload(result.item), 'hello world');
});

test('re-copying the same content promotes instead of duplicating', async (t) => {
  const { store, clock } = await openStore(t);

  const first = await store.add(textSnapshot('repeated'));
  clock.jump(5000);
  const second = await store.add(textSnapshot('repeated'));

  assert.equal(store.size, 1, 'history holds one entry, not two');
  assert.equal(second.created, false);
  assert.equal(second.item.id, first.item.id, 'identity is preserved');
  assert.equal(second.item.copyCount, 2);
  assert.equal(second.item.createdAt, first.item.createdAt);
  assert.equal(second.item.updatedAt, first.item.createdAt + 5000);
});

test('a promoted item moves back to the top of history', async (t) => {
  const { store, clock } = await openStore(t);

  const first = await store.add(textSnapshot('alpha'));
  clock.jump(10);
  await store.add(textSnapshot('beta'));
  clock.jump(10);
  await store.add(textSnapshot('alpha'));

  assert.deepEqual(
    store.list().map((item) => item.text),
    ['alpha', 'beta'],
  );
  assert.equal(store.list()[0].id, first.item.id);
});

test('history is ordered newest-use first with a total ordering', async (t) => {
  const { store, clock } = await openStore(t);

  for (const text of ['one', 'two', 'three']) {
    await store.add(textSnapshot(text));
    clock.jump(1000);
  }

  assert.deepEqual(
    store.list().map((item) => item.text),
    ['three', 'two', 'one'],
  );
});

test('concealed content is never stored', async (t) => {
  const { store } = await openStore(t);

  const result = await store.add(
    textSnapshot('correct-horse-battery-staple', { markers: ['org.nspasteboard.ConcealedType'] }),
  );

  assert.equal(result.stored, false);
  assert.equal(result.reason, SKIP_REASONS.CONCEALED);
  assert.equal(store.size, 0);

  const { records } = await store.log.readAll();
  assert.equal(records.length, 0, 'nothing about it reached the log');
});

test('an oversized payload is refused with a reason, not stored truncated', async (t) => {
  const { store } = await openStore(t, { maxItemBytes: 1024 });

  const result = await store.add(textSnapshot('x'.repeat(2048)));

  assert.equal(result.stored, false);
  assert.equal(result.reason, SKIP_REASONS.TOO_LARGE);
  assert.equal(store.size, 0);
});

test('empty content is ignored', async (t) => {
  const { store } = await openStore(t);
  const result = await store.add(textSnapshot(''));

  assert.equal(result.stored, false);
  assert.equal(result.reason, SKIP_REASONS.EMPTY);
});

test('secretPolicy skip refuses flagged content; mark keeps it masked', async (t) => {
  const secret = textSnapshot('AKIAIOSFODNN7EXAMPLE');

  const skipping = await openStore(t, { secretPolicy: SECRET_POLICIES.SKIP });
  const skipped = await skipping.store.add(secret);
  assert.equal(skipped.stored, false);
  assert.equal(skipped.reason, SKIP_REASONS.SENSITIVE);

  const marking = await openStore(t, { secretPolicy: SECRET_POLICIES.MARK });
  const marked = await marking.store.add(secret);
  assert.equal(marked.stored, true);
  assert.equal(marked.item.sensitive, true);
  assert.ok(!marked.item.preview.includes('AKIAIOSFODNN7EXAMPLE'));
  assert.equal(await marking.store.readPayload(marked.item), 'AKIAIOSFODNN7EXAMPLE');
});

test('a large payload spills to a blob and still reads back whole', async (t) => {
  const { store } = await openStore(t, { inlineLimitBytes: 1024 });
  const big = 'A'.repeat(4096);

  const { item } = await store.add(textSnapshot(big));

  assert.equal(item.truncated, true);
  assert.ok(item.blobRef);
  assert.equal(await store.readPayload(item), big, 'the whole payload comes back');
  assert.equal(await store.blobs.has(item.blobRef), true);
});

test('reading a payload whose blob is gone fails loudly rather than pasting a fragment', async (t) => {
  const { store } = await openStore(t, { inlineLimitBytes: 512 });
  const { item } = await store.add(textSnapshot('B'.repeat(2048)));

  await store.blobs.delete(item.blobRef);

  await assert.rejects(() => store.readPayload(item), { kind: 'storage' });
});

test('history survives a reopen', async (t) => {
  const dataDir = await tempDir(t);
  const clock = createManualClock();

  const first = await openStore(t, { dataDir, clock });
  await first.store.add(textSnapshot('persisted one'));
  clock.jump(10);
  await first.store.add(textSnapshot('persisted two'));
  const pinned = await first.store.add(textSnapshot('pinned item'));
  await first.store.pin(pinned.item.id);
  await first.store.close();

  const second = await openStore(t, { dataDir, clock });

  assert.equal(second.store.size, 3);
  assert.equal(second.store.get(pinned.item.id).pinned, true);
  assert.deepEqual(second.store.recovery.corruptLines, []);
});

test('a large spilled payload survives a reopen', async (t) => {
  const dataDir = await tempDir(t);
  const clock = createManualClock();
  const big = 'C'.repeat(8192);

  const first = await openStore(t, { dataDir, clock, inlineLimitBytes: 1024 });
  const { item } = await first.store.add(textSnapshot(big));
  await first.store.close();

  const second = await openStore(t, { dataDir, clock, inlineLimitBytes: 1024 });
  assert.equal(await second.store.readPayload(second.store.get(item.id)), big);
});

test('pinning is idempotent and persists', async (t) => {
  const { store } = await openStore(t);
  const { item } = await store.add(textSnapshot('keep me'));

  const pinned = await store.pin(item.id);
  assert.equal(pinned.pinned, true);

  const again = await store.pin(item.id);
  assert.equal(again.pinned, true);

  const unpinned = await store.pin(item.id, false);
  assert.equal(unpinned.pinned, false);

  assert.equal(await store.pin('0'.repeat(26)), null, 'pinning a missing id is not an error');
});

test('delete removes the item and the log records the tombstone', async (t) => {
  const { store } = await openStore(t);
  const { item } = await store.add(textSnapshot('delete me'));

  assert.equal(await store.delete(item.id), true);
  assert.equal(store.size, 0);
  assert.equal(store.get(item.id), null);
  assert.equal(await store.delete(item.id), false, 'deleting twice reports honestly');
});

test('deleted content does not come back after a reopen', async (t) => {
  const dataDir = await tempDir(t);
  const clock = createManualClock();

  const first = await openStore(t, { dataDir, clock });
  const { item } = await first.store.add(textSnapshot('gone'));
  await first.store.delete(item.id);
  await first.store.close();

  const second = await openStore(t, { dataDir, clock });
  assert.equal(second.store.size, 0);
});

test('clear keeps pins by default and removes them only when asked', async (t) => {
  const { store } = await openStore(t);
  const loose = await store.add(textSnapshot('loose'));
  const kept = await store.add(textSnapshot('kept'));
  await store.pin(kept.item.id);

  const removed = await store.clear();
  assert.equal(removed, 1);
  assert.equal(store.size, 1);
  assert.equal(store.get(kept.item.id).pinned, true);
  assert.equal(store.get(loose.item.id), null);

  await store.clear({ keepPinned: false });
  assert.equal(store.size, 0);
});

test('retention expires by policy and reports why', async (t) => {
  const { store, clock } = await openStore(t);

  const stale = await store.add(textSnapshot('old news'));
  clock.jump(120 * 60_000);
  await store.add(textSnapshot('fresh'));

  const report = await store.applyRetention({ maxAgeMinutes: 60, maxItems: null });

  assert.deepEqual(report.expired, [{ id: stale.item.id, reason: RETENTION_REASONS.MAX_AGE }]);
  assert.equal(store.size, 1);
});

test('retention never expires a pinned item', async (t) => {
  const { store, clock } = await openStore(t);
  const pinned = await store.add(textSnapshot('pinned and ancient'));
  await store.pin(pinned.item.id);

  clock.jump(365 * 24 * 60 * 60_000);
  const report = await store.applyRetention({ maxAgeMinutes: 1, maxItems: 1 });

  assert.deepEqual(report.expired, []);
  assert.equal(store.get(pinned.item.id).pinned, true);
});

test('retention frees the blobs of expired items', async (t) => {
  const { store, clock } = await openStore(t, { inlineLimitBytes: 256 });
  const { item } = await store.add(textSnapshot('D'.repeat(2048)));
  assert.equal(await store.blobs.has(item.blobRef), true);

  clock.jump(120 * 60_000);
  await store.applyRetention({ maxAgeMinutes: 60 });

  assert.equal(store.size, 0);
  assert.equal(await store.blobs.has(item.blobRef), false, 'the payload is really gone');
});

test('compaction shrinks the log without changing what the user sees', async (t) => {
  const { store, clock } = await openStore(t, { compaction: { minRecords: 10 ** 6, ratio: 10 ** 6 } });

  for (let i = 0; i < 20; i++) {
    await store.add(textSnapshot('churn'));
    clock.jump(1);
  }
  await store.add(textSnapshot('distinct'));

  const before = store.list().map((item) => item.id);
  assert.ok(store.logRecords > 2, 'promotions each wrote a record');

  const result = await store.compact();

  assert.equal(result.records, 2);
  assert.equal(store.logRecords, 2);
  assert.deepEqual(
    store.list().map((item) => item.id),
    before,
    'compaction is invisible to the user',
  );

  const { records } = await store.log.readAll();
  assert.equal(records.length, 2);
});

test('compaction happens automatically once the log outgrows the index', async (t) => {
  const { store, clock } = await openStore(t, { compaction: { minRecords: 10, ratio: 2 } });

  for (let i = 0; i < 40; i++) {
    await store.add(textSnapshot('same content again'));
    clock.jump(1);
  }

  assert.equal(store.size, 1);
  assert.ok(store.logRecords <= 10, `log stayed bounded (${store.logRecords} records)`);
});

test('compaction collects orphaned blobs', async (t) => {
  const { store } = await openStore(t, { inlineLimitBytes: 128 });
  const { item } = await store.add(textSnapshot('E'.repeat(1024)));
  await store.delete(item.id);

  await store.compact();

  assert.equal(await store.blobs.has(item.blobRef), false);
});

test('a corrupt line is reported at open and the rest of history survives', async (t) => {
  const dataDir = await tempDir(t);
  const clock = createManualClock();

  const first = await openStore(t, { dataDir, clock });
  await first.store.add(textSnapshot('before the damage'));
  await first.store.close();

  await fs.appendFile(path.join(dataDir, 'history.jsonl'), 'CORRUPTED LINE\n');

  const second = await openStore(t, { dataDir, clock });

  assert.equal(second.store.size, 1);
  assert.deepEqual(second.store.recovery.corruptLines, [2], 'the damage is surfaced, not hidden');
});

test('a record that no longer validates is dropped and counted', async (t) => {
  const dataDir = await tempDir(t);
  const clock = createManualClock();

  const first = await openStore(t, { dataDir, clock });
  await first.store.add(textSnapshot('valid'));
  await first.store.close();

  await fs.appendFile(
    path.join(dataDir, 'history.jsonl'),
    `${JSON.stringify({ op: 'put', item: { id: 'not-an-id', kind: 'text' } })}\n`,
  );

  const second = await openStore(t, { dataDir, clock });

  assert.equal(second.store.size, 1);
  assert.equal(second.store.recovery.droppedRecords, 1);
});

test('a torn final record does not stop the store from opening', async (t) => {
  const dataDir = await tempDir(t);
  const clock = createManualClock();

  const first = await openStore(t, { dataDir, clock });
  await first.store.add(textSnapshot('survives a power cut'));
  await first.store.close();

  await fs.appendFile(path.join(dataDir, 'history.jsonl'), '{"op":"put","item":{"id":"01');

  const second = await openStore(t, { dataDir, clock });

  assert.equal(second.store.size, 1);
  assert.ok(second.store.recovery.repairedBytes > 0);
  await assert.doesNotReject(() => second.store.add(textSnapshot('and keeps working')));
  assert.equal(second.store.size, 2);
});

test('concurrent writes are serialized and none are lost', async (t) => {
  const { store } = await openStore(t);

  await Promise.all(
    Array.from({ length: 25 }, (_, i) => store.add(textSnapshot(`concurrent ${i}`))),
  );

  assert.equal(store.size, 25);
  const { records } = await store.log.readAll();
  assert.equal(records.length, 25, 'every append landed exactly once');
});

test('a pin racing an add does not lose the pin', async (t) => {
  const { store } = await openStore(t);
  const { item } = await store.add(textSnapshot('target'));

  const [, pinned] = await Promise.all([
    store.add(textSnapshot('noise')),
    store.pin(item.id),
  ]);

  assert.equal(pinned.pinned, true);
  assert.equal(store.get(item.id).pinned, true);
});

test('list filters by kind and pin without disturbing order', async (t) => {
  const { store, clock } = await openStore(t);

  await store.add(textSnapshot('text one'));
  clock.jump(10);
  const files = await store.add({ kind: 'files', files: ['/tmp/report.pdf'] });
  clock.jump(10);
  const pinned = await store.add(textSnapshot('pin this'));
  await store.pin(pinned.item.id);

  assert.equal(store.list({ kinds: ['files'] }).length, 1);
  assert.equal(store.list({ kinds: ['files'] })[0].id, files.item.id);
  assert.equal(store.list({ pinnedOnly: true }).length, 1);
  assert.equal(store.list({ limit: 2 }).length, 2);
  assert.equal(store.list({ offset: 1 }).length, 2);
});

test('getByHash finds an item by content', async (t) => {
  const { store } = await openStore(t);
  const { item } = await store.add(textSnapshot('find me by content'));

  assert.equal(store.getByHash(item.hash).id, item.id);
  assert.equal(store.getByHash('0'.repeat(64)), null);
});

test('stats describe the store honestly', async (t) => {
  const { store } = await openStore(t, { inlineLimitBytes: 256 });
  await store.add(textSnapshot('small'));
  const secret = await store.add(textSnapshot('AKIAIOSFODNN7EXAMPLE'));
  const big = await store.add(textSnapshot('F'.repeat(1024)));
  await store.pin(big.item.id);

  const stats = await store.stats();

  assert.equal(stats.items, 3);
  assert.equal(stats.pinned, 1);
  assert.equal(stats.sensitive, 1);
  assert.ok(stats.logBytes > 0);
  assert.ok(stats.blobBytes >= 1024);
  assert.equal(stats.recovery.corruptLines.length, 0);
  assert.ok(secret.item.sensitive);
});

test('an image snapshot stores as a blob with a descriptive preview', async (t) => {
  const { store } = await openStore(t);
  const bytes = Buffer.alloc(3000, 9);

  const { item } = await store.add({ kind: 'image', bytes, format: 'image/png' });

  assert.equal(item.kind, 'image');
  assert.equal(item.preview, 'PNG image · 2.9 KB');
  const payload = await store.readPayload(item);
  assert.ok(Buffer.isBuffer(payload));
  assert.equal(payload.byteLength, 3000);
});
