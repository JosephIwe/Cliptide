/**
 * IPC handlers bridging the overlay renderer to the engine.
 *
 * Built as a plain handler map so it can be exercised without Electron. The
 * main process registers these against `ipcMain.handle`; the tests call them
 * directly, which is why the privacy properties below are actually asserted
 * rather than assumed.
 *
 * Every response is passed through `assertNoPayload`. Clipboard content does
 * not cross this boundary — the renderer receives previews and metadata only,
 * and `use()` is executed *in the main process* so the payload never travels
 * to the UI even at paste time.
 */

import { toOverlayItems, assertNoPayload } from './overlay/view-model.js';

export const IPC_CHANNELS = Object.freeze({
  LIST: 'cliptide:list',
  SEARCH: 'cliptide:search',
  USE: 'cliptide:use',
  CLOSE: 'cliptide:close',
});

/** Overlay is a utility strip; more rows than this is a scroll, not a feature. */
export const DEFAULT_OVERLAY_LIMIT = 50;

/**
 * @param {Object} options
 * @param {import('@cliptide/engine').HistoryService} options.history
 * @param {() => number} [options.now]
 * @param {() => void} [options.onClose] hide the overlay
 * @param {(result: object) => void} [options.onUsed] called after a successful use
 */
export function createIpcHandlers({ history, now = () => Date.now(), onClose = () => {}, onUsed = () => {} }) {
  if (!history) throw new TypeError('createIpcHandlers requires a HistoryService');

  const project = (items) => toOverlayItems(items, now()).map(assertNoPayload);

  return {
    /**
     * Recent history, newest use first.
     *
     * Concealed content cannot appear here: the engine refuses it at
     * `store.add()`, so it was never persisted. There is no filter to apply.
     */
    [IPC_CHANNELS.LIST]: async ({ limit = DEFAULT_OVERLAY_LIMIT } = {}) => {
      return project(history.list({ limit }));
    },

    /**
     * Ranked search through the engine's own search — not a second
     * implementation. Local, synchronous, no network.
     */
    [IPC_CHANNELS.SEARCH]: async ({ query = '', limit = DEFAULT_OVERLAY_LIMIT } = {}) => {
      const trimmed = typeof query === 'string' ? query : '';
      // An empty query means "show me everything", which is what the engine
      // already does — so clearing the box restores recent history for free.
      if (trimmed.trim() === '') return project(history.list({ limit }));
      return project(history.search(trimmed, { limit }).map((result) => result.item));
    },

    /**
     * Put an item back on the clipboard.
     *
     * Runs entirely in the main process: the renderer sends an id and receives
     * a boolean. The payload is read from storage and written to the OS
     * clipboard without ever entering the UI process.
     */
    [IPC_CHANNELS.USE]: async ({ id } = {}) => {
      if (typeof id !== 'string' || id === '') {
        return { ok: false, reason: 'missing_id' };
      }
      // An unknown id is a normal outcome — the item may have been expired by
      // retention while the overlay was open.
      if (!history.get(id)) {
        return { ok: false, reason: 'not_found' };
      }
      try {
        const result = await history.use(id);
        onUsed(result);
        // Deliberately no payload, no preview, no length in the response.
        return { ok: true, kind: result.item.kind };
      } catch (err) {
        return { ok: false, reason: err?.kind ?? 'use_failed' };
      }
    },

    [IPC_CHANNELS.CLOSE]: async () => {
      onClose();
      return { ok: true };
    },
  };
}
