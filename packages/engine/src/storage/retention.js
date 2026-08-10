/**
 * Retention policy evaluation.
 *
 * Pure and side-effect free: it decides *what* should expire and *why*, and
 * the store decides what to do about it. Keeping the decision separate from
 * the deletion is what makes "never silently destroy user data" checkable —
 * every expiry carries a reason the UI can show and the tests can assert.
 *
 * The one rule that overrides every other: **pinned items never expire.** A
 * pin is the user saying "keep this", and no automatic policy outranks that.
 */

import { ValidationError } from '../core/errors.js';

export const RETENTION_REASONS = Object.freeze({
  MAX_AGE: 'max_age',
  SECRET_MAX_AGE: 'secret_max_age',
  MAX_ITEMS: 'max_items',
  MAX_BYTES: 'max_bytes',
});

/**
 * Defaults chosen to be useful without being a liability: two weeks of history
 * is long enough to be worth searching, and flagged credentials fall out after
 * fifteen minutes because a token you copied an hour ago has no business
 * sitting in a searchable list.
 *
 * `maxTotalBytes` is the primary storage bound — it is what actually protects
 * the disk, because a thousand small snippets cost less than one screenshot.
 * `maxItems` is a secondary guard against an unbounded index, set high enough
 * that users do not silently lose things they expected to still find.
 */
export const DEFAULT_RETENTION = Object.freeze({
  maxItems: 2000,
  maxAgeMinutes: 60 * 24 * 14,
  secretRetentionMinutes: 15,
  maxTotalBytes: 256 * 1024 * 1024,
});

/** `null` disables a limit; anything else must be a positive finite number. */
function normalizeLimit(value, field) {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value <= 0) {
    throw new ValidationError(`retention '${field}' must be a positive number or null`, {
      field,
      value,
    });
  }
  return value;
}

export function normalizeRetention(policy = {}) {
  const merged = { ...DEFAULT_RETENTION, ...policy };
  return {
    maxItems: normalizeLimit(merged.maxItems, 'maxItems'),
    maxAgeMinutes: normalizeLimit(merged.maxAgeMinutes, 'maxAgeMinutes'),
    secretRetentionMinutes: normalizeLimit(merged.secretRetentionMinutes, 'secretRetentionMinutes'),
    maxTotalBytes: normalizeLimit(merged.maxTotalBytes, 'maxTotalBytes'),
  };
}

/**
 * Decide which items to expire.
 *
 * @param {import('../core/types.js').ClipItem[]} items
 * @param {object} policy
 * @param {number} now epoch ms
 * @returns {{expire: Array<{id: string, reason: string}>, kept: number}}
 */
export function evaluateRetention(items, policy, now) {
  if (!Number.isFinite(now)) {
    throw new ValidationError('evaluateRetention requires a timestamp', {});
  }
  const limits = normalizeRetention(policy);

  /** @type {Map<string, string>} id -> first reason it expired */
  const expiring = new Map();
  const expire = (item, reason) => {
    if (item.pinned) return; // The rule that outranks everything.
    if (!expiring.has(item.id)) expiring.set(item.id, reason);
  };

  // Age is measured from last use, not creation: something you re-copy stays
  // fresh, which matches how people actually use a clipboard history.
  for (const item of items) {
    if (item.sensitive && limits.secretRetentionMinutes !== null) {
      if (now - item.updatedAt > limits.secretRetentionMinutes * 60_000) {
        expire(item, RETENTION_REASONS.SECRET_MAX_AGE);
        continue;
      }
    }
    if (limits.maxAgeMinutes !== null && now - item.updatedAt > limits.maxAgeMinutes * 60_000) {
      expire(item, RETENTION_REASONS.MAX_AGE);
    }
  }

  // Newest first; count only what survives the age rules and only unpinned
  // items, so pins never consume a slot the user is trying to keep free.
  const survivors = items
    .filter((item) => !expiring.has(item.id))
    .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1));

  if (limits.maxItems !== null) {
    let counted = 0;
    for (const item of survivors) {
      if (item.pinned) continue;
      counted += 1;
      if (counted > limits.maxItems) expire(item, RETENTION_REASONS.MAX_ITEMS);
    }
  }

  if (limits.maxTotalBytes !== null) {
    let total = 0;
    for (const item of survivors) {
      if (expiring.has(item.id)) continue;
      total += item.bytes;
      if (total > limits.maxTotalBytes && !item.pinned) {
        expire(item, RETENTION_REASONS.MAX_BYTES);
      }
    }
  }

  return {
    expire: [...expiring].map(([id, reason]) => ({ id, reason })),
    kept: items.length - expiring.size,
  };
}
