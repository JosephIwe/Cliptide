import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTENT_KINDS,
  CONCEALED_MARKERS,
  TEXT_HEAD_CHARS,
  buildPreview,
  createClipItem,
  formatBytes,
  isConcealed,
  promoteClipItem,
  validateClipItem,
} from '../src/core/types.js';
import { createIdFactory } from '../src/core/ids.js';
import { createManualClock } from '../src/core/clock.js';
import { hashText } from '../src/core/hash.js';

const clock = createManualClock();
const nextId = createIdFactory({ clock });

function makeText(text, overrides = {}) {
  return createClipItem(
    { kind: CONTENT_KINDS.TEXT, text, ...overrides },
    { id: nextId(), now: clock.now(), ...overrides.options },
  );
}

test('a text snapshot becomes a valid, fully populated item', () => {
  const { item, payload } = makeText('hello clipboard');

  assert.equal(payload, null, 'small text stays inline');
  assert.equal(item.kind, CONTENT_KINDS.TEXT);
  assert.equal(item.text, 'hello clipboard');
  assert.equal(item.preview, 'hello clipboard');
  assert.equal(item.hash, hashText('hello clipboard', 'text/plain'));
  assert.equal(item.bytes, 15);
  assert.equal(item.truncated, false);
  assert.equal(item.blobRef, null);
  assert.equal(item.pinned, false);
  assert.equal(item.copyCount, 1);
  assert.equal(item.createdAt, item.updatedAt);
  assert.doesNotThrow(() => validateClipItem(item));
});

test('identical content produces an identical hash and different content does not', () => {
  const a = makeText('same').item;
  const b = makeText('same').item;
  const c = makeText('same ').item;

  assert.equal(a.hash, b.hash, 'dedupe key is content-derived');
  assert.notEqual(a.id, b.id, 'ids stay unique even when content repeats');
  assert.notEqual(a.hash, c.hash, 'trailing whitespace is meaningful clipboard content');
});

test('concealed content is refused before it can be processed', () => {
  for (const marker of CONCEALED_MARKERS) {
    const snapshot = { kind: CONTENT_KINDS.TEXT, text: 'my-password', markers: [marker] };
    assert.equal(isConcealed(snapshot), true, marker);
    assert.throws(
      () => createClipItem(snapshot, { id: nextId(), now: clock.now() }),
      { kind: 'validation' },
      `must refuse ${marker}`,
    );
  }
});

test('concealed marker matching is case- and whitespace-insensitive', () => {
  assert.equal(
    isConcealed({ markers: ['  ORG.NSPasteboard.ConcealedType '] }),
    true,
    'platform casing varies; matching must not',
  );
  assert.equal(isConcealed({ markers: ['public.utf8-plain-text'] }), false);
  assert.equal(isConcealed({ markers: [] }), false);
  assert.equal(isConcealed({}), false);
});

test('oversized text is spilled to a blob but stays searchable and bounded', () => {
  const big = 'A'.repeat(300 * 1024);
  const { item, payload } = createClipItem(
    { kind: CONTENT_KINDS.TEXT, text: big },
    { id: nextId(), now: clock.now(), inlineLimitBytes: 256 * 1024 },
  );

  assert.equal(item.truncated, true);
  assert.equal(item.bytes, 300 * 1024, 'reported size is the full payload');
  assert.equal(item.text.length, TEXT_HEAD_CHARS, 'inline text is capped');
  assert.equal(item.blobRef, item.hash, 'blob is addressed by content hash');
  assert.ok(payload, 'caller receives the payload to spill');
  assert.equal(payload.bytes.byteLength, 300 * 1024);
});

test('a secret is flagged and its preview is masked', () => {
  const { item } = makeText(`export AWS_KEY=AKIAIOSFODNN7EXAMPLE`);

  assert.equal(item.sensitive, true);
  assert.ok(item.secretLabels.length > 0);
  assert.ok(!item.preview.includes('AKIAIOSFODNN7EXAMPLE'), 'the overlay never renders the key');
  assert.ok(item.preview.includes('•'));
  assert.ok(item.text.includes('AKIAIOSFODNN7EXAMPLE'), 'masking is display-only, never data loss');
});

test('a secret past the inline limit still masks its preview correctly', () => {
  // The secret sits inside the retained head; spans computed against the full
  // text must not be reused against the shorter head.
  const text = `AKIAIOSFODNN7EXAMPLE${'.'.repeat(400 * 1024)}`;
  const { item } = createClipItem(
    { kind: CONTENT_KINDS.TEXT, text },
    { id: nextId(), now: clock.now(), inlineLimitBytes: 256 * 1024 },
  );

  assert.equal(item.truncated, true);
  assert.ok(!item.preview.includes('AKIAIOSFODNN7EXAMPLE'));
});

test('previews are single-line, control-free, and capped', () => {
  const { item } = makeText('line one\nline two\ttabbed\r\nline three');
  assert.equal(item.preview, 'line one line two tabbed line three');

  const { item: escaped } = makeText('\u001b[31mred\u001b[0m text');
  assert.equal(escaped.preview, '[31mred[0m text', 'escape bytes cannot reformat the row');

  const { item: long } = makeText('x'.repeat(500));
  assert.equal(long.preview.length, 160);
  assert.ok(long.preview.endsWith('…'));
});

test('buildPreview handles empty and non-string input', () => {
  assert.equal(buildPreview(''), '');
  assert.equal(buildPreview(null), '');
  assert.equal(buildPreview('   spaced   out   '), 'spaced out');
});

test('an image item always spills and never claims to be sensitive', () => {
  const bytes = Buffer.alloc(2048, 7);
  const { item, payload } = createClipItem(
    { kind: CONTENT_KINDS.IMAGE, bytes, format: 'image/png' },
    { id: nextId(), now: clock.now() },
  );

  assert.equal(item.text, null);
  assert.equal(item.blobRef, item.hash);
  assert.equal(item.truncated, true);
  assert.equal(item.bytes, 2048);
  assert.equal(item.preview, 'PNG image · 2.0 KB');
  assert.equal(item.sensitive, false);
  assert.equal(payload.bytes.byteLength, 2048);
  assert.doesNotThrow(() => validateClipItem(item));
});

test('a file list keeps paths inline so file names are searchable', () => {
  const files = ['/Users/me/Documents/report.pdf', '/Users/me/Pictures/chart.png'];
  const { item, payload } = createClipItem(
    { kind: CONTENT_KINDS.FILES, files },
    { id: nextId(), now: clock.now() },
  );

  assert.equal(payload, null);
  assert.deepEqual(item.files, files);
  assert.ok(item.text.includes('report.pdf'));
  assert.equal(item.preview, '2 files · report.pdf, chart.png');
  assert.doesNotThrow(() => validateClipItem(item));
});

test('file order does not change the dedupe key', () => {
  const forward = createClipItem(
    { kind: CONTENT_KINDS.FILES, files: ['/a.txt', '/b.txt'] },
    { id: nextId(), now: clock.now() },
  ).item;
  const reversed = createClipItem(
    { kind: CONTENT_KINDS.FILES, files: ['/b.txt', '/a.txt'] },
    { id: nextId(), now: clock.now() },
  ).item;

  assert.equal(forward.hash, reversed.hash, 'selection order is not content');
});

test('promoting an item preserves identity and creation time', () => {
  const { item } = makeText('promote me');
  const promoted = promoteClipItem(item, item.createdAt + 60_000);

  assert.equal(promoted.id, item.id);
  assert.equal(promoted.createdAt, item.createdAt);
  assert.equal(promoted.updatedAt, item.createdAt + 60_000);
  assert.equal(promoted.copyCount, 2);
  assert.equal(item.copyCount, 1, 'the original is never mutated in place');
});

test('malformed snapshots are rejected with a reason', () => {
  const options = { id: nextId(), now: clock.now() };
  assert.throws(() => createClipItem(null, options), { kind: 'validation' });
  assert.throws(() => createClipItem({ kind: 'video' }, options), { kind: 'validation' });
  assert.throws(() => createClipItem({ kind: 'text', text: 42 }, options), { kind: 'validation' });
  assert.throws(() => createClipItem({ kind: 'image', bytes: 'no' }, options), { kind: 'validation' });
  assert.throws(() => createClipItem({ kind: 'files', files: [] }, options), { kind: 'validation' });
  assert.throws(() => createClipItem({ kind: 'files', files: [''] }, options), { kind: 'validation' });
  assert.throws(() => createClipItem({ kind: 'text', text: 'x' }, { id: 'bad', now: 1 }), {
    kind: 'validation',
  });
});

test('validateClipItem catches records corrupted on disk', () => {
  const { item } = makeText('valid');

  assert.throws(() => validateClipItem({ ...item, id: 'nope' }), { kind: 'validation' });
  assert.throws(() => validateClipItem({ ...item, kind: 'video' }), { kind: 'validation' });
  assert.throws(() => validateClipItem({ ...item, bytes: 'many' }), { kind: 'validation' });
  assert.throws(() => validateClipItem({ ...item, pinned: 'yes' }), { kind: 'validation' });
  assert.throws(() => validateClipItem({ ...item, copyCount: 0 }), { kind: 'validation' });
  assert.throws(() => validateClipItem({ ...item, secretLabels: 'none' }), { kind: 'validation' });
  assert.throws(() => validateClipItem(null), { kind: 'validation' });
});

test('formatBytes reads naturally at each scale', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(120 * 1024), '120 KB');
  assert.equal(formatBytes(3.5 * 1024 * 1024), '3.5 MB');
});
