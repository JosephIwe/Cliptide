/**
 * Settings persistence.
 *
 * Settings are small and read often, so they live in memory and are written
 * atomically on change: temp file, fsync, rename. A crash mid-save leaves the
 * previous settings intact rather than a truncated file the app cannot parse.
 *
 * A corrupt or unreadable settings file falls back to defaults and *keeps the
 * damaged file* as `settings.json.corrupt` instead of overwriting it. A user
 * who hand-edited their config and made a typo should be able to see what they
 * wrote, not discover the app silently reset them.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { StorageError } from '../core/errors.js';
import { DIR_MODE, FILE_MODE } from '../storage/paths.js';
import { DEFAULT_SETTINGS, validateSettings } from './schema.js';

export class SettingsStore {
  /** @param {string} filePath */
  constructor(filePath) {
    this.filePath = filePath;
    this.tmpPath = `${filePath}.tmp`;
    this.current = validateSettings({});
    /** What loading had to recover from. Surfaced, never hidden. */
    this.recovery = { corrupt: false, invalid: null, backupPath: null };
  }

  static async open(filePath) {
    const store = new SettingsStore(filePath);
    await store.load();
    return store;
  }

  async load() {
    let raw;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.current = validateSettings({});
        return this.current;
      }
      throw new StorageError('could not read settings', { reason: err.code });
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await this.#preserveDamaged();
      this.recovery = { corrupt: true, invalid: 'unparseable JSON', backupPath: this.#backupPath };
      this.current = validateSettings({});
      return this.current;
    }

    try {
      this.current = validateSettings(parsed);
    } catch (err) {
      // One bad value must not cost the user every other setting, but silently
      // "fixing" it would hide the mistake. Fall back to defaults and say why.
      await this.#preserveDamaged();
      this.recovery = { corrupt: true, invalid: err.message, backupPath: this.#backupPath };
      this.current = validateSettings({});
    }
    return this.current;
  }

  get #backupPath() {
    return `${this.filePath}.corrupt`;
  }

  async #preserveDamaged() {
    await fs.copyFile(this.filePath, this.#backupPath).catch(() => {});
  }

  get() {
    return this.current;
  }

  /**
   * Merge a partial update over current settings and persist it.
   *
   * Validation runs before anything is written, so a rejected update leaves
   * both memory and disk on the previous good value.
   */
  async update(partial) {
    const merged = validateSettings({
      ...this.current,
      ...partial,
      capture: { ...this.current.capture, ...(partial?.capture ?? {}) },
      retention: { ...this.current.retention, ...(partial?.retention ?? {}) },
      ui: { ...this.current.ui, ...(partial?.ui ?? {}) },
      privacy: { ...this.current.privacy, ...(partial?.privacy ?? {}) },
    });

    await this.#write(merged);
    this.current = merged;
    return merged;
  }

  /** Restore defaults. Explicit, and still written atomically. */
  async reset() {
    const defaults = validateSettings({});
    await this.#write(defaults);
    this.current = defaults;
    return defaults;
  }

  async #write(settings) {
    const payload = `${JSON.stringify(settings, null, 2)}\n`;
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: DIR_MODE });
      const handle = await fs.open(this.tmpPath, 'w', FILE_MODE);
      try {
        await handle.writeFile(payload, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(this.tmpPath, this.filePath);
    } catch (err) {
      await fs.rm(this.tmpPath, { force: true }).catch(() => {});
      throw new StorageError('could not write settings', {
        reason: err.code ?? err.message.slice(0, 120),
      });
    }
  }
}

export { DEFAULT_SETTINGS, validateSettings };
