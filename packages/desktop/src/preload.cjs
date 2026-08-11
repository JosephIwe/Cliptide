/**
 * Preload bridge for the overlay.
 *
 * CommonJS on purpose: sandboxed preload scripts do not run as ES modules.
 *
 * This exposes exactly four functions and nothing else. The renderer gets no
 * Node, no `require`, no `ipcRenderer`, and no way to name a channel the main
 * process did not intend — every call is a fixed invoke to a fixed channel.
 *
 * Note what is absent: there is no "read payload" call. The renderer cannot
 * ask for clipboard contents because no such bridge exists. `use()` sends an
 * id and the main process does the rest.
 */

const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = {
  LIST: 'cliptide:list',
  SEARCH: 'cliptide:search',
  USE: 'cliptide:use',
  CLOSE: 'cliptide:close',
};

contextBridge.exposeInMainWorld('cliptide', {
  /** Recent history as view models — previews and metadata only. */
  list: (options) => ipcRenderer.invoke(CHANNELS.LIST, options ?? {}),

  /** Ranked search through the engine. Local, no network. */
  search: (query, options) =>
    ipcRenderer.invoke(CHANNELS.SEARCH, { query, ...(options ?? {}) }),

  /** Put an item back on the clipboard. Payload never enters this process. */
  use: (id) => ipcRenderer.invoke(CHANNELS.USE, { id }),

  /** Dismiss without touching the clipboard. */
  close: () => ipcRenderer.invoke(CHANNELS.CLOSE),
});
