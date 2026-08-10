import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdFactory, isValidId, timestampFromId, ID_LENGTH } from '../src/core/ids.js';
import { createManualClock } from '../src/core/clock.js';

test('ids have the documented shape and round-trip their timestamp', () => {
  const clock = createManualClock(1_700_000_123_456);
  const next = createIdFactory({ clock });
  const id = next();

  assert.equal(id.length, ID_LENGTH);
  assert.ok(isValidId(id));
  assert.equal(timestampFromId(id), 1_700_000_123_456);
});

test('ids sort lexicographically in creation order across milliseconds', async () => {
  const clock = createManualClock(1_700_000_000_000);
  const next = createIdFactory({ clock });

  const ids = [];
  for (let i = 0; i < 25; i++) {
    ids.push(next());
    clock.jump(1);
  }

  assert.deepEqual([...ids].sort(), ids);
});

test('ids created inside one millisecond still increase', () => {
  const clock = createManualClock();
  const next = createIdFactory({ clock });

  // A burst of clipboard events lands in the same millisecond routinely.
  const ids = Array.from({ length: 500 }, () => next());

  assert.equal(new Set(ids).size, 500, 'no duplicates within a millisecond');
  assert.deepEqual([...ids].sort(), ids, 'monotonic within a millisecond');
});

test('exhausting the random space within a millisecond still yields increasing ids', () => {
  const clock = createManualClock(1_700_000_000_000);
  // Every digit starts at max, so the very first bump overflows all 80 bits.
  const next = createIdFactory({ clock, randomDigit: () => 31 });

  const first = next();
  const second = next();
  const third = next();

  assert.ok(second > first, 'overflow borrows a millisecond rather than redrawing');
  assert.ok(third > second);
  assert.equal(timestampFromId(first), 1_700_000_000_000);
  assert.equal(timestampFromId(second), 1_700_000_000_001);
});

test('a clock stepping backwards never yields a regressing id', () => {
  const clock = createManualClock(1_700_000_000_000);
  const next = createIdFactory({ clock });

  const before = next();
  clock.jump(-5000); // NTP correction / wake-from-sleep skew
  const after = next();

  assert.ok(after > before, 'id must not regress when the wall clock does');
});

test('isValidId rejects malformed input without throwing', () => {
  assert.equal(isValidId(''), false);
  assert.equal(isValidId(null), false);
  assert.equal(isValidId('short'), false);
  assert.equal(isValidId('U'.repeat(ID_LENGTH)), false, 'U is excluded from Crockford base32');
  assert.equal(isValidId('0'.repeat(ID_LENGTH)), true);
});

test('timestampFromId rejects a malformed id', () => {
  assert.throws(() => timestampFromId('nope'), { kind: 'validation' });
});
