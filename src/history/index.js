/**
 * HistoryService: the one facade the UI and the agent consume.
 *
 * Everything above this line — the overlay, the tray, a CLI, a future agent —
 * talks to this object and nothing else. That is what keeps the UI from
 * reaching into the store's log or the capture loop's internals, and what makes
 * the desktop shell replaceable without touching the engine.
 *
 * The product loop lives here:
 *
 *   Copy    → the monitor writes through ClipStore
 *   Remember→ ClipStore persists and dedupes
 *   Summon  → the shell calls search()
 *   Select  → the shell calls use()
 *   Paste   → use() puts the payload back on the clipboard
 */

import { searchHistory } from '../search/index.js';
import { ValidationError } from '../core/errors.js';

export class HistoryService {
  /**
   * @param {Object} options
   * @param {import('../storage/store.js').ClipStore} options.store
   * @param {import('../capture/source.js').ClipboardSource} [options.source]
   *   Required for use(); omit for a read-only surface.
   * @param {import('../capture/monitor.js').ClipboardMonitor} [options.monitor]
   *   When present, use() re-baselines it so Cliptide does not record its own
   *   paste as a new copy event.
   * @param {import('../settings/store.js').SettingsStore} [options.settings]
   * @param {import('../core/clock.js').Clock} [options.clock]
   */
  constructor({ store, source = null, monitor = null, settings = null, clock = null }) {
    if (!store) throw new ValidationError('HistoryService requires a store', {});
    this.store = store;
    this.source = source;
    this.monitor = monitor;
    this.settings = settings;
    this.clock = clock ?? store.clock;
  }

  #ui() {
    return this.settings?.get().ui ?? { resultLimit: 50, pinnedFirst: true };
  }

  /** History in order, newest use first. */
  list(options = {}) {
    return this.store.list(options);
  }

  /**
   * Ranked search. An empty query returns history in order, which is what an
   * empty search box in the overlay means.
   */
  search(query = '', options = {}) {
    const ui = this.#ui();
    return searchHistory(this.store.all(), query, {
      now: this.clock.now(),
      limit: options.limit ?? ui.resultLimit,
      pinnedFirst: options.pinnedFirst ?? ui.pinnedFirst,
      ...options,
    });
  }

  get(id) {
    return this.store.get(id);
  }

  /**
   * One-action retrieval: put an item back on the clipboard.
   *
   * Reads the complete payload — a spilled blob is resolved, so what lands on
   * the clipboard is what the user copied, never the truncated head. The item
   * is then promoted, because selecting it is a use of it.
   *
   * @returns {Promise<{item: object, bytes: number}>}
   */
  async use(id) {
    const item = this.store.get(id);
    if (!item) throw new ValidationError('no such history item', { id });
    if (!this.source) throw new ValidationError('HistoryService has no clipboard source', {});

    // Resolve before writing: if the payload cannot be read, the clipboard is
    // left holding whatever it had rather than a partial value.
    const payload = await this.store.readPayload(item);

    await this.source.write(
      item.kind === 'image'
        ? { kind: 'image', format: item.format, bytes: payload }
        : { kind: 'text', format: item.format, text: payload },
    );

    // Adopt the new clipboard state before promoting, so the monitor cannot
    // race in and count this paste a second time.
    if (this.monitor) await this.monitor.syncToken();

    const promoted = await this.store.touch(id);
    return { item: promoted ?? item, bytes: item.bytes };
  }

  /** Read a payload without touching the clipboard (preview, agent, export). */
  async readPayload(id) {
    const item = this.store.get(id);
    if (!item) throw new ValidationError('no such history item', { id });
    return this.store.readPayload(item);
  }

  async pin(id) {
    return this.store.pin(id, true);
  }

  async unpin(id) {
    return this.store.pin(id, false);
  }

  async togglePin(id) {
    const item = this.store.get(id);
    if (!item) return null;
    return this.store.pin(id, !item.pinned);
  }

  async delete(id) {
    return this.store.delete(id);
  }

  /** Pins survive unless the user explicitly says otherwise. */
  async clear({ keepPinned = true } = {}) {
    return this.store.clear({ keepPinned });
  }

  /** Apply the configured retention policy. Returns what expired and why. */
  async applyRetention(policy = null) {
    return this.store.applyRetention(policy ?? this.settings?.get().retention ?? {});
  }

  async stats() {
    const stats = await this.store.stats();
    return { ...stats, monitor: this.monitor?.stats ?? null };
  }
}
