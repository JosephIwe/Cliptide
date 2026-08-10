/**
 * The local resolver: natural-language requests, no AI provider, no network.
 *
 * This is a deterministic rule-based parser. It is not trying to be clever —
 * it is trying to be *predictable*, which for a summon-and-paste overlay is
 * worth more. It handles the phrasings people actually use over their own
 * clipboard history and says so honestly when it does not understand, rather
 * than guessing and returning confident nonsense.
 *
 * It also proves the boundary works: this resolver satisfies the same contract
 * an LLM-backed one would, and the engine cannot tell the difference. Swapping
 * it out is a one-line change at the call site and touches nothing else.
 */

import { AGENT_INTENTS, DEFAULT_PLAN_LIMIT, MAX_PLAN_LIMIT } from './protocol.js';
import { CONTENT_KINDS } from '../core/types.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Words that carry intent rather than search meaning, stripped from the query.
 *
 * Ordering words ("last", "top") are here because the count they qualify is
 * already extracted by parseLimit, and the recency phrasing they signal is
 * matched against the original request — so removing them costs nothing and
 * stops "last 5" from being searched for as literal text.
 */
const STOP_WORDS = new Set([
  // articles, pronouns, prepositions
  'a', 'an', 'the', 'me', 'my', 'mine', 'i', 'it', 'its', 'this', 'these',
  'those', 'for', 'from', 'that', 'which', 'of', 'in', 'on', 'to', 'and',
  'with', 'all', 'any', 'some',
  // interrogatives and auxiliaries
  'what', 'when', 'where', 'who', 'whom', 'how', 'did', 'do', 'does', 'was',
  'were', 'is', 'are', 'have', 'has', 'had', 'can', 'could', 'would',
  // verbs and nouns about the act of copying
  'show', 'find', 'get', 'give', 'search', 'look', 'see', 'copied', 'copy',
  'clipboard', 'history', 'item', 'items', 'thing', 'things', 'stuff',
  'entry', 'entries', 'please',
  // ordering words whose meaning is consumed by parseLimit / RECENT_PATTERN
  'last', 'first', 'top', 'latest', 'recent', 'recently', 'newest', 'oldest',
  'just', 'past', 'previous',
]);

const KIND_PHRASES = [
  { pattern: /\b(?:image|images|picture|pictures|screenshot|screenshots)\b/i, kind: CONTENT_KINDS.IMAGE },
  { pattern: /\b(?:file|files|attachment|attachments)\b/i, kind: CONTENT_KINDS.FILES },
  { pattern: /\b(?:text|texts|snippet|snippets)\b/i, kind: CONTENT_KINDS.TEXT },
];

const PINNED_PATTERN = /\b(?:pinned|pins?|favou?rites?|stars?|starred|saved|bookmarks?)\b/i;
const STATS_PATTERN = /\b(?:stats|statistics|how many|how much|summary|overview|status)\b/i;
const RECENT_PATTERN = /\b(?:recent|recently|latest|last|newest|just)\b/i;
const SECRET_PATTERN = /\b(?:secret|secrets|password|passwords|token|tokens|key|keys|credential|credentials)\b/i;

/** Start of the local day containing `now`, using the host timezone. */
function startOfDay(now) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * Extract a time window from the request.
 * @returns {{since: number|null, until: number|null, matched: string|null}}
 */
export function parseTimeWindow(request, now) {
  const text = request.toLowerCase();

  const relative = text.match(
    /\b(?:last|past|previous)\s+(\d+)?\s*(minute|minutes|hour|hours|day|days|week|weeks)\b/,
  );
  if (relative) {
    const count = relative[1] ? Number.parseInt(relative[1], 10) : 1;
    const unit = relative[2];
    const span =
      unit.startsWith('minute') ? MINUTE : unit.startsWith('hour') ? HOUR : unit.startsWith('day') ? DAY : 7 * DAY;
    return { since: now - count * span, until: null, matched: relative[0] };
  }

  if (/\byesterday\b/.test(text)) {
    const todayStart = startOfDay(now);
    return { since: todayStart - DAY, until: todayStart - 1, matched: 'yesterday' };
  }
  if (/\btoday\b/.test(text)) {
    return { since: startOfDay(now), until: null, matched: 'today' };
  }
  if (/\bthis morning\b/.test(text)) {
    const dayStart = startOfDay(now);
    return { since: dayStart, until: dayStart + 12 * HOUR, matched: 'this morning' };
  }
  if (/\bthis week\b/.test(text)) {
    return { since: startOfDay(now) - 6 * DAY, until: null, matched: 'this week' };
  }

  return { since: null, until: null, matched: null };
}

/** Extract an explicit result count: "last 5", "top 10", "3 links". */
export function parseLimit(request) {
  const match = request
    .toLowerCase()
    .match(/\b(?:last|first|top|latest|recent|newest|show|give me)\s+(\d{1,3})\b/);
  if (match) return Math.min(MAX_PLAN_LIMIT, Math.max(1, Number.parseInt(match[1], 10)));

  const bare = request.toLowerCase().match(/^\s*(\d{1,3})\s+\w/);
  if (bare) return Math.min(MAX_PLAN_LIMIT, Math.max(1, Number.parseInt(bare[1], 10)));

  return null;
}

/** Strip directive words so what remains is a usable search query. */
function extractQuery(request, consumed) {
  let text = request;
  for (const phrase of consumed) {
    if (phrase) text = text.replace(new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), ' ');
  }

  const quoted = [...text.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  if (quoted.length > 0) return quoted.map((phrase) => `"${phrase}"`).join(' ');

  return text
    .toLowerCase()
    // Punctuation that appears inside real clipboard content — URLs, emails,
    // paths — is kept; everything else becomes a separator.
    .replace(/[^\p{L}\p{N}\s@._/:-]/gu, ' ')
    .split(/\s+/)
    .filter(
      (word) =>
        word !== '' &&
        // A token of pure punctuation ("...", "--") is not a search term.
        /[\p{L}\p{N}]/u.test(word) &&
        !STOP_WORDS.has(word) &&
        // A bare small number is a count, already handled by parseLimit.
        !/^\d{1,3}$/.test(word),
    )
    .join(' ')
    .trim();
}

/**
 * Create the local resolver.
 *
 * @param {Object} [options]
 * @param {number} [options.defaultLimit]
 */
export function createLocalResolver({ defaultLimit = DEFAULT_PLAN_LIMIT } = {}) {
  return {
    name: 'local-deterministic',
    /** Declared so callers can assert no provider is in play. */
    usesNetwork: false,
    readsClipboardContent: false,

    /**
     * @param {string} request
     * @param {object} context metadata only — see createAgentContext
     */
    async resolve(request, context) {
      const now = context?.now ?? Date.now();
      const text = String(request ?? '').trim();

      if (text === '') {
        return {
          intent: AGENT_INTENTS.RECENT,
          query: '',
          filters: {},
          limit: defaultLimit,
          explanation: 'No request given, so showing the most recent history.',
          confidence: 1,
        };
      }

      if (STATS_PATTERN.test(text)) {
        return {
          intent: AGENT_INTENTS.STATS,
          query: '',
          filters: {},
          limit: 1,
          explanation: 'Read as a question about the history itself rather than its contents.',
          confidence: 0.8,
        };
      }

      const window = parseTimeWindow(text, now);
      const explicitLimit = parseLimit(text);

      const kinds = [];
      const kindPhrases = [];
      for (const { pattern, kind } of KIND_PHRASES) {
        const match = text.match(pattern);
        if (match) {
          kinds.push(kind);
          kindPhrases.push(match[0]);
        }
      }

      const pinnedOnly = PINNED_PATTERN.test(text);
      // Credentials are only searched when the request names them, so a broad
      // question never surfaces secrets the user was not asking for.
      const includeSensitive = SECRET_PATTERN.test(text);

      const consumed = [
        window.matched,
        ...kindPhrases,
        ...(pinnedOnly ? [text.match(PINNED_PATTERN)?.[0]] : []),
      ].filter(Boolean);
      const query = extractQuery(text, consumed);

      if (pinnedOnly && query === '') {
        return {
          intent: AGENT_INTENTS.PINNED,
          query: '',
          filters: { kinds: kinds.length > 0 ? kinds : null, since: window.since, until: window.until, includeSensitive },
          limit: explicitLimit ?? defaultLimit,
          explanation: 'Read as a request for pinned items.',
          confidence: 0.9,
        };
      }

      const hasFilters = window.matched !== null || kinds.length > 0 || pinnedOnly;

      if (query === '') {
        if (hasFilters || RECENT_PATTERN.test(text)) {
          return {
            intent: AGENT_INTENTS.RECENT,
            query: '',
            filters: {
              kinds: kinds.length > 0 ? kinds : null,
              pinnedOnly,
              since: window.since,
              until: window.until,
              includeSensitive,
            },
            limit: explicitLimit ?? defaultLimit,
            explanation: describe('Showing recent items', { window, kinds, pinnedOnly }),
            confidence: 0.75,
          };
        }

        // Nothing searchable and nothing to filter on. Saying so beats
        // returning everything and calling it an answer.
        return {
          intent: AGENT_INTENTS.UNKNOWN,
          query: '',
          filters: {},
          limit: defaultLimit,
          explanation:
            'No search terms or filters were recognized. Try naming what you copied, or a time like "yesterday".',
          confidence: 0,
        };
      }

      return {
        intent: AGENT_INTENTS.SEARCH,
        query,
        filters: {
          kinds: kinds.length > 0 ? kinds : null,
          pinnedOnly,
          since: window.since,
          until: window.until,
          includeSensitive,
        },
        limit: explicitLimit ?? defaultLimit,
        explanation: describe(`Searching for ${JSON.stringify(query)}`, { window, kinds, pinnedOnly }),
        confidence: 0.7,
      };
    },
  };
}

function describe(lead, { window, kinds, pinnedOnly }) {
  const parts = [lead];
  if (window.matched) parts.push(`from ${window.matched}`);
  if (kinds.length > 0) parts.push(`limited to ${kinds.join(' and ')}`);
  if (pinnedOnly) parts.push('among pinned items');
  return `${parts.join(', ')}.`;
}
