/**
 * Content-addressed blob storage for large clipboard payloads.
 *
 * Anything past the inline limit — a big paste, an image — lives here instead
 * of in the history log, so the log stays small enough to read fully on start
 * and the in-memory index stays bounded no matter what the user copies.
 *
 * Addressing by content hash gives deduplication for free: copying the same
 * 40 MB image twice writes one blob. It also means writes are idempotent, so a
 * retried write after a crash is harmless.
 *
 * Keys are validated sha256 digests and are sharded two characters deep, which
 * keeps directory sizes reasonable and makes path traversal impossible by
 * construction — a key can only ever be 64 hex characters.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { StorageError } from '../core/errors.js';
import { blobKey } from '../core/hash.js';
import { DIR_MODE, FILE_MODE } from './paths.js';

export class BlobStore {
  /** @param {string} dir */
  constructor(dir) {
    this.dir = dir;
  }

  async open() {
    await fs.mkdir(this.dir, { recursive: true, mode: DIR_MODE });
    return this;
  }

  /** @param {string} key sha256 hex digest */
  pathFor(key) {
    const validated = blobKey(key);
    return path.join(this.dir, validated.slice(0, 2), validated.slice(2));
  }

  /**
   * Write a blob. Idempotent: an existing blob with the same key is already
   * the same bytes, so the write is skipped.
   * @returns {Promise<boolean>} true when bytes were written
   */
  async put(key, bytes) {
    const target = this.pathFor(key);
    if (await this.has(key)) return false;

    const tmp = `${target}.${process.pid}.tmp`;
    try {
      await fs.mkdir(path.dirname(target), { recursive: true, mode: DIR_MODE });
      const handle = await fs.open(tmp, 'w', FILE_MODE);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(tmp, target);
      return true;
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw new StorageError('could not write blob', {
        reason: err.code ?? err.message.slice(0, 120),
        bytes: bytes?.byteLength ?? 0,
      });
    }
  }

  /** @returns {Promise<Buffer|null>} null when the blob is missing */
  async get(key) {
    try {
      return await fs.readFile(this.pathFor(key));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw new StorageError('could not read blob', { reason: err.code });
    }
  }

  async has(key) {
    try {
      await fs.access(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key) {
    try {
      await fs.rm(this.pathFor(key), { force: true });
      return true;
    } catch (err) {
      throw new StorageError('could not delete blob', { reason: err.code });
    }
  }

  /** Every key currently on disk. */
  async keys() {
    const found = [];
    let shards;
    try {
      shards = await fs.readdir(this.dir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return found;
      throw new StorageError('could not list blobs', { reason: err.code });
    }

    for (const shard of shards) {
      if (!shard.isDirectory() || !/^[0-9a-f]{2}$/.test(shard.name)) continue;
      const entries = await fs.readdir(path.join(this.dir, shard.name)).catch(() => []);
      for (const entry of entries) {
        if (/^[0-9a-f]{62}$/.test(entry)) found.push(shard.name + entry);
      }
    }
    return found;
  }

  /**
   * Delete blobs no live item references.
   *
   * Called only after the history log has been compacted, so `liveKeys`
   * reflects committed state. Deleting a blob whose record still existed would
   * silently destroy the user's payload, so the ordering matters.
   *
   * @param {Iterable<string>} liveKeys
   * @returns {Promise<{removed: number, bytes: number}>}
   */
  async collectGarbage(liveKeys) {
    const live = new Set(liveKeys);
    let removed = 0;
    let bytes = 0;

    for (const key of await this.keys()) {
      if (live.has(key)) continue;
      const target = this.pathFor(key);
      const size = await fs
        .stat(target)
        .then((stats) => stats.size)
        .catch(() => 0);
      await fs.rm(target, { force: true }).catch(() => {});
      removed += 1;
      bytes += size;
    }

    return { removed, bytes };
  }

  /** Total bytes held in blob storage. */
  async totalBytes() {
    let total = 0;
    for (const key of await this.keys()) {
      total += await fs
        .stat(this.pathFor(key))
        .then((stats) => stats.size)
        .catch(() => 0);
    }
    return total;
  }
}
