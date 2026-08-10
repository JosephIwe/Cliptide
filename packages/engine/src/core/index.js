/**
 * Public surface of the core domain layer.
 *
 * Everything here is pure and dependency-free: no disk, no network, no
 * platform calls. Higher layers import from this barrel rather than reaching
 * into individual files, so the internal file layout stays free to change.
 */

export {
  CliptideError,
  ValidationError,
  StorageError,
  CorruptRecordError,
  CaptureError,
  UnsupportedPlatformError,
} from './errors.js';

export { systemClock, createManualClock } from './clock.js';
export { createIdFactory, nextId, isValidId, timestampFromId, ID_LENGTH } from './ids.js';
export { hashText, hashBytes, hashFiles, blobKey } from './hash.js';
export { classify, maskText, redact, SECRET_LABELS, SCAN_LIMIT_BYTES } from './redact.js';

export {
  CLIP_SCHEMA_VERSION,
  CONTENT_KINDS,
  CONCEALED_MARKERS,
  TEXT_HEAD_CHARS,
  DEFAULT_INLINE_LIMIT_BYTES,
  DEFAULT_PREVIEW_LENGTH,
  isConcealed,
  formatBytes,
  buildPreview,
  createClipItem,
  promoteClipItem,
  validateClipItem,
} from './types.js';
