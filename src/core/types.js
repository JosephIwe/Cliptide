/**
 * The clipboard domain model.
 *
 * A ClipSnapshot is what a platform clipboard source hands us: raw, untrusted,
 * possibly enormous. A ClipItem is the durable, bounded record we keep. This
 * module owns the conversion between them, and it is the only place that
 * decides what gets stored, what gets spilled to a blob, and what a preview
 * looks like.
 *
 * Two rules are enforced here rather than being left to callers:
 *
 *  - Concealed content (password managers) never becomes a ClipItem at all.
 *  - Payloads are bounded. A ClipItem holds at most TEXT_HEAD_CHARS of inline
 *    text no matter how large the clipboard payload was, so history size stays
 *    predictable and the overlay never has to render a 50 MB string.
 */

import { ValidationError } from './errors.js';
import { hashBytes, hashFiles, hashText } from './hash.js';
import { classify, maskText } from './redact.js';
import { isValidId } from './ids.js';

/** Bump only on breaking shape changes; the reader migrates forward. */
export const CLIP_SCHEMA_VERSION = 1;

export const CONTENT_KINDS = Object.freeze({
  TEXT: 'text',
  IMAGE: 'image',
  FILES: 'files',
});

const ALL_KINDS = Object.freeze(Object.values(CONTENT_KINDS));

/**
 * Pasteboard markers that mean "do not record this".
 *
 * Password managers set these precisely so clipboard managers skip their
 * output. Honoring them is the single highest-value privacy behavior in the
 * product, so it runs before hashing, previewing, or storage — concealed
 * content is not merely hidden, it is never processed.
 *
 * Adapters normalize their platform's marker to one of these strings. The
 * Windows `CanIncludeInClipboardHistory` marker is emitted only when its value
 * is 0, and the KDE hint only when it equals `secret`.
 */
export const CONCEALED_MARKERS = Object.freeze([
  'org.nspasteboard.concealedtype',
  'org.nspasteboard.transienttype',
  'excludeclipboardcontentfrommonitorprocessing',
  'canincludeinclipboardhistory=0',
  'x-kde-passwordmanagerhint=secret',
]);

const CONCEALED_SET = new Set(CONCEALED_MARKERS);

/** Inline text kept on a spilled item: enough to search and preview, bounded. */
export const TEXT_HEAD_CHARS = 4096;

/** Text larger than this is spilled to a content-addressed blob. */
export const DEFAULT_INLINE_LIMIT_BYTES = 256 * 1024;

/** Preview length tuned for a single overlay row. */
export const DEFAULT_PREVIEW_LENGTH = 160;

/**
 * @typedef {Object} ClipSnapshot
 * @property {string} kind one of CONTENT_KINDS
 * @property {string} [format] MIME-ish format hint, e.g. 'text/plain'
 * @property {string} [text] payload for kind 'text'
 * @property {Buffer|Uint8Array} [bytes] payload for kind 'image'
 * @property {string[]} [files] payload for kind 'files'
 * @property {string[]} [markers] normalized pasteboard markers
 * @property {string|null} [sourceApp] foreground app at capture time, if known
 */

/**
 * @typedef {Object} ClipItem
 * @property {number} schemaVersion
 * @property {string} id sortable, monotonic
 * @property {string} kind
 * @property {string} format
 * @property {string} hash content fingerprint and dedupe key
 * @property {string|null} text inline text (head only when truncated)
 * @property {string[]|null} files file paths for kind 'files'
 * @property {string|null} blobRef blob address when the payload was spilled
 * @property {boolean} truncated true when `text` is a head, not the whole payload
 * @property {number} bytes full payload size
 * @property {string} preview display string, masked when sensitive
 * @property {number} createdAt first seen, epoch ms
 * @property {number} updatedAt last copied, epoch ms
 * @property {number} copyCount times this content has been copied
 * @property {boolean} pinned exempt from every automatic eviction path
 * @property {boolean} sensitive matched a credential heuristic
 * @property {string[]} secretLabels which heuristics matched
 * @property {string|null} sourceApp
 */

/** True when the snapshot carries a marker meaning "never store this". */
export function isConcealed(snapshot) {
  const markers = snapshot?.markers;
  if (!Array.isArray(markers) || markers.length === 0) return false;
  return markers.some(
    (marker) => typeof marker === 'string' && CONCEALED_SET.has(marker.trim().toLowerCase()),
  );
}

/** Human-readable byte size for previews. */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Collapse a payload into a single display line.
 *
 * Newlines and tabs become spaces, control characters are dropped (a clipboard
 * payload containing ANSI escapes must not be able to reformat the overlay),
 * and the result is capped with an ellipsis.
 */
export function buildPreview(text, maxLength = DEFAULT_PREVIEW_LENGTH) {
  if (typeof text !== 'string') return '';
  const collapsed = text
    // Strip non-whitespace C0/C1 controls: a payload carrying ANSI escapes
    // must not be able to reformat the row it lands in. Whitespace controls
    // (tab, newline, form feed) fall through to the collapse below.
    .replace(/[\u0000-\u0008\u000E-\u001F\u007F-\u009F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength - 1).trimEnd()}…`;
}

function normalizeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new ValidationError('snapshot must be an object', { received: typeof snapshot });
  }
  const { kind } = snapshot;
  if (!ALL_KINDS.includes(kind)) {
    throw new ValidationError('unknown clipboard content kind', { kind: String(kind) });
  }

  if (kind === CONTENT_KINDS.TEXT) {
    if (typeof snapshot.text !== 'string') {
      throw new ValidationError('text snapshot requires a string payload', {
        received: typeof snapshot.text,
      });
    }
    return { ...snapshot, format: snapshot.format || 'text/plain' };
  }

  if (kind === CONTENT_KINDS.IMAGE) {
    if (!ArrayBuffer.isView(snapshot.bytes) && !Buffer.isBuffer(snapshot.bytes)) {
      throw new ValidationError('image snapshot requires a Buffer payload', {
        received: typeof snapshot.bytes,
      });
    }
    return { ...snapshot, format: snapshot.format || 'image/png' };
  }

  if (!Array.isArray(snapshot.files) || snapshot.files.length === 0) {
    throw new ValidationError('files snapshot requires a non-empty path array', {
      count: Array.isArray(snapshot.files) ? snapshot.files.length : 0,
    });
  }
  if (snapshot.files.some((path) => typeof path !== 'string' || path.length === 0)) {
    throw new ValidationError('file paths must be non-empty strings', {
      count: snapshot.files.length,
    });
  }
  return { ...snapshot, format: snapshot.format || 'application/x-file-list' };
}

/**
 * Build a durable ClipItem from a raw snapshot.
 *
 * @param {ClipSnapshot} snapshot
 * @param {Object} options
 * @param {string} options.id
 * @param {number} options.now epoch ms
 * @param {number} [options.inlineLimitBytes]
 * @param {number} [options.previewLength]
 * @returns {{item: ClipItem, payload: {bytes: Buffer}|null}}
 *   `payload` is non-null when the caller must spill to a blob. Returning it
 *   separately keeps the large buffer out of the record the store serializes.
 */
export function createClipItem(snapshot, options) {
  const {
    id,
    now,
    inlineLimitBytes = DEFAULT_INLINE_LIMIT_BYTES,
    previewLength = DEFAULT_PREVIEW_LENGTH,
  } = options ?? {};

  if (!isValidId(id)) throw new ValidationError('createClipItem requires a valid id', {});
  if (!Number.isFinite(now)) throw new ValidationError('createClipItem requires a timestamp', {});
  if (isConcealed(snapshot)) {
    throw new ValidationError('refusing to build an item from concealed content', {});
  }

  const normalized = normalizeSnapshot(snapshot);
  const { kind, format } = normalized;

  const base = {
    schemaVersion: CLIP_SCHEMA_VERSION,
    id,
    kind,
    format,
    createdAt: now,
    updatedAt: now,
    copyCount: 1,
    pinned: false,
    sourceApp: typeof normalized.sourceApp === 'string' ? normalized.sourceApp : null,
  };

  if (kind === CONTENT_KINDS.TEXT) {
    const text = normalized.text;
    const bytes = Buffer.byteLength(text, 'utf8');
    const { sensitive, labels, matches } = classify(text);
    const truncated = bytes > inlineLimitBytes;
    const head = truncated ? text.slice(0, TEXT_HEAD_CHARS) : text;

    // Mask against the head we actually keep, re-classifying so that spans
    // computed on the full text cannot point past the end of the head.
    const previewSource = truncated ? classify(head) : { matches, sensitive };
    const display = previewSource.sensitive ? maskText(head, previewSource.matches) : head;

    return {
      item: {
        ...base,
        hash: hashText(text, format),
        text: head,
        files: null,
        blobRef: truncated ? hashText(text, format) : null,
        truncated,
        bytes,
        preview: buildPreview(display, previewLength),
        sensitive,
        secretLabels: labels,
      },
      payload: truncated ? { bytes: Buffer.from(text, 'utf8') } : null,
    };
  }

  if (kind === CONTENT_KINDS.IMAGE) {
    const buffer = Buffer.isBuffer(normalized.bytes)
      ? normalized.bytes
      : Buffer.from(normalized.bytes.buffer, normalized.bytes.byteOffset, normalized.bytes.byteLength);
    const hash = hashBytes(buffer, format);
    const label = format.split('/')[1]?.toUpperCase() ?? 'Image';
    return {
      item: {
        ...base,
        hash,
        text: null,
        files: null,
        // Binary never lives inline in a JSONL log; images always spill.
        blobRef: hash,
        truncated: true,
        bytes: buffer.byteLength,
        preview: `${label} image · ${formatBytes(buffer.byteLength)}`,
        sensitive: false,
        secretLabels: [],
      },
      payload: { bytes: buffer },
    };
  }

  const files = [...normalized.files];
  const names = files.map((path) => path.split(/[\\/]/).pop() || path);
  const summary = files.length === 1 ? names[0] : `${files.length} files · ${names.join(', ')}`;
  return {
    item: {
      ...base,
      hash: hashFiles(files),
      // Paths stay inline so search matches file names naturally.
      text: files.join('\n'),
      files,
      blobRef: null,
      truncated: false,
      bytes: Buffer.byteLength(files.join('\n'), 'utf8'),
      preview: buildPreview(summary, previewLength),
      sensitive: false,
      secretLabels: [],
    },
    payload: null,
  };
}

/**
 * Record a re-copy of existing content.
 *
 * Re-copying promotes rather than duplicates: the item keeps its identity and
 * creation time, moves to the top of history by `updatedAt`, and counts the
 * copy. Returns a new object; ClipItems are never mutated in place.
 */
export function promoteClipItem(item, now) {
  if (!Number.isFinite(now)) throw new ValidationError('promoteClipItem requires a timestamp', {});
  return { ...item, updatedAt: now, copyCount: item.copyCount + 1 };
}

const REQUIRED_STRINGS = ['id', 'kind', 'format', 'hash', 'preview'];
const REQUIRED_NUMBERS = ['schemaVersion', 'bytes', 'createdAt', 'updatedAt', 'copyCount'];
const REQUIRED_BOOLEANS = ['pinned', 'sensitive', 'truncated'];

/**
 * Validate a ClipItem read back from disk.
 *
 * Corruption-tolerant callers use this to decide whether to keep a record, so
 * it throws with a reason instead of returning a bare false.
 */
export function validateClipItem(item) {
  if (!item || typeof item !== 'object') {
    throw new ValidationError('clip item must be an object', { received: typeof item });
  }
  for (const field of REQUIRED_STRINGS) {
    if (typeof item[field] !== 'string' || item[field].length === 0) {
      throw new ValidationError(`clip item field '${field}' must be a non-empty string`, { field });
    }
  }
  for (const field of REQUIRED_NUMBERS) {
    if (!Number.isFinite(item[field])) {
      throw new ValidationError(`clip item field '${field}' must be a number`, { field });
    }
  }
  for (const field of REQUIRED_BOOLEANS) {
    if (typeof item[field] !== 'boolean') {
      throw new ValidationError(`clip item field '${field}' must be a boolean`, { field });
    }
  }
  if (!isValidId(item.id)) throw new ValidationError('clip item id is malformed', {});
  if (!ALL_KINDS.includes(item.kind)) {
    throw new ValidationError('clip item has unknown kind', { kind: String(item.kind) });
  }
  if (!Array.isArray(item.secretLabels)) {
    throw new ValidationError('clip item secretLabels must be an array', {});
  }
  if (item.kind === CONTENT_KINDS.FILES && !Array.isArray(item.files)) {
    throw new ValidationError('files item must carry a path array', {});
  }
  if (item.bytes < 0 || item.copyCount < 1) {
    throw new ValidationError('clip item has out-of-range counters', {
      bytes: item.bytes,
      copyCount: item.copyCount,
    });
  }
  return item;
}
