/**
 * ClipStore: the persistence contract for clipboard history.
 *
 * The log holds operations, not final state. Replaying it yields the current
 * history; compaction rewrites it as one `put` per live item. Callers see a
 * plain in-memory API and never touch the log directly.
 *
 * Every mutating call is serialized through a queue. The capture monitor and
 * the UI both write — an add landing between a pin's read and its append would
 * lose the pin, and "never silently destroy user data" includes that.
 *
 * Deletion is real: the record leaves the index immediately, the log records a
 * tombstone, and the next compaction drops both the record and its blob.
 */

import {
  createClipItem,
  isConcealed,
  promoteClipItem,
  validateClipItem,
} from '../core/types.js';
import { createIdFactory } from '../core/ids.js';
import { systemClock } from '../core/clock.js';
import { StorageError } from '../core/errors.js';
import { AppendLog } from './log.js';
import { BlobStore } from './blobs.js';
import { evaluateRetention, normalizeRetention } from './retention.js';
import { resolveDataDir, resolvePaths } from './paths.js';

export const OPS = Object.freeze({ PUT: 'put', DELETE: 'delete' });

/** Reasons `add` can decline to store a snapshot. Each is user-visible. */
export const SKIP_REASONS = Object.freeze({
  CONCEALED: 'concealed',
  TOO_LARGE: 'too_large',
  SENSITIVE: 'sensitive',
  EMPTY: 'empty',
});

/** How a flagged secret is handled. 'mark' keeps it but masks its preview. */
export const SECRET_POLICIES = Object.freeze({ STORE: 'store', MARK: 'mark', SKIP: 'skip' });

/** Payloads beyond this are refused outright rather than spilled. */
export const DEFAULT_MAX_ITEM_BYTES = 32 * 1024 * 1024;

/** Compact once the log holds this many records and at least `ratio` per item. */
const DEFAULT_COMPACTION = Object.freeze({ minRecords: 200, ratio: 3 });

function snapshotByteLength(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return 0;
  if (snapshot.kind === 'text') return Buffer.byteLength(snapshot.text ?? '', 'utf8');
  if (snapshot.kind === 'image') return snapshot.bytes?.byteLength ?? 0;
  return Buffer.byteLength((snapshot.files ?? []).join('\n'), 'utf8');
}

export class ClipStore {
  #queue = Promise.resolve();
  #sorted = null;

  constructor(options = {}) {
    const dataDir = options.dataDir ?? resolveDataDir();
    const paths = resolvePaths(dataDir);

    this.paths = paths;
    this.clock = options.clock ?? systemClock;
    this.nextId = options.idFactory ?? createIdFactory({ clock: this.clock });
    this.inlineLimitBytes = options.inlineLimitBytes;
    this.maxItemBytes = options.maxItemBytes ?? DEFAULT_MAX_ITEM_BYTES;
    this.secretPolicy = options.secretPolicy ?? SECRET_POLICIES.MARK;
    this.compaction = { ...DEFAULT_COMPACTION, ...(options.compaction ?? {}) };

    this.log = new AppendLog(paths.historyFile);
    this.blobs = new BlobStore(paths.blobDir);

    /** @type {Map<string, import('../core/types.js').ClipItem>} */
    this.items = new Map();
    /** @type {Map<string, string>} content hash -> item id */
    this.byHash = new Map();
    this.logRecords = 0;
    /** What opening the store had to recover from. Surfaced, never hidden. */
    this.recovery = { corruptLines: [], repairedBytes: 0, droppedRecords: 0 };
  }

  static async open(options = {}) {
    const store = new ClipStore(options);
    await store.open();
    return store;
  }

  async open() {
    await this.log.open();
    await this.blobs.open();

    const { records, corruptLines } = await this.log.readAll();
    this.recovery = { corruptLines, repairedBytes: this.log.repairedBytes, droppedRecords: 0 };

    for (const record of records) {
      this.logRecords += 1;
      if (record?.op === OPS.DELETE) {
        this.#forget(record.id);
        continue;
      }
      if (record?.op !== OPS.PUT) {
        this.recovery.droppedRecords += 1;
        continue;
      }
      try {
        const item = validateClipItem(record.item);
        this.#remember(item);
      } catch {
        // A record that no longer validates is dropped from the index but is
        // reported, so a schema bug shows up instead of silently eating history.
        this.recovery.droppedRecords += 1;
      }
    }

    this.#sorted = null;
    return this;
  }

  #remember(item) {
    const previous = this.items.get(item.id);
    if (previous && previous.hash !== item.hash) this.byHash.delete(previous.hash);
    this.items.set(item.id, item);
    this.byHash.set(item.hash, item.id);
    this.#sorted = null;
  }

  #forget(id) {
    const item = this.items.get(id);
    if (!item) return false;
    this.items.delete(id);
    if (this.byHash.get(item.hash) === id) this.byHash.delete(item.hash);
    this.#sorted = null;
    return true;
  }

  /** Serialize mutations so concurrent capture and UI writes cannot interleave. */
  #serialize(fn) {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  async #append(record) {
    await this.log.append(record);
    this.logRecords += 1;
  }

  /**
   * Record a clipboard snapshot.
   *
   * @returns {Promise<{stored: boolean, created: boolean, item: object|null, reason: string|null}>}
   *   `stored: false` always carries a reason from SKIP_REASONS.
   */
  async add(snapshot) {
    return this.#serialize(async () => {
      // Concealed content is refused before hashing, previewing, or sizing —
      // a password manager's output must not be processed at all.
      if (isConcealed(snapshot)) {
        return { stored: false, created: false, item: null, reason: SKIP_REASONS.CONCEALED };
      }

      const bytes = snapshotByteLength(snapshot);
      if (bytes === 0) {
        return { stored: false, created: false, item: null, reason: SKIP_REASONS.EMPTY };
      }
      // Checked before building so an enormous paste is never copied in memory.
      if (this.maxItemBytes !== null && bytes > this.maxItemBytes) {
        return { stored: false, created: false, item: null, reason: SKIP_REASONS.TOO_LARGE };
      }

      const now = this.clock.now();
      const { item, payload } = createClipItem(snapshot, {
        id: this.nextId(),
        now,
        inlineLimitBytes: this.inlineLimitBytes,
      });

      if (this.secretPolicy === SECRET_POLICIES.SKIP && item.sensitive) {
        return { stored: false, created: false, item: null, reason: SKIP_REASONS.SENSITIVE };
      }

      const existingId = this.byHash.get(item.hash);
      if (existingId !== undefined) {
        // Re-copying promotes the existing entry instead of duplicating it.
        const promoted = promoteClipItem(this.items.get(existingId), now);
        await this.#append({ op: OPS.PUT, item: promoted });
        this.#remember(promoted);
        await this.#maybeCompact();
        return { stored: true, created: false, item: promoted, reason: null };
      }

      // Blob first: a record pointing at a blob that does not exist would be an
      // item the user cannot paste. The reverse (an orphan blob) is harmless
      // and is cleaned up by the next garbage collection.
      if (payload) await this.blobs.put(item.hash, payload.bytes);

      await this.#append({ op: OPS.PUT, item });
      this.#remember(item);
      await this.#maybeCompact();
      return { stored: true, created: true, item, reason: null };
    });
  }

  get(id) {
    return this.items.get(id) ?? null;
  }

  getByHash(hash) {
    const id = this.byHash.get(hash);
    return id === undefined ? null : (this.items.get(id) ?? null);
  }

  get size() {
    return this.items.size;
  }

  /** Every item, newest use first. Ties break by id so ordering is total. */
  all() {
    if (this.#sorted === null) {
      this.#sorted = [...this.items.values()].sort(
        (a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1),
      );
    }
    return this.#sorted;
  }

  /**
   * @param {Object} [options]
   * @param {number} [options.limit]
   * @param {number} [options.offset]
   * @param {string[]} [options.kinds]
   * @param {boolean} [options.pinnedOnly]
   */
  list({ limit = Infinity, offset = 0, kinds = null, pinnedOnly = false } = {}) {
    let view = this.all();
    if (pinnedOnly) view = view.filter((item) => item.pinned);
    if (kinds) view = view.filter((item) => kinds.includes(item.kind));
    return view.slice(offset, limit === Infinity ? undefined : offset + limit);
  }

  async pin(id, pinned = true) {
    return this.#serialize(async () => {
      const item = this.items.get(id);
      if (!item) return null;
      if (item.pinned === pinned) return item;
      const updated = { ...item, pinned };
      await this.#append({ op: OPS.PUT, item: updated });
      this.#remember(updated);
      return updated;
    });
  }

  /** Explicit, user-initiated deletion of a single item. */
  async delete(id) {
    return this.#serialize(async () => {
      if (!this.items.has(id)) return false;
      await this.#append({ op: OPS.DELETE, id, at: this.clock.now() });
      this.#forget(id);
      await this.#maybeCompact();
      return true;
    });
  }

  /**
   * Clear history.
   *
   * Pins survive by default. Passing `keepPinned: false` is the user asking to
   * delete pinned items too, which is the only way they are ever removed
   * without naming them individually.
   */
  async clear({ keepPinned = true } = {}) {
    return this.#serialize(async () => {
      const doomed = [...this.items.values()].filter((item) => !(keepPinned && item.pinned));
      const at = this.clock.now();
      for (const item of doomed) {
        await this.#append({ op: OPS.DELETE, id: item.id, at });
        this.#forget(item.id);
      }
      if (doomed.length > 0) await this.compact();
      return doomed.length;
    });
  }

  /**
   * Read an item's complete payload.
   *
   * Throws when a spilled blob is missing rather than returning the truncated
   * head: pasting a silently shortened payload would be worse than an error.
   *
   * @returns {Promise<string|Buffer>}
   */
  async readPayload(item) {
    if (!item) throw new StorageError('readPayload requires an item', {});
    if (!item.blobRef) return item.text ?? '';

    const bytes = await this.blobs.get(item.blobRef);
    if (!bytes) {
      throw new StorageError('payload blob is missing', { id: item.id, blobRef: item.blobRef });
    }
    return item.kind === 'image' ? bytes : bytes.toString('utf8');
  }

  /**
   * Apply a retention policy.
   *
   * @returns {Promise<{expired: Array<{id: string, reason: string}>, kept: number}>}
   */
  async applyRetention(policy) {
    return this.#serialize(async () => {
      const limits = normalizeRetention(policy);
      const { expire, kept } = evaluateRetention([...this.items.values()], limits, this.clock.now());
      if (expire.length === 0) return { expired: [], kept };

      const at = this.clock.now();
      for (const { id } of expire) {
        await this.#append({ op: OPS.DELETE, id, at });
        this.#forget(id);
      }
      await this.compact();
      return { expired: expire, kept };
    });
  }

  async #maybeCompact() {
    const { minRecords, ratio } = this.compaction;
    if (this.logRecords < minRecords) return;
    if (this.logRecords < Math.max(1, this.items.size) * ratio) return;
    await this.compact();
  }

  /**
   * Rewrite the log as one record per live item and drop unreferenced blobs.
   *
   * Blob collection runs only after the log has been replaced, so a crash
   * mid-compaction can never leave a live record pointing at a deleted blob.
   */
  async compact() {
    const items = [...this.items.values()];
    await this.log.replaceAll(items.map((item) => ({ op: OPS.PUT, item })));
    this.logRecords = items.length;

    const liveBlobs = items.map((item) => item.blobRef).filter(Boolean);
    const collected = await this.blobs.collectGarbage(liveBlobs);
    return { records: items.length, blobsRemoved: collected.removed, bytesFreed: collected.bytes };
  }

  async stats() {
    const items = [...this.items.values()];
    return {
      dataDir: this.paths.dataDir,
      items: items.length,
      pinned: items.filter((item) => item.pinned).length,
      sensitive: items.filter((item) => item.sensitive).length,
      inlineBytes: items.reduce((total, item) => total + item.bytes, 0),
      logRecords: this.logRecords,
      logBytes: await this.log.size(),
      blobBytes: await this.blobs.totalBytes(),
      recovery: this.recovery,
    };
  }

  async close() {
    await this.#serialize(async () => {
      await this.log.close();
    });
  }
}
