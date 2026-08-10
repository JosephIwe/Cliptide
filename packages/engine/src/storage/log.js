/**
 * Append-only JSONL log.
 *
 * This is the durability primitive the whole store rests on. Three properties
 * are what make it safe:
 *
 *  1. **Appends only.** No existing byte is ever rewritten, so no prior record
 *     can be damaged by a later failure.
 *  2. **Tail repair on open.** A power loss mid-append leaves a line with no
 *     terminating newline. Opening truncates back to the last complete line
 *     *before* the handle is opened for appending — otherwise the next append
 *     would weld itself onto the torn record and corrupt the middle of the
 *     file, which no reader could recover from.
 *  3. **Atomic replacement.** Compaction writes a temp file, fsyncs it, and
 *     renames it over the original. A crash at any point leaves either the old
 *     complete log or the new complete log, never a half-written one.
 *
 * Reads are corruption-tolerant: an unparseable line is counted and skipped,
 * never fatal. Losing one damaged record must not cost the user their history.
 */

import { createReadStream, promises as fs } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { StorageError } from '../core/errors.js';
import { DIR_MODE, FILE_MODE } from './paths.js';

const NEWLINE = 0x0a;

/** Bytes read from the tail when looking for the last complete record. */
const TAIL_PROBE_BYTES = 64 * 1024;

export class AppendLog {
  /** @param {string} filePath */
  constructor(filePath) {
    this.filePath = filePath;
    this.tmpPath = `${filePath}.tmp`;
    /** @type {import('node:fs/promises').FileHandle|null} */
    this.handle = null;
    /** Bytes discarded by tail repair on the most recent open. */
    this.repairedBytes = 0;
  }

  async open() {
    if (this.handle) return this;
    const dir = path.dirname(this.filePath);
    try {
      await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
      // A leftover temp file means compaction was interrupted. The original is
      // authoritative, so the partial rewrite is discarded.
      await fs.rm(this.tmpPath, { force: true });
      this.repairedBytes = await this.#repairTail();
      this.handle = await fs.open(this.filePath, 'a', FILE_MODE);
    } catch (err) {
      throw new StorageError('could not open history log', {
        reason: err.code ?? err.message.slice(0, 120),
      });
    }
    return this;
  }

  /**
   * Truncate any trailing partial record.
   * @returns {Promise<number>} bytes discarded
   */
  async #repairTail() {
    let stats;
    try {
      stats = await fs.stat(this.filePath);
    } catch (err) {
      if (err.code === 'ENOENT') return 0;
      throw err;
    }
    if (stats.size === 0) return 0;

    const probeLength = Math.min(TAIL_PROBE_BYTES, stats.size);
    const buffer = Buffer.alloc(probeLength);
    const readHandle = await fs.open(this.filePath, 'r');
    try {
      await readHandle.read(buffer, 0, probeLength, stats.size - probeLength);
    } finally {
      await readHandle.close();
    }

    if (buffer[probeLength - 1] === NEWLINE) return 0;

    const lastNewline = buffer.lastIndexOf(NEWLINE);
    if (lastNewline === -1) {
      // The whole probe window is one unterminated record. If that window is
      // the entire file, there is no complete record at all; otherwise the
      // record is larger than the probe and we cannot safely locate its start,
      // so the conservative choice is to keep the file and let the reader skip
      // the bad line rather than discard data we cannot measure.
      if (probeLength === stats.size) {
        await fs.truncate(this.filePath, 0);
        return stats.size;
      }
      return 0;
    }

    const keepBytes = stats.size - probeLength + lastNewline + 1;
    await fs.truncate(this.filePath, keepBytes);
    return stats.size - keepBytes;
  }

  #assertOpen() {
    if (!this.handle) throw new StorageError('history log is not open', {});
  }

  /**
   * Append one record durably.
   *
   * fsync per append is deliberate. Clipboard events arrive a few times a
   * minute, so the cost is irrelevant, and the alternative — losing the last
   * few copies to a crash — is exactly the failure this project promises not
   * to have.
   */
  async append(record) {
    this.#assertOpen();
    const line = `${JSON.stringify(record)}\n`;
    try {
      await this.handle.write(line, null, 'utf8');
      await this.handle.sync();
    } catch (err) {
      throw new StorageError('could not append to history log', {
        reason: err.code ?? err.message.slice(0, 120),
        bytes: Buffer.byteLength(line),
      });
    }
  }

  /**
   * Read every record, skipping unparseable lines.
   *
   * @returns {Promise<{records: object[], corruptLines: number[]}>}
   */
  async readAll() {
    const records = [];
    const corruptLines = [];

    let stream;
    try {
      stream = createReadStream(this.filePath, { encoding: 'utf8' });
    } catch (err) {
      if (err.code === 'ENOENT') return { records, corruptLines };
      throw new StorageError('could not read history log', { reason: err.code });
    }

    const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let lineNumber = 0;
    try {
      for await (const raw of reader) {
        lineNumber += 1;
        const trimmed = raw.trim();
        if (trimmed === '') continue;
        try {
          records.push(JSON.parse(trimmed));
        } catch {
          // One damaged line must never cost the user the rest of the file.
          corruptLines.push(lineNumber);
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw new StorageError('could not read history log', { reason: err.code, lineNumber });
      }
    } finally {
      reader.close();
    }

    return { records, corruptLines };
  }

  /**
   * Atomically replace the log with a new record set (compaction).
   *
   * The append handle is closed first so Windows can rename over the target,
   * and reopened afterwards so the caller's log stays usable.
   */
  async replaceAll(records) {
    this.#assertOpen();
    const payload = records.map((record) => `${JSON.stringify(record)}\n`).join('');

    try {
      const tmp = await fs.open(this.tmpPath, 'w', FILE_MODE);
      try {
        await tmp.writeFile(payload, 'utf8');
        await tmp.sync();
      } finally {
        await tmp.close();
      }

      await this.handle.close();
      this.handle = null;

      await fs.rename(this.tmpPath, this.filePath);
      await this.#syncDirectory();

      this.handle = await fs.open(this.filePath, 'a', FILE_MODE);
    } catch (err) {
      // Leave the original log in place; the caller keeps its in-memory index.
      await fs.rm(this.tmpPath, { force: true }).catch(() => {});
      if (!this.handle) {
        this.handle = await fs.open(this.filePath, 'a', FILE_MODE).catch(() => null);
      }
      throw new StorageError('could not compact history log', {
        reason: err.code ?? err.message.slice(0, 120),
        records: records.length,
      });
    }
  }

  /** Persist the rename itself. Without this, a crash can lose the new name. */
  async #syncDirectory() {
    let dirHandle;
    try {
      dirHandle = await fs.open(path.dirname(this.filePath), 'r');
      await dirHandle.sync();
    } catch {
      // Directory fsync is unsupported on some platforms (notably Windows).
      // The rename is still atomic there; only the durability barrier is lost.
    } finally {
      await dirHandle?.close().catch(() => {});
    }
  }

  async size() {
    try {
      const stats = await fs.stat(this.filePath);
      return stats.size;
    } catch (err) {
      if (err.code === 'ENOENT') return 0;
      throw err;
    }
  }

  async close() {
    if (!this.handle) return;
    await this.handle.close();
    this.handle = null;
  }
}
