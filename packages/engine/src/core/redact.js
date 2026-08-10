/**
 * Sensitive-content classification and masking.
 *
 * A clipboard manager sees every password and token a user copies. Cliptide
 * cannot reliably know what is secret, but it can recognize the shapes that are
 * almost always secret, and it can refuse to render those in a preview that sits
 * on screen in an overlay.
 *
 * What this module is:  a heuristic that reduces shoulder-surfing exposure and
 *                       feeds a stricter retention policy.
 * What it is not:       a guarantee. It will miss secrets that have no
 *                       recognizable shape, and it will occasionally flag
 *                       something harmless. Flagging never deletes anything by
 *                       itself — it masks the preview and, if the user opted in,
 *                       shortens retention.
 *
 * Scanning is bounded (SCAN_LIMIT_BYTES) so pasting a 50 MB file into the
 * clipboard cannot stall the background monitor.
 */

/** Only the first 64 KiB of a payload is scanned. Secrets are not 64 KiB in. */
export const SCAN_LIMIT_BYTES = 64 * 1024;

export const SECRET_LABELS = Object.freeze({
  PRIVATE_KEY: 'private_key',
  AWS_ACCESS_KEY: 'aws_access_key',
  GITHUB_TOKEN: 'github_token',
  SLACK_TOKEN: 'slack_token',
  STRIPE_KEY: 'stripe_key',
  GOOGLE_API_KEY: 'google_api_key',
  AI_PROVIDER_KEY: 'ai_provider_key',
  JWT: 'jwt',
  CREDENTIAL_ASSIGNMENT: 'credential_assignment',
  PAYMENT_CARD: 'payment_card',
});

/**
 * Luhn checksum. Applied to digit runs so that ordinary long numbers — order
 * ids, phone numbers, timestamps — are not reported as card numbers.
 */
function passesLuhn(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let value = digits.charCodeAt(i) - 48;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Pattern table.
 *
 * `group` selects which capture group's span is masked — for assignments we
 * mask the value and keep the `password=` label visible, which is far more
 * useful in a preview than a fully blacked-out line.
 */
const PATTERNS = [
  {
    label: SECRET_LABELS.PRIVATE_KEY,
    re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|$)/gd,
  },
  { label: SECRET_LABELS.AWS_ACCESS_KEY, re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/gd },
  { label: SECRET_LABELS.GITHUB_TOKEN, re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/gd },
  { label: SECRET_LABELS.SLACK_TOKEN, re: /\bxox[baprse]-[A-Za-z0-9-]{10,}/gd },
  { label: SECRET_LABELS.STRIPE_KEY, re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/gd },
  { label: SECRET_LABELS.GOOGLE_API_KEY, re: /\bAIza[0-9A-Za-z_-]{35}\b/gd },
  { label: SECRET_LABELS.AI_PROVIDER_KEY, re: /\bsk-(?:ant-|proj-|or-)?[A-Za-z0-9](?:[A-Za-z0-9_-]{18,})\b/gd },
  {
    label: SECRET_LABELS.JWT,
    re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gd,
  },
  {
    label: SECRET_LABELS.CREDENTIAL_ASSIGNMENT,
    re: /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|bearer)\b["']?\s*[:=]\s*["']?([^\s"',;]{4,})/gid,
    group: 1,
  },
  {
    label: SECRET_LABELS.PAYMENT_CARD,
    re: /\b(?:\d[ -]?){12,18}\d\b/gd,
    validate: (match) => {
      const digits = match.replace(/[^0-9]/g, '');
      return digits.length >= 13 && digits.length <= 19 && passesLuhn(digits);
    },
  },
];

/**
 * @typedef {Object} SecretMatch
 * @property {string} label one of SECRET_LABELS
 * @property {number} start inclusive index into the scanned text
 * @property {number} end exclusive index into the scanned text
 */

/**
 * Classify a text payload.
 *
 * @param {string} text
 * @returns {{sensitive: boolean, labels: string[], matches: SecretMatch[], scannedBytes: number}}
 */
export function classify(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { sensitive: false, labels: [], matches: [], scannedBytes: 0 };
  }

  // Slice by characters against the byte budget. Over-slicing is harmless; the
  // point is only to bound the work, not to hit exactly 64 KiB.
  const scanned = text.length > SCAN_LIMIT_BYTES ? text.slice(0, SCAN_LIMIT_BYTES) : text;

  /** @type {SecretMatch[]} */
  const matches = [];
  const labels = new Set();

  for (const pattern of PATTERNS) {
    // Fresh regex per scan: `lastIndex` on a shared global regex is a classic
    // source of intermittently-skipped matches.
    const re = new RegExp(pattern.re.source, pattern.re.flags);
    for (const match of scanned.matchAll(re)) {
      if (pattern.validate && !pattern.validate(match[0])) continue;
      const groupIndex = pattern.group ?? 0;
      const span = match.indices?.[groupIndex] ?? match.indices?.[0];
      if (!span) continue;
      matches.push({ label: pattern.label, start: span[0], end: span[1] });
      labels.add(pattern.label);
    }
  }

  matches.sort((a, b) => a.start - b.start || a.end - b.end);

  return {
    sensitive: matches.length > 0,
    labels: [...labels].sort(),
    matches,
    scannedBytes: scanned.length,
  };
}

/** Merge overlapping/adjacent spans so masking never double-substitutes. */
function mergeSpans(matches) {
  const merged = [];
  for (const match of matches) {
    const last = merged[merged.length - 1];
    if (last && match.start <= last.end) {
      last.end = Math.max(last.end, match.end);
    } else {
      merged.push({ start: match.start, end: match.end });
    }
  }
  return merged;
}

const MASK_CHARACTER = '•';
const MASK_WIDTH = 8;
/** Spans longer than this keep a short leading hint so the user can tell keys apart. */
const HINT_THRESHOLD = 12;
const HINT_LENGTH = 4;

/**
 * Replace detected secret spans with bullets.
 *
 * Long spans keep a 4-character leading hint (`sk-a••••••••`) so a user with
 * several keys in history can still tell them apart; short spans are masked
 * whole, since a hint would reveal too large a fraction of them.
 *
 * Masking is a display transformation only. The stored payload is untouched and
 * the real value is always retrievable — this project never silently destroys
 * what the user copied.
 */
export function maskText(text, matches) {
  if (!matches || matches.length === 0) return text;

  const spans = mergeSpans(matches);
  let out = '';
  let cursor = 0;

  for (const span of spans) {
    const start = Math.max(cursor, span.start);
    if (start > cursor) out += text.slice(cursor, start);
    if (span.end <= start) continue;

    const length = span.end - start;
    if (length > HINT_THRESHOLD) {
      out += text.slice(start, start + HINT_LENGTH);
    }
    out += MASK_CHARACTER.repeat(MASK_WIDTH);
    cursor = span.end;
  }

  if (cursor < text.length) out += text.slice(cursor);
  return out;
}

/** Convenience: classify and mask in one pass. */
export function redact(text) {
  const result = classify(text);
  return { ...result, masked: result.sensitive ? maskText(text, result.matches) : text };
}
