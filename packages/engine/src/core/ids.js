/**
 * Sortable, monotonic identifiers.
 *
 * Ids are ULID-shaped: 10 characters of millisecond timestamp followed by 16
 * characters of randomness, in Crockford base32. Two properties matter here:
 *
 *  - Lexicographic order matches creation order, so history can be ordered by
 *    id without maintaining a separate sequence column.
 *  - Ids created inside the same millisecond still increase, because the random
 *    component is incremented rather than redrawn. Clipboard events arrive in
 *    bursts, so same-millisecond collisions are routine, not theoretical.
 */

import { randomInt } from 'node:crypto';
import { ValidationError } from './errors.js';

/** Crockford base32: no I, L, O, or U, so ids survive being read aloud. */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LENGTH = 10;
const RANDOM_LENGTH = 16;
export const ID_LENGTH = TIME_LENGTH + RANDOM_LENGTH;

/** Largest timestamp representable in 10 base32 characters (year 10889). */
const MAX_TIME = 32 ** TIME_LENGTH - 1;

function encodeTime(ms) {
  if (!Number.isInteger(ms) || ms < 0 || ms > MAX_TIME) {
    throw new ValidationError('timestamp out of range for id encoding', { ms });
  }
  let remaining = ms;
  let out = '';
  for (let i = 0; i < TIME_LENGTH; i++) {
    const mod = remaining % 32;
    out = ENCODING[mod] + out;
    remaining = (remaining - mod) / 32;
  }
  return out;
}

/**
 * Create an id generator.
 *
 * @param {Object} [options]
 * @param {import('./clock.js').Clock} [options.clock]
 * @param {() => number} [options.randomDigit] returns 0-31; injectable for tests
 */
export function createIdFactory({ clock, randomDigit = () => randomInt(32) } = {}) {
  const now = clock ? () => clock.now() : () => Date.now();
  let lastTime = -1;
  /** @type {number[]} */
  let lastRandom = [];

  function drawRandom() {
    const digits = new Array(RANDOM_LENGTH);
    for (let i = 0; i < RANDOM_LENGTH; i++) digits[i] = randomDigit();
    return digits;
  }

  /**
   * Increment the random component in place, carrying from the low digit up.
   * Returns false when all 80 bits overflowed inside a single millisecond.
   */
  function incrementRandom(digits) {
    for (let i = RANDOM_LENGTH - 1; i >= 0; i--) {
      if (digits[i] < 31) {
        digits[i] += 1;
        return true;
      }
      digits[i] = 0;
    }
    return false;
  }

  return function nextId() {
    const time = now();
    if (time > lastTime) {
      lastTime = time;
      lastRandom = drawRandom();
    } else {
      // Clock stalled or stepped backwards (NTP correction, sleep/wake). Hold
      // the last timestamp so ids never regress, and bump the random tail.
      if (!incrementRandom(lastRandom)) {
        // Exhausted the 80-bit space within one millisecond. Borrowing a
        // millisecond from the future keeps ids strictly increasing, which
        // history ordering depends on; redrawing at random would not.
        lastTime += 1;
        lastRandom = drawRandom();
      }
    }
    let random = '';
    for (const digit of lastRandom) random += ENCODING[digit];
    return encodeTime(lastTime) + random;
  };
}

/** Process-wide default generator. */
export const nextId = createIdFactory();

/** Extract the creation timestamp encoded in an id. */
export function timestampFromId(id) {
  if (!isValidId(id)) throw new ValidationError('malformed id', { length: id?.length ?? 0 });
  let ms = 0;
  for (let i = 0; i < TIME_LENGTH; i++) {
    ms = ms * 32 + ENCODING.indexOf(id[i]);
  }
  return ms;
}

export function isValidId(id) {
  if (typeof id !== 'string' || id.length !== ID_LENGTH) return false;
  for (const char of id) {
    if (ENCODING.indexOf(char) === -1) return false;
  }
  return true;
}
