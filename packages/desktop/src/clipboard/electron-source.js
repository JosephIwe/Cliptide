/**
 * The Electron-native ClipboardSource.
 *
 * Satisfies the engine's existing `ClipboardSource` contract — changeToken(),
 * read(), write() — so nothing above `capture/source.js` changes when this
 * replaces the CLI scaffolding. The engine does not know Electron exists.
 *
 * WHAT THIS FIXES
 *
 * The scaffolding it replaces spawned a process per poll tick: PowerShell on
 * Windows (~216,000 launches/day at a 400ms interval), pbpaste on macOS. Every
 * call here is an in-process C++ binding. Measured on Electron 43.3.0:
 *
 *   has(format)          ~84 us
 *   availableFormats()   ~29 us
 *   readText()          ~104 us   (typical payload)
 *   readText()         ~2800 us   (1 MB payload)
 *
 * against roughly 200,000-500,000 us for a PowerShell spawn. No child process
 * is created, so there is no process-table churn and no spawn storm.
 *
 * THE CHANGE-DETECTION PROBLEM, STATED HONESTLY
 *
 * Electron 43.3.0's clipboard exposes 20 methods and **none of them report
 * change**. There is no changeCount, no sequence number, no event, and the
 * object is not an EventEmitter. Verified twice: against the shipped
 * `electron.d.ts`, and by enumerating the live object inside a running
 * Electron main process.
 *
 * So an Electron-only implementation must derive a token by reading content.
 * That is a genuine cost — O(payload) per tick — but it is not the thing that
 * made the old sources unshippable; process spawning was. A 104 us read at
 * 400 ms is 0.026% of one core.
 *
 * The fix for the remaining cost is a native change counter
 * (`NSPasteboard.changeCount` / `GetClipboardSequenceNumber`), which is O(1).
 * This source takes one as an injectable `changeCounter` and reports
 * `cheapToken: true` when present, so the addon is a drop-in that changes no
 * other file. It is deliberately NOT implemented yet — see docs/M1-SPIKE.md.
 */

import { createHash } from 'node:crypto';
import { detectConcealedMarkers } from './markers.js';

/** Payloads larger than this are not read into memory by the poll loop. */
export const DEFAULT_MAX_TEXT_BYTES = 8 * 1024 * 1024;

const TOKEN_EMPTY = 'empty';
const TOKEN_OVERSIZED = 'oversized';
const TOKEN_CONCEALED = 'concealed';

/** Bounded fingerprint of the current clipboard, used when no counter exists. */
function contentToken(text) {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * @param {Object} options
 * @param {object} options.clipboard Electron's `clipboard`, or a fake in tests
 * @param {string} [options.platform]
 * @param {() => number} [options.changeCounter] native O(1) change counter when
 *   available; its absence is what forces content-derived tokens
 * @param {number} [options.maxTextBytes]
 * @param {boolean} [options.captureImages]
 */
export function createElectronClipboardSource({
  clipboard,
  platform = process.platform,
  changeCounter = null,
  maxTextBytes = DEFAULT_MAX_TEXT_BYTES,
  captureImages = true,
} = {}) {
  if (!clipboard || typeof clipboard.readText !== 'function') {
    throw new TypeError('createElectronClipboardSource requires an Electron clipboard');
  }

  /** Single-use hand-off from changeToken() to the read() that follows it. */
  let pending = null;

  function readTextBounded() {
    const text = clipboard.readText();
    if (typeof text !== 'string' || text.length === 0) return { text: '', oversized: false };
    // Character length is a cheap upper-bound proxy; a precise byte count would
    // mean encoding the whole payload just to decide whether to skip it.
    if (text.length > maxTextBytes) return { text: '', oversized: true };
    return { text, oversized: false };
  }

  /**
   * Cheap check for an image before touching the decode path.
   *
   * `availableFormats()` costs ~29us and is reliable for standard MIME types
   * (unlike custom markers). Gating on it means the common case — text on the
   * clipboard — never calls readImage() at all.
   */
  function hasImageFormat() {
    try {
      return clipboard.availableFormats().some((f) => f.startsWith('image/'));
    } catch {
      return false;
    }
  }

  /**
   * Probe an image without encoding it.
   *
   * Encoding to PNG on every poll tick would be far more expensive than the
   * text path it replaced, so the token is derived from dimensions and the
   * encode is deferred until the image is actually being captured.
   *
   * LIMITATION: two different images with identical dimensions produce the
   * same token, so swapping between same-size images is not detected. This
   * disappears entirely once a native change counter is supplied, which is the
   * recommended production configuration regardless.
   */
  function probeImage() {
    if (!captureImages || typeof clipboard.readImage !== 'function') return null;
    if (!hasImageFormat()) return null;
    let image;
    try {
      image = clipboard.readImage();
    } catch {
      return null;
    }
    if (!image || (typeof image.isEmpty === 'function' && image.isEmpty())) return null;
    const size = typeof image.getSize === 'function' ? image.getSize() : { width: 0, height: 0 };
    return { image, token: `i${size.width}x${size.height}` };
  }

  /** Encode a probed image. Called only on capture, never on a poll tick. */
  function encodeImage(image) {
    const bytes = image.toPNG();
    if (!bytes || bytes.length === 0) return null;
    return { kind: 'image', format: 'image/png', bytes, markers: [] };
  }

  return {
    name: 'electron-native',

    /** True only once a native change counter is supplied. */
    get cheapToken() {
      return typeof changeCounter === 'function';
    },

    /** Present so the desktop layer can report which mechanism is live. */
    get mechanism() {
      return typeof changeCounter === 'function' ? 'native-change-counter' : 'content-digest';
    },

    async changeToken() {
      // Concealed content short-circuits everything. Checking markers before
      // reading means a password never enters this process's memory at all,
      // and the token stays stable so the loop does not spin on it.
      const markers = detectConcealedMarkers(clipboard, platform);
      if (markers.length > 0) {
        pending = { concealed: true, markers };
        return TOKEN_CONCEALED;
      }

      if (typeof changeCounter === 'function') {
        pending = null;
        return `n${changeCounter()}`;
      }

      const { text, oversized } = readTextBounded();
      if (oversized) {
        pending = null;
        return TOKEN_OVERSIZED;
      }
      if (text === '') {
        // Text is empty but an image may still be present.
        const probed = probeImage();
        if (probed) {
          pending = { image: probed.image };
          return probed.token;
        }
        pending = null;
        return TOKEN_EMPTY;
      }

      pending = { snapshot: { kind: 'text', format: 'text/plain', text, markers: [] } };
      return contentToken(text);
    },

    async read() {
      // The cache is single-use: the monitor always calls changeToken()
      // immediately before read(), but a forced capture must not be served a
      // stale payload.
      const handoff = pending;
      pending = null;

      if (handoff?.concealed) {
        // Surfacing the markers lets the engine refuse this centrally, so the
        // "never record concealed content" rule lives in one place.
        return { kind: 'text', format: 'text/plain', text: '', markers: handoff.markers };
      }
      if (handoff?.snapshot) return handoff.snapshot;
      // The encode is paid here, on capture, not on every poll tick.
      if (handoff?.image) return encodeImage(handoff.image);

      // No hand-off: read fresh, still honouring markers first.
      const markers = detectConcealedMarkers(clipboard, platform);
      if (markers.length > 0) {
        return { kind: 'text', format: 'text/plain', text: '', markers };
      }

      const { text, oversized } = readTextBounded();
      if (oversized) return null;
      if (text !== '') return { kind: 'text', format: 'text/plain', text, markers: [] };

      const probed = probeImage();
      return probed ? encodeImage(probed.image) : null;
    },

    async write(snapshot) {
      if (typeof snapshot === 'string') {
        clipboard.writeText(snapshot);
      } else if (snapshot?.kind === 'image' && snapshot.bytes) {
        if (typeof clipboard.writeImage !== 'function') {
          throw new TypeError('this clipboard cannot write images');
        }
        clipboard.writeImage(snapshot.bytes);
      } else {
        clipboard.writeText(snapshot?.text ?? '');
      }
      // Drop the cache: the clipboard is now what we just wrote, and the next
      // token must observe that from the system rather than from memory.
      pending = null;
    },
  };
}
