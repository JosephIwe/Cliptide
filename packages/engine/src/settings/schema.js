/**
 * Settings schema, defaults, and validation.
 *
 * Two rules govern this file:
 *
 *  - **Defaults are safe.** A user who never opens settings gets private,
 *    bounded, quiet behavior: secrets masked and short-lived, history capped,
 *    nothing leaving the machine.
 *  - **Unknown keys survive.** A settings file written by a newer version must
 *    not lose its unrecognized fields when an older version saves over it.
 *    Silently discarding user configuration is the same class of bug as
 *    silently discarding user data.
 */

import { ValidationError } from '../core/errors.js';
import { DEFAULT_RETENTION } from '../storage/retention.js';
import { SECRET_POLICIES, DEFAULT_MAX_ITEM_BYTES } from '../storage/store.js';
import { DEFAULT_INLINE_LIMIT_BYTES, DEFAULT_PREVIEW_LENGTH } from '../core/types.js';
import { DEFAULT_POLL_INTERVAL_MS } from '../capture/monitor.js';

export const SETTINGS_SCHEMA_VERSION = 1;

/** The summon shortcut. Chosen to avoid the common OS and editor bindings. */
export const DEFAULT_SUMMON_SHORTCUT = 'CommandOrControl+Shift+V';

export const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: SETTINGS_SCHEMA_VERSION,

  capture: Object.freeze({
    enabled: true,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    captureOnStart: true,
    maxItemBytes: DEFAULT_MAX_ITEM_BYTES,
    inlineLimitBytes: DEFAULT_INLINE_LIMIT_BYTES,
    secretPolicy: SECRET_POLICIES.MARK,
  }),

  retention: Object.freeze({ ...DEFAULT_RETENTION }),

  ui: Object.freeze({
    summonShortcut: DEFAULT_SUMMON_SHORTCUT,
    previewLength: DEFAULT_PREVIEW_LENGTH,
    resultLimit: 50,
    pinnedFirst: true,
    theme: 'system',
  }),

  privacy: Object.freeze({
    maskSensitivePreviews: true,
    // Present, false, and load-bearing: the engine has no network client, and
    // this flag exists so enabling sync is a visible, auditable change rather
    // than a silent default.
    allowNetwork: false,
  }),
});

const THEMES = Object.freeze(['system', 'light', 'dark']);

function requireType(value, expected, field) {
  if (typeof value !== expected) {
    throw new ValidationError(`setting '${field}' must be a ${expected}`, {
      field,
      received: typeof value,
    });
  }
  return value;
}

function requirePositive(value, field, { allowNull = false } = {}) {
  if (allowNull && value === null) return null;
  if (!Number.isFinite(value) || value <= 0) {
    throw new ValidationError(`setting '${field}' must be a positive number`, { field, value });
  }
  return value;
}

function requireOneOf(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw new ValidationError(`setting '${field}' must be one of ${allowed.join(', ')}`, {
      field,
      value: String(value),
    });
  }
  return value;
}

/**
 * An Electron-style accelerator: zero or more modifiers then exactly one key.
 * Validated here so a typo surfaces in settings rather than as a shortcut that
 * silently never fires.
 */
const MODIFIERS = new Set([
  'command',
  'cmd',
  'control',
  'ctrl',
  'commandorcontrol',
  'cmdorctrl',
  'alt',
  'option',
  'altgr',
  'shift',
  'super',
  'meta',
]);

export function validateShortcut(accelerator, field = 'ui.summonShortcut') {
  requireType(accelerator, 'string', field);
  const parts = accelerator.split('+').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    throw new ValidationError(`setting '${field}' must not be empty`, { field });
  }

  const keys = parts.filter((part) => !MODIFIERS.has(part.toLowerCase()));
  if (keys.length !== 1) {
    throw new ValidationError(
      `setting '${field}' must name exactly one non-modifier key`,
      { field, value: accelerator, keys: keys.length },
    );
  }
  return parts.join('+');
}

/**
 * Merge a partial settings object over the defaults and validate the result.
 *
 * Unknown top-level and section keys are preserved untouched.
 *
 * @param {object} [partial]
 * @returns {object} a complete, validated settings object
 */
export function validateSettings(partial = {}) {
  if (partial === null || typeof partial !== 'object' || Array.isArray(partial)) {
    throw new ValidationError('settings must be an object', { received: typeof partial });
  }

  const merged = {
    ...partial,
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    capture: { ...DEFAULT_SETTINGS.capture, ...(partial.capture ?? {}) },
    retention: { ...DEFAULT_SETTINGS.retention, ...(partial.retention ?? {}) },
    ui: { ...DEFAULT_SETTINGS.ui, ...(partial.ui ?? {}) },
    privacy: { ...DEFAULT_SETTINGS.privacy, ...(partial.privacy ?? {}) },
  };

  requireType(merged.capture.enabled, 'boolean', 'capture.enabled');
  requireType(merged.capture.captureOnStart, 'boolean', 'capture.captureOnStart');
  requirePositive(merged.capture.pollIntervalMs, 'capture.pollIntervalMs');
  requirePositive(merged.capture.maxItemBytes, 'capture.maxItemBytes', { allowNull: true });
  requirePositive(merged.capture.inlineLimitBytes, 'capture.inlineLimitBytes');
  requireOneOf(merged.capture.secretPolicy, Object.values(SECRET_POLICIES), 'capture.secretPolicy');

  if (merged.capture.pollIntervalMs < 50) {
    throw new ValidationError('capture.pollIntervalMs below 50ms would burn CPU for no benefit', {
      field: 'capture.pollIntervalMs',
      value: merged.capture.pollIntervalMs,
    });
  }

  for (const field of ['maxItems', 'maxAgeMinutes', 'secretRetentionMinutes', 'maxTotalBytes']) {
    requirePositive(merged.retention[field], `retention.${field}`, { allowNull: true });
  }

  merged.ui.summonShortcut = validateShortcut(merged.ui.summonShortcut);
  requirePositive(merged.ui.previewLength, 'ui.previewLength');
  requirePositive(merged.ui.resultLimit, 'ui.resultLimit');
  requireType(merged.ui.pinnedFirst, 'boolean', 'ui.pinnedFirst');
  requireOneOf(merged.ui.theme, THEMES, 'ui.theme');

  requireType(merged.privacy.maskSensitivePreviews, 'boolean', 'privacy.maskSensitivePreviews');
  requireType(merged.privacy.allowNetwork, 'boolean', 'privacy.allowNetwork');

  return merged;
}
