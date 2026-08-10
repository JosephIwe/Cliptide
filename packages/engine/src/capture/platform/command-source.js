/**
 * A ClipboardSource backed by the platform's command-line clipboard tools.
 *
 * This is the portable fallback source. It works on a stock system with no
 * native modules and no build step, which makes the engine runnable and
 * testable long before a desktop shell exists.
 *
 * It has one honest cost, declared as `cheapToken: false`: without access to a
 * pasteboard sequence number, change detection means reading the clipboard
 * text and hashing it. Reading is capped and the result is cached for the
 * `read()` that immediately follows a token change, so a tick costs one bounded
 * read rather than two.
 *
 * The desktop shell replaces this with a native source implementing the same
 * interface — a real change counter, image support, and reliable
 * concealed-type detection. Nothing above this file changes when it does.
 */

import { hashText } from '../../core/hash.js';
import { CONTENT_KINDS } from '../../core/types.js';
import { runCapture, runWithInput } from '../exec.js';

/** Text beyond this is not captured by the CLI source. */
export const DEFAULT_MAX_TEXT_BYTES = 8 * 1024 * 1024;

/** Token returned when the clipboard holds more than the source will read. */
const OVERSIZED_TOKEN = 'oversized';
const EMPTY_TOKEN = 'empty';

/**
 * @param {Object} spec
 * @param {string} spec.name
 * @param {{command: string, args: string[]}} spec.read
 * @param {{command: string, args: string[]}} spec.write
 * @param {{command: string, args: string[]}} [spec.types]
 *   Lists the pasteboard types currently offered. Only supplied on platforms
 *   where a CLI can report them truthfully.
 * @param {(raw: string) => string[]} [spec.parseMarkers]
 * @param {number} [spec.maxTextBytes]
 * @param {number} [spec.timeoutMs]
 */
export function createCommandTextSource(spec) {
  const {
    name,
    read: readSpec,
    write: writeSpec,
    types: typesSpec,
    parseMarkers,
    maxTextBytes = DEFAULT_MAX_TEXT_BYTES,
    timeoutMs,
    runner = { runCapture, runWithInput },
  } = spec;

  /** Cache bridging changeToken() to the read() that follows it. */
  let cached = { token: null, text: null };

  async function readText() {
    const result = await runner.runCapture(readSpec.command, readSpec.args, {
      maxBytes: maxTextBytes,
      timeoutMs,
    });

    // A non-zero exit generally means "clipboard is empty or holds a type we
    // cannot render as text" — normal, not an error worth backing off over.
    if (result.code !== 0 && result.stdout.length === 0) return { text: '', truncated: false };
    return { text: result.stdout.toString('utf8'), truncated: result.truncated };
  }

  async function readMarkers() {
    if (!typesSpec || !parseMarkers) return [];
    try {
      const result = await runner.runCapture(typesSpec.command, typesSpec.args, {
        maxBytes: 64 * 1024,
        timeoutMs,
      });
      return parseMarkers(result.stdout.toString('utf8'));
    } catch {
      // Type enumeration is advisory. Failing it must not block capture, and
      // must not be mistaken for "no concealed marker present" — the source
      // documents that reliable marker detection needs the native source.
      return [];
    }
  }

  return {
    name,
    cheapToken: false,

    async changeToken() {
      const { text, truncated } = await readText();
      if (truncated) {
        // Deliberately stable: an oversized clipboard yields one skip, not a
        // token that changes every tick and re-reads a huge payload forever.
        cached = { token: OVERSIZED_TOKEN, text: null };
        return OVERSIZED_TOKEN;
      }
      if (text === '') {
        cached = { token: EMPTY_TOKEN, text: null };
        return EMPTY_TOKEN;
      }
      const token = hashText(text);
      cached = { token, text };
      return token;
    },

    async read() {
      // The cache is single-use. The monitor always calls changeToken()
      // immediately before read(), so the hand-off is safe; anything else
      // (a forced captureNow, a resume) reads fresh rather than risking a
      // stale payload.
      const handoff = cached.text;
      cached = { token: cached.token, text: null };

      const text = handoff ?? (await readText()).text;
      if (!text) return null;

      const markers = await readMarkers();
      return {
        kind: CONTENT_KINDS.TEXT,
        format: 'text/plain',
        text,
        markers,
        sourceApp: null,
      };
    },

    async write(snapshot) {
      const text = typeof snapshot === 'string' ? snapshot : (snapshot?.text ?? '');
      await runner.runWithInput(writeSpec.command, writeSpec.args, text, { timeoutMs });
      // Drop the cache: what we just wrote is now the clipboard, and the next
      // changeToken() should observe that from the system, not from memory.
      // The monitor seeing this change and promoting the item is intended —
      // pasting from history should move that entry back to the top.
      cached = { token: null, text: null };
    },
  };
}
