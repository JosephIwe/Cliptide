import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_RETENTION,
  RETENTION_REASONS,
  evaluateRetention,
  normalizeRetention,
} from '../src/storage/retention.js';

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

let counter = 0;
function item(overrides = {}) {
  counter += 1;
  return {
    id: String(counter).padStart(26, '0'),
    updatedAt: NOW,
    bytes: 100,
    pinned: false,
    sensitive: false,
    ...overrides,
  };
}

function expiredIds(result) {
  return result.expire.map((entry) => entry.id).sort();
}

test('nothing expires when everything is inside every limit', () => {
  const items = [item(), item(), item()];
  const result = evaluateRetention(items, DEFAULT_RETENTION, NOW);

  assert.deepEqual(result.expire, []);
  assert.equal(result.kept, 3);
});

test('items older than maxAge expire with a reason', () => {
  const fresh = item({ updatedAt: NOW - 5 * MINUTE });
  const stale = item({ updatedAt: NOW - 120 * MINUTE });

  const result = evaluateRetention([fresh, stale], { maxAgeMinutes: 60 }, NOW);

  assert.deepEqual(result.expire, [{ id: stale.id, reason: RETENTION_REASONS.MAX_AGE }]);
});

test('age is measured from last use, so re-copying keeps an item alive', () => {
  const old = item({ createdAt: NOW - 500 * MINUTE, updatedAt: NOW - MINUTE });
  const result = evaluateRetention([old], { maxAgeMinutes: 60 }, NOW);

  assert.deepEqual(result.expire, [], 'a recently re-copied item is not stale');
});

test('flagged secrets expire on their own shorter clock', () => {
  const secret = item({ sensitive: true, updatedAt: NOW - 20 * MINUTE });
  const ordinary = item({ updatedAt: NOW - 20 * MINUTE });

  const result = evaluateRetention(
    [secret, ordinary],
    { secretRetentionMinutes: 15, maxAgeMinutes: 60 * 24 },
    NOW,
  );

  assert.deepEqual(result.expire, [{ id: secret.id, reason: RETENTION_REASONS.SECRET_MAX_AGE }]);
});

test('maxItems trims the oldest beyond the cap', () => {
  const items = [
    item({ updatedAt: NOW - 1 * MINUTE }),
    item({ updatedAt: NOW - 2 * MINUTE }),
    item({ updatedAt: NOW - 3 * MINUTE }),
    item({ updatedAt: NOW - 4 * MINUTE }),
  ];

  const result = evaluateRetention(items, { maxItems: 2, maxAgeMinutes: null }, NOW);

  assert.deepEqual(expiredIds(result), [items[2].id, items[3].id].sort());
});

test('maxTotalBytes trims from the oldest end', () => {
  const items = [
    item({ updatedAt: NOW - 1 * MINUTE, bytes: 600 }),
    item({ updatedAt: NOW - 2 * MINUTE, bytes: 600 }),
    item({ updatedAt: NOW - 3 * MINUTE, bytes: 600 }),
  ];

  const result = evaluateRetention(items, { maxTotalBytes: 1000, maxAgeMinutes: null }, NOW);

  assert.deepEqual(expiredIds(result), [items[1].id, items[2].id].sort());
});

test('pinned items survive every automatic policy', () => {
  const pins = [
    item({ pinned: true, updatedAt: NOW - 5000 * MINUTE }),
    item({ pinned: true, sensitive: true, updatedAt: NOW - 5000 * MINUTE }),
    item({ pinned: true, bytes: 10 ** 9 }),
  ];
  const doomed = item({ updatedAt: NOW - 5000 * MINUTE });

  const result = evaluateRetention([...pins, doomed], {
    maxItems: 1,
    maxAgeMinutes: 60,
    secretRetentionMinutes: 15,
    maxTotalBytes: 100,
  }, NOW);

  assert.deepEqual(expiredIds(result), [doomed.id]);
});

test('pins do not consume the maxItems budget', () => {
  const pinned = [item({ pinned: true }), item({ pinned: true })];
  const loose = [item({ updatedAt: NOW - MINUTE }), item({ updatedAt: NOW - 2 * MINUTE })];

  const result = evaluateRetention([...pinned, ...loose], { maxItems: 2, maxAgeMinutes: null }, NOW);

  assert.deepEqual(result.expire, [], 'two unpinned items still fit under a cap of two');
});

test('an item is reported once with its first reason, not once per rule', () => {
  const doomed = item({ sensitive: true, updatedAt: NOW - 5000 * MINUTE, bytes: 10 ** 9 });

  const result = evaluateRetention([doomed], {
    maxItems: 0.5,
    maxAgeMinutes: 1,
    secretRetentionMinutes: 1,
    maxTotalBytes: 1,
  }, NOW);

  assert.equal(result.expire.length, 1);
  assert.equal(result.expire[0].reason, RETENTION_REASONS.SECRET_MAX_AGE);
});

test('null disables an individual limit', () => {
  const ancient = item({ updatedAt: NOW - 10 ** 9 });
  const result = evaluateRetention([ancient], {
    maxAgeMinutes: null,
    maxItems: null,
    secretRetentionMinutes: null,
    maxTotalBytes: null,
  }, NOW);

  assert.deepEqual(result.expire, []);
});

test('normalizeRetention fills defaults and rejects nonsense', () => {
  assert.deepEqual(normalizeRetention({}), DEFAULT_RETENTION);
  assert.equal(normalizeRetention({ maxItems: 10 }).maxItems, 10);
  assert.equal(normalizeRetention({ maxItems: null }).maxItems, null);

  assert.throws(() => normalizeRetention({ maxItems: -1 }), { kind: 'validation' });
  assert.throws(() => normalizeRetention({ maxAgeMinutes: 0 }), { kind: 'validation' });
  assert.throws(() => normalizeRetention({ maxTotalBytes: 'lots' }), { kind: 'validation' });
});

test('evaluateRetention requires a real timestamp', () => {
  assert.throws(() => evaluateRetention([], DEFAULT_RETENTION, undefined), { kind: 'validation' });
});

test('the default policy keeps two weeks and expires secrets in fifteen minutes', () => {
  assert.equal(DEFAULT_RETENTION.maxAgeMinutes, 60 * 24 * 14);
  assert.equal(DEFAULT_RETENTION.secretRetentionMinutes, 15);
});
