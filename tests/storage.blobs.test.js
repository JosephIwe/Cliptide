import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { BlobStore } from '../src/storage/blobs.js';
import { hashBytes, hashText } from '../src/core/hash.js';
import { tempDir } from './helpers/tempdir.js';

async function openBlobs(t) {
  const dir = await tempDir(t);
  const blobs = new BlobStore(path.join(dir, 'blobs'));
  await blobs.open();
  return blobs;
}

test('a blob round-trips byte-for-byte', async (t) => {
  const blobs = await openBlobs(t);
  const bytes = Buffer.from('a large clipboard payload', 'utf8');
  const key = hashBytes(bytes);

  assert.equal(await blobs.put(key, bytes), true);
  assert.deepEqual(await blobs.get(key), bytes);
  assert.equal(await blobs.has(key), true);
});

test('writing the same content twice stores one blob', async (t) => {
  const blobs = await openBlobs(t);
  const bytes = Buffer.alloc(4096, 3);
  const key = hashBytes(bytes);

  assert.equal(await blobs.put(key, bytes), true, 'first write stores');
  assert.equal(await blobs.put(key, bytes), false, 'second write is a no-op');
  assert.deepEqual(await blobs.keys(), [key]);
});

test('a missing blob reads as null rather than throwing', async (t) => {
  const blobs = await openBlobs(t);
  assert.equal(await blobs.get(hashText('never stored')), null);
  assert.equal(await blobs.has(hashText('never stored')), false);
});

test('blobs are sharded two characters deep', async (t) => {
  const blobs = await openBlobs(t);
  const key = hashText('shard me');
  await blobs.put(key, Buffer.from('x'));

  const expected = path.join(blobs.dir, key.slice(0, 2), key.slice(2));
  assert.equal(blobs.pathFor(key), expected);
  await assert.doesNotReject(() => fs.access(expected));
});

test('keys are validated, so a traversal path can never become a blob path', async (t) => {
  const blobs = await openBlobs(t);

  for (const bad of ['../../etc/passwd', 'not-a-hash', '', 'A'.repeat(64)]) {
    assert.throws(() => blobs.pathFor(bad), { kind: 'validation' }, `rejects ${bad}`);
  }
});

test('garbage collection removes only unreferenced blobs', async (t) => {
  const blobs = await openBlobs(t);
  const live = hashText('still referenced');
  const dead = hashText('orphaned');

  await blobs.put(live, Buffer.from('live payload'));
  await blobs.put(dead, Buffer.alloc(1024, 1));

  const result = await blobs.collectGarbage([live]);

  assert.equal(result.removed, 1);
  assert.equal(result.bytes, 1024);
  assert.equal(await blobs.has(live), true, 'the referenced payload survives');
  assert.equal(await blobs.has(dead), false);
});

test('garbage collection with nothing live clears the store', async (t) => {
  const blobs = await openBlobs(t);
  await blobs.put(hashText('a'), Buffer.from('a'));
  await blobs.put(hashText('b'), Buffer.from('b'));

  const result = await blobs.collectGarbage([]);

  assert.equal(result.removed, 2);
  assert.deepEqual(await blobs.keys(), []);
});

test('listing ignores stray files that are not blobs', async (t) => {
  const blobs = await openBlobs(t);
  const key = hashText('real');
  await blobs.put(key, Buffer.from('real'));

  await fs.writeFile(path.join(blobs.dir, 'README.txt'), 'not a blob');
  await fs.mkdir(path.join(blobs.dir, 'zz'), { recursive: true });
  await fs.writeFile(path.join(blobs.dir, 'zz', 'junk'), 'not a blob');

  assert.deepEqual(await blobs.keys(), [key]);
});

test('totalBytes reports what blob storage actually costs', async (t) => {
  const blobs = await openBlobs(t);
  await blobs.put(hashText('one'), Buffer.alloc(500));
  await blobs.put(hashText('two'), Buffer.alloc(1500));

  assert.equal(await blobs.totalBytes(), 2000);
});

test('deleting a blob is idempotent', async (t) => {
  const blobs = await openBlobs(t);
  const key = hashText('delete me');
  await blobs.put(key, Buffer.from('bytes'));

  assert.equal(await blobs.delete(key), true);
  assert.equal(await blobs.delete(key), true, 'deleting again is not an error');
  assert.equal(await blobs.has(key), false);
});

test('a large payload survives the round trip intact', async (t) => {
  const blobs = await openBlobs(t);
  const bytes = Buffer.alloc(5 * 1024 * 1024);
  for (let i = 0; i < bytes.length; i += 997) bytes[i] = i % 256;
  const key = hashBytes(bytes);

  await blobs.put(key, bytes);
  const read = await blobs.get(key);

  assert.equal(read.byteLength, bytes.byteLength);
  assert.equal(hashBytes(read), key, 'content hash still matches after the round trip');
});

test('no temp files are left behind after writes', async (t) => {
  const blobs = await openBlobs(t);
  await blobs.put(hashText('one'), Buffer.from('one'));

  const shards = await fs.readdir(blobs.dir);
  for (const shard of shards) {
    const entries = await fs.readdir(path.join(blobs.dir, shard));
    assert.equal(
      entries.some((entry) => entry.endsWith('.tmp')),
      false,
    );
  }
});
