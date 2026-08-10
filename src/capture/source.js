/**
 * The ClipboardSource interface.
 *
 * Everything platform-specific lives behind this contract. The monitor knows
 * only these three methods, which is what lets the same engine run against a
 * shelled-out CLI source, a native Electron source, and an in-memory fake in
 * tests without a single conditional.
 *
 * @typedef {Object} ClipboardSource
 * @property {string} name identifies the implementation in logs and settings
 * @property {() => Promise<string>} changeToken
 *   A value that changes when — and ideally only when — the clipboard changes.
 *   Implementations backed by a real pasteboard sequence number make this a
 *   cheap syscall, which is what keeps the idle cost of polling near zero.
 *   Implementations without one may derive it from content, and should say so
 *   via `cheapToken: false` so the cost is visible rather than surprising.
 * @property {() => Promise<import('../core/types.js').ClipSnapshot|null>} read
 *   The current clipboard content, or null when there is nothing readable.
 *   Must populate `markers` when the platform exposes pasteboard type hints.
 * @property {(snapshot: object) => Promise<void>} write
 *   Place content back on the clipboard. This is the paste path.
 * @property {boolean} [cheapToken] defaults to true
 */

import { ValidationError } from '../core/errors.js';

/** Throws unless the object satisfies the ClipboardSource contract. */
export function assertClipboardSource(source) {
  if (!source || typeof source !== 'object') {
    throw new ValidationError('clipboard source must be an object', {
      received: typeof source,
    });
  }
  for (const method of ['changeToken', 'read', 'write']) {
    if (typeof source[method] !== 'function') {
      throw new ValidationError(`clipboard source is missing ${method}()`, { method });
    }
  }
  return source;
}

/**
 * An in-memory clipboard.
 *
 * This is the source the entire capture test suite runs against: it makes
 * copy events explicit, so monitor behavior can be asserted without a display
 * server, a pasteboard, or a sleep.
 */
export class MemoryClipboardSource {
  constructor(initial = null) {
    this.name = 'memory';
    this.cheapToken = true;
    /** @type {object|null} */
    this.current = initial;
    this.revision = initial ? 1 : 0;
    this.reads = 0;
    this.tokenReads = 0;
    /** Set to an Error to make the next operation fail. */
    this.failWith = null;
    /** Number of remaining operations that should fail. */
    this.failCount = 0;
  }

  /** Simulate the user copying something. */
  set(snapshot) {
    this.current = snapshot;
    this.revision += 1;
    return this;
  }

  /** Simulate an app re-setting the clipboard to identical content. */
  touch() {
    this.revision += 1;
    return this;
  }

  /** Make the next `count` operations throw. */
  breakFor(count, error = new Error('clipboard unavailable')) {
    this.failCount = count;
    this.failWith = error;
    return this;
  }

  #maybeFail() {
    if (this.failCount > 0) {
      this.failCount -= 1;
      throw this.failWith ?? new Error('clipboard unavailable');
    }
  }

  async changeToken() {
    this.tokenReads += 1;
    this.#maybeFail();
    return String(this.revision);
  }

  async read() {
    this.reads += 1;
    this.#maybeFail();
    return this.current;
  }

  async write(snapshot) {
    this.#maybeFail();
    this.current = snapshot;
    this.revision += 1;
  }
}
