/**
 * Ranked search over clipboard history.
 *
 * Pure and synchronous: it takes items and returns ordered results. Search runs
 * on every keystroke in the overlay, so the budget is a few milliseconds over a
 * few thousand items, and the implementation stays a linear scan with bounded
 * per-item work rather than an index that has to be kept in sync with the log.
 *
 * Ranking is deliberately explainable. A user typing "invoice" expects the
 * thing they copied five minutes ago before the one from last week, and a
 * pinned item before either. Every contribution below is a named constant so
 * that behavior can be tuned against complaints rather than guessed at.
 */

const SCORE = Object.freeze({
  EXACT: 120,
  PREFIX: 60,
  WORD_BOUNDARY: 35,
  SUBSTRING: 15,
  PINNED: 40,
  /** Ceiling for the "you use this a lot" contribution. */
  FREQUENCY_MAX: 12,
  /** Ceiling for the "you copied this recently" contribution. */
  RECENCY_MAX: 30,
});

/** Per-item characters considered. Bounds worst-case cost on huge payloads. */
const HAYSTACK_LIMIT = 8192;

/** Recency halves roughly every day; a week-old item keeps a small share. */
const RECENCY_HALF_LIFE_MS = 24 * 60 * 60 * 1000;

function searchableText(item) {
  const source = item.text ?? item.preview ?? '';
  return source.length > HAYSTACK_LIMIT ? source.slice(0, HAYSTACK_LIMIT) : source;
}

function isWordBoundary(haystack, index) {
  if (index === 0) return true;
  return !/[\p{L}\p{N}]/u.test(haystack[index - 1]);
}

/**
 * Score one term against one haystack.
 * @returns {{score: number, index: number}|null} null when the term is absent
 */
function scoreTerm(haystack, term) {
  const index = haystack.indexOf(term);
  if (index === -1) return null;

  if (haystack.length === term.length) return { score: SCORE.EXACT, index };
  if (index === 0) return { score: SCORE.PREFIX, index };
  if (isWordBoundary(haystack, index)) return { score: SCORE.WORD_BOUNDARY, index };
  return { score: SCORE.SUBSTRING, index };
}

function recencyScore(item, now) {
  const age = Math.max(0, now - item.updatedAt);
  return SCORE.RECENCY_MAX * 2 ** (-age / RECENCY_HALF_LIFE_MS);
}

function frequencyScore(item) {
  // Diminishing returns: the difference between 1 and 5 copies matters, the
  // difference between 50 and 100 does not.
  return Math.min(SCORE.FREQUENCY_MAX, Math.log2(item.copyCount + 1) * 4);
}

/** Split a query into lowercase terms. Quoted spans stay together. */
export function parseQuery(query) {
  if (typeof query !== 'string') return [];
  const terms = [];
  const pattern = /"([^"]+)"|(\S+)/g;
  for (const match of query.toLowerCase().matchAll(pattern)) {
    const term = (match[1] ?? match[2]).trim();
    if (term !== '') terms.push(term);
  }
  return terms;
}

/**
 * Merge and sort match ranges so a UI can highlight without double-marking.
 * Offsets index the item's `preview`, which is what the overlay renders.
 */
function highlightRanges(preview, terms) {
  const lowered = preview.toLowerCase();
  const ranges = [];

  for (const term of terms) {
    let from = 0;
    for (;;) {
      const index = lowered.indexOf(term, from);
      if (index === -1) break;
      ranges.push({ start: index, end: index + term.length });
      from = index + term.length;
    }
  }

  ranges.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/**
 * @typedef {Object} SearchResult
 * @property {import('../core/types.js').ClipItem} item
 * @property {number} score
 * @property {Array<{start: number, end: number}>} highlights offsets into `item.preview`
 */

/**
 * Search history.
 *
 * All terms must match (AND); a query nobody typed — empty or whitespace —
 * returns history in order rather than nothing, because an empty search box in
 * the overlay means "show me everything".
 *
 * @param {import('../core/types.js').ClipItem[]} items
 * @param {string} query
 * @param {Object} [options]
 * @param {number} [options.now] epoch ms, for recency scoring
 * @param {number} [options.limit]
 * @param {string[]} [options.kinds]
 * @param {boolean} [options.pinnedOnly]
 * @param {boolean} [options.includeSensitive] default true
 * @param {boolean} [options.pinnedFirst] force pins above all results
 * @returns {SearchResult[]}
 */
export function searchHistory(items, query, options = {}) {
  const {
    now = Date.now(),
    limit = Infinity,
    kinds = null,
    pinnedOnly = false,
    includeSensitive = true,
    pinnedFirst = false,
  } = options;

  const terms = parseQuery(query);

  let candidates = items;
  if (pinnedOnly) candidates = candidates.filter((item) => item.pinned);
  if (kinds) candidates = candidates.filter((item) => kinds.includes(item.kind));
  if (!includeSensitive) candidates = candidates.filter((item) => !item.sensitive);

  const results = [];

  for (const item of candidates) {
    let score = 0;

    if (terms.length > 0) {
      const haystack = searchableText(item).toLowerCase();
      let matchedAll = true;
      for (const term of terms) {
        const termScore = scoreTerm(haystack, term);
        if (!termScore) {
          matchedAll = false;
          break;
        }
        score += termScore.score;
      }
      if (!matchedAll) continue;
    }

    if (item.pinned) score += SCORE.PINNED;
    score += recencyScore(item, now);
    score += frequencyScore(item);

    results.push({
      item,
      score,
      highlights: terms.length > 0 ? highlightRanges(item.preview, terms) : [],
    });
  }

  results.sort((a, b) => {
    if (pinnedFirst && a.item.pinned !== b.item.pinned) return a.item.pinned ? -1 : 1;
    if (b.score !== a.score) return b.score - a.score;
    if (b.item.updatedAt !== a.item.updatedAt) return b.item.updatedAt - a.item.updatedAt;
    // Ids are sortable and unique, so ordering is total and stable.
    return a.item.id < b.item.id ? 1 : -1;
  });

  return limit === Infinity ? results : results.slice(0, limit);
}

export const SEARCH_SCORES = SCORE;
