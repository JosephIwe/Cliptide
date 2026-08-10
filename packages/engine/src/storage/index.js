/**
 * Public surface of the storage layer.
 *
 * Higher layers depend on ClipStore, not on the log or blob primitives. That
 * is what keeps a future swap of the durability mechanism from reaching the
 * capture engine, the UI, or the agent.
 */

export { ClipStore, OPS, SKIP_REASONS, SECRET_POLICIES, DEFAULT_MAX_ITEM_BYTES } from './store.js';
export { AppendLog } from './log.js';
export { BlobStore } from './blobs.js';
export {
  evaluateRetention,
  normalizeRetention,
  DEFAULT_RETENTION,
  RETENTION_REASONS,
} from './retention.js';
export {
  resolveDataDir,
  resolvePaths,
  APP_NAME,
  DIR_MODE,
  FILE_MODE,
  HISTORY_FILE,
  SETTINGS_FILE,
  BLOB_DIR,
} from './paths.js';
