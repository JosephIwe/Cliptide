import test from 'node:test';
import assert from 'node:assert/strict';
import { blobKey, hashBytes, hashFiles, hashText } from '../src/core/hash.js';

test('hashing is stable and content-sensitive', () => {
  assert.equal(hashText('abc'), hashText('abc'));
  assert.notEqual(hashText('abc'), hashText('abd'));
  assert.match(hashText('abc'), /^[0-9a-f]{64}$/);
});

test('format is part of the fingerprint', () => {
  assert.notEqual(
    hashText('<b>hi</b>', 'text/plain'),
    hashText('<b>hi</b>', 'text/html'),
    'the same bytes in a different format are different clipboard content',
  );
});

test('kinds are domain-separated so payloads cannot collide across kinds', () => {
  const text = 'payload';
  assert.notEqual(hashText(text), hashBytes(Buffer.from(text)));
  assert.notEqual(hashFiles([text]), hashText(text));
});

test('field boundaries cannot be forged by embedding a separator', () => {
  // Without a delimiter between fields, ['a','bc'] and ['ab','c'] would collide.
  assert.notEqual(hashFiles(['a', 'bc']), hashFiles(['ab', 'c']));
});

test('file lists hash order-independently', () => {
  assert.equal(hashFiles(['/b', '/a', '/c']), hashFiles(['/a', '/b', '/c']));
});

test('hashBytes accepts Buffers and TypedArrays identically', () => {
  const buffer = Buffer.from([1, 2, 3, 4]);
  const view = new Uint8Array([1, 2, 3, 4]);
  assert.equal(hashBytes(buffer), hashBytes(view));
});

test('hashBytes respects a TypedArray view window', () => {
  const backing = new Uint8Array([9, 9, 1, 2, 3, 9]);
  const window = backing.subarray(2, 5);
  assert.equal(hashBytes(window), hashBytes(new Uint8Array([1, 2, 3])));
});

test('hash helpers reject wrong input types', () => {
  assert.throws(() => hashText(42), { kind: 'validation' });
  assert.throws(() => hashBytes('not bytes'), { kind: 'validation' });
  assert.throws(() => hashFiles('not an array'), { kind: 'validation' });
  assert.throws(() => hashFiles([1, 2]), { kind: 'validation' });
});

test('blobKey only accepts a sha256 digest', () => {
  assert.equal(blobKey(hashText('x')), hashText('x'));
  assert.throws(() => blobKey('../../etc/passwd'), { kind: 'validation' });
  assert.throws(() => blobKey('ABCDEF'), { kind: 'validation' });
});
