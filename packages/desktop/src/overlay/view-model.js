/**
 * The renderer's view of a clipboard item.
 *
 * This module is the privacy boundary between the engine and the overlay UI.
 * A ClipItem carries the payload — `text`, `files`, `blobRef`, `hash`. None of
 * that crosses into the renderer process. The overlay only ever receives what
 * it needs to *identify* an item: a bounded preview the engine already masked,
 * its kind, age, and flags.
 *
 * Two consequences worth stating, because they are the point:
 *
 *  - A renderer compromise cannot exfiltrate clipboard history. There is
 *    nothing to exfiltrate; the payload never arrives.
 *  - Large items cost the same as small ones. A 40 MB image and a one-word
 *    snippet both become a short preview string, so the overlay stays fast
 *    regardless of what is in history.
 *
 * CONCEALED vs SENSITIVE — easy to conflate, so:
 *
 *  - **Concealed** is password-manager content. The engine refuses it at
 *    `store.add()`, so it is never persisted and can never reach this module.
 *    There is no filter here because there is nothing to filter.
 *  - **Sensitive** is credential-*shaped* content the user copied themselves.
 *    It IS stored, and its preview was already masked by the engine. It
 *    appears in the overlay, flagged, with the masked preview — never the raw
 *    value.
 */

/** Fields that must never cross into the renderer. */
const PAYLOAD_FIELDS = Object.freeze(['text', 'files', 'blobRef', 'hash']);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Compact relative age. Kept terse because the overlay is a utility strip,
 * not a report: "3m", "2h", "5d".
 */
export function relativeAge(updatedAt, now) {
  const elapsed = Math.max(0, now - updatedAt);
  if (elapsed < MINUTE) return 'now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  return `${Math.floor(elapsed / DAY)}d`;
}

/** Short, human label for the content kind. */
export function kindLabel(kind) {
  if (kind === 'image') return 'image';
  if (kind === 'files') return 'files';
  return 'text';
}

/**
 * Project a ClipItem into the renderer's view model.
 *
 * @param {object} item a validated ClipItem from the engine
 * @param {number} now epoch ms
 */
export function toOverlayItem(item, now) {
  return {
    id: item.id,
    kind: item.kind,
    kindLabel: kindLabel(item.kind),
    // Already bounded and (when sensitive) masked by the engine.
    preview: item.preview,
    updatedAt: item.updatedAt,
    relativeAge: relativeAge(item.updatedAt, now),
    pinned: item.pinned === true,
    sensitive: item.sensitive === true,
    bytes: item.bytes,
  };
}

export function toOverlayItems(items, now) {
  return items.map((item) => toOverlayItem(item, now));
}

/**
 * Assert a view model carries no payload.
 *
 * Used by the IPC layer as a last line of defence: if someone widens
 * toOverlayItem later, this throws rather than quietly shipping clipboard
 * contents to the renderer.
 */
export function assertNoPayload(viewModel) {
  for (const field of PAYLOAD_FIELDS) {
    if (field in viewModel) {
      throw new Error(`overlay view model must not carry '${field}'`);
    }
  }
  return viewModel;
}

export { PAYLOAD_FIELDS };
