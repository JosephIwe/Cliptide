/**
 * Content fingerprinting.
 *
 * The fingerprint is the deduplication key: copying the same thing twice must
 * promote the existing history item rather than create a second one. It is also
 * the blob address for spilled payloads.
 *
 * Each kind is hashed under a distinct domain prefix so a text payload can never
 * collide with an image payload that happens to share bytes. Text is hashed
 * exactly as captured — no trimming, no case folding — because "foo " and "foo"
 * are genuinely different clipboard contents and silently merging them would
 * hand the user back something they did not copy.
 */

import { createHash } from 'node:crypto';
import { ValidationError } from './errors.js';

const ALGORITHM = 'sha256';

function digest(domain, chunks) {
  const hash = createHash(ALGORITHM);
  hash.update(domain);
  hash.update('\0');
  for (const chunk of chunks) {
    hash.update(chunk);
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** Fingerprint a text payload. `format` separates text/plain from text/html. */
export function hashText(text, format = 'text/plain') {
  if (typeof text !== 'string') {
    throw new ValidationError('hashText requires a string', { received: typeof text });
  }
  return digest('text', [format, text]);
}

/** Fingerprint a binary payload (images and any future byte-oriented kind). */
export function hashBytes(bytes, format = 'application/octet-stream') {
  if (!ArrayBuffer.isView(bytes) && !Buffer.isBuffer(bytes)) {
    throw new ValidationError('hashBytes requires a Buffer or TypedArray', {
      received: typeof bytes,
    });
  }
  return digest('bytes', [format, Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength)]);
}

/**
 * Fingerprint a file-path list. Paths are sorted so that copying the same set of
 * files in a different selection order deduplicates correctly.
 */
export function hashFiles(paths) {
  if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string')) {
    throw new ValidationError('hashFiles requires an array of strings', {
      count: Array.isArray(paths) ? paths.length : 0,
    });
  }
  return digest('files', [...paths].sort());
}

/** Address used for a spilled blob. Derived from the content hash alone. */
export function blobKey(hash) {
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
    throw new ValidationError('blobKey requires a sha256 hex digest', {
      length: typeof hash === 'string' ? hash.length : 0,
    });
  }
  return hash;
}
