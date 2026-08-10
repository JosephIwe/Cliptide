import test from 'node:test';
import assert from 'node:assert/strict';
import { searchHistory, parseQuery } from '../src/search/index.js';

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let counter = 0;
function item(text, overrides = {}) {
  counter += 1;
  return {
    id: String(counter).padStart(26, '0'),
    kind: 'text',
    text,
    preview: text,
    updatedAt: NOW,
    copyCount: 1,
    pinned: false,
    sensitive: false,
    ...overrides,
  };
}

const texts = (results) => results.map((result) => result.item.text);

test('an empty query returns everything in ranked order', () => {
  const items = [item('one'), item('two')];
  assert.equal(searchHistory(items, '', { now: NOW }).length, 2);
  assert.equal(searchHistory(items, '   ', { now: NOW }).length, 2);
});

test('search is case-insensitive substring matching', () => {
  const items = [item('Quarterly Invoice 2026'), item('unrelated note')];

  assert.deepEqual(texts(searchHistory(items, 'invoice', { now: NOW })), ['Quarterly Invoice 2026']);
  assert.deepEqual(texts(searchHistory(items, 'INVOICE', { now: NOW })), ['Quarterly Invoice 2026']);
});

test('all terms must match', () => {
  const items = [item('invoice for acme corp'), item('invoice for globex')];

  assert.deepEqual(texts(searchHistory(items, 'invoice acme', { now: NOW })), [
    'invoice for acme corp',
  ]);
  assert.deepEqual(searchHistory(items, 'invoice missing', { now: NOW }), []);
});

test('quoted phrases stay together', () => {
  assert.deepEqual(parseQuery('"acme corp" invoice'), ['acme corp', 'invoice']);
  assert.deepEqual(parseQuery('plain terms here'), ['plain', 'terms', 'here']);
  assert.deepEqual(parseQuery(''), []);
  assert.deepEqual(parseQuery(null), []);

  const items = [item('acme corp invoice'), item('corp acme invoice')];
  assert.deepEqual(texts(searchHistory(items, '"acme corp"', { now: NOW })), ['acme corp invoice']);
});

test('an exact match outranks a prefix, which outranks a word start, which outranks a substring', () => {
  const exact = item('token');
  const prefix = item('token in a longer string');
  const wordStart = item('the token is here');
  const substring = item('mytokenvalue');

  const results = searchHistory([substring, wordStart, prefix, exact], 'token', { now: NOW });

  assert.deepEqual(texts(results), [
    'token',
    'token in a longer string',
    'the token is here',
    'mytokenvalue',
  ]);
});

test('recent items outrank older ones at equal relevance', () => {
  const recent = item('meeting notes', { updatedAt: NOW - MINUTE });
  const old = item('meeting notes elsewhere', { updatedAt: NOW - 72 * HOUR });

  assert.deepEqual(texts(searchHistory([old, recent], 'meeting', { now: NOW })), [
    'meeting notes',
    'meeting notes elsewhere',
  ]);
});

test('frequently used items get a bounded boost', () => {
  const rare = item('deploy command', { copyCount: 1 });
  const frequent = item('deploy command variant', { copyCount: 40 });

  const results = searchHistory([rare, frequent], 'deploy', { now: NOW });
  assert.equal(results[0].item.text, 'deploy command variant');

  // Bounded: frequency alone cannot beat a much stronger textual match.
  const exact = item('deploy', { copyCount: 1 });
  const heavy = item('run the deploy now', { copyCount: 10_000 });
  assert.equal(searchHistory([heavy, exact], 'deploy', { now: NOW })[0].item.text, 'deploy');
});

test('at equal relevance a pin outranks a much fresher item', () => {
  const pinned = item('snippet pinned', { pinned: true, updatedAt: NOW - 100 * HOUR });
  const fresh = item('snippet fresh', { updatedAt: NOW });

  const results = searchHistory([fresh, pinned], 'snippet', { now: NOW });
  assert.equal(results[0].item.pinned, true, 'the pin boost beat a 100-hour recency gap');
});

test('the pin boost is a boost, not an override — pinnedFirst is the override', () => {
  // A stale pin whose text matches less well loses to a fresh strong match.
  const pinned = item('the snippet is pinned', { pinned: true, updatedAt: NOW - 100 * HOUR });
  const fresh = item('snippet fresh', { updatedAt: NOW });

  const ranked = searchHistory([fresh, pinned], 'snippet', { now: NOW });
  assert.equal(ranked[0].item.pinned, false, 'relevance and recency can outweigh a pin');

  const forced = searchHistory([fresh, pinned], 'snippet', { now: NOW, pinnedFirst: true });
  assert.equal(forced[0].item.pinned, true, 'pinnedFirst puts pins above everything');
});

test('filters narrow the candidate set', () => {
  const items = [
    item('text item'),
    item('/tmp/report.pdf', { kind: 'files' }),
    item('AKIA-secret-looking', { sensitive: true }),
    item('pinned one', { pinned: true }),
  ];

  assert.equal(searchHistory(items, '', { now: NOW, kinds: ['files'] }).length, 1);
  assert.equal(searchHistory(items, '', { now: NOW, pinnedOnly: true }).length, 1);
  assert.equal(searchHistory(items, '', { now: NOW, includeSensitive: false }).length, 3);
});

test('limit caps the result set after ranking, not before', () => {
  const items = [
    item('alpha match', { updatedAt: NOW - 10 * HOUR }),
    item('alpha', { updatedAt: NOW - 20 * HOUR }),
    item('alpha again', { updatedAt: NOW - 30 * HOUR }),
  ];

  const limited = searchHistory(items, 'alpha', { now: NOW, limit: 1 });
  assert.equal(limited.length, 1);
  assert.equal(limited[0].item.text, 'alpha', 'the best result survived the cap');
});

test('highlights mark every occurrence and merge overlaps', () => {
  const [result] = searchHistory([item('test a test b')], 'test', { now: NOW });

  assert.deepEqual(result.highlights, [
    { start: 0, end: 4 },
    { start: 7, end: 11 },
  ]);

  const [overlapping] = searchHistory([item('abcabc')], 'abc bca', { now: NOW });
  for (let i = 1; i < overlapping.highlights.length; i++) {
    assert.ok(
      overlapping.highlights[i].start > overlapping.highlights[i - 1].end,
      'ranges never overlap',
    );
  }
});

test('highlights index the preview, which may differ from the payload', () => {
  const masked = item('password=hunter2', { preview: 'password=••••••••' });
  const [result] = searchHistory([masked], 'password', { now: NOW });

  assert.deepEqual(result.highlights, [{ start: 0, end: 8 }]);
  for (const range of result.highlights) {
    assert.ok(range.end <= masked.preview.length, 'a highlight cannot point past the preview');
  }
});

test('an empty query produces no highlights', () => {
  const [result] = searchHistory([item('anything')], '', { now: NOW });
  assert.deepEqual(result.highlights, []);
});

test('ordering is total, so equal-scoring results never shuffle', () => {
  const items = [
    item('same', { updatedAt: NOW, copyCount: 1 }),
    item('same', { updatedAt: NOW, copyCount: 1 }),
    item('same', { updatedAt: NOW, copyCount: 1 }),
  ];

  const first = searchHistory(items, 'same', { now: NOW }).map((result) => result.item.id);
  const second = searchHistory([...items].reverse(), 'same', { now: NOW }).map(
    (result) => result.item.id,
  );

  assert.deepEqual(first, second, 'input order does not affect output order');
});

test('items with no inline text fall back to the preview', () => {
  const image = item(null, { kind: 'image', preview: 'PNG image · 2.0 KB', text: null });

  assert.deepEqual(texts(searchHistory([image], 'png', { now: NOW })), [null]);
  assert.equal(searchHistory([image], 'jpeg', { now: NOW }).length, 0);
});

test('searching a large history stays fast', () => {
  const many = Array.from({ length: 5000 }, (_, i) =>
    item(`history entry number ${i} with some filler text to scan`, {
      updatedAt: NOW - i * MINUTE,
    }),
  );

  const started = process.hrtime.bigint();
  const results = searchHistory(many, 'entry number 4999', { now: NOW });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(results.length, 1);
  assert.ok(elapsedMs < 250, `search over 5000 items took ${elapsedMs.toFixed(1)}ms`);
});

test('a huge payload does not blow up per-item scan cost', () => {
  const huge = item(`${'x'.repeat(2_000_000)} needle`);

  const started = process.hrtime.bigint();
  const results = searchHistory([huge], 'needle', { now: NOW });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(results.length, 0, 'documented tradeoff: only the head is searched');
  assert.ok(elapsedMs < 100, 'scan cost is bounded regardless of payload size');
});
