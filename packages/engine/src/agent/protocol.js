/**
 * The agent boundary.
 *
 * Cliptide is designed so a future agent can take natural-language requests
 * over clipboard history — "the API key I copied this morning", "links from
 * yesterday" — without the clipboard engine ever depending on an AI provider.
 * This file is that seam, and it exists now, unused by any provider, precisely
 * so the coupling can never be introduced casually later.
 *
 * The contract has three parts:
 *
 *   1. **AgentRequest** — what the user asked, in their words.
 *   2. **AgentResolver** — `resolve(request, context) -> AgentPlan`. Any
 *      implementation, local or remote, satisfies this one method.
 *   3. **AgentPlan** — a declarative query. Not an answer, not an action: a
 *      description of what to retrieve, which the executor runs against
 *      HistoryService.
 *
 * The privacy property this shape buys:
 *
 *   **A resolver plans a query without reading clipboard content.** The context
 *   it receives is metadata only — counts, kinds, time bounds, the current
 *   time. Clipboard payloads, previews, and hashes are not in it. So a resolver
 *   backed by a remote model can decide *what to look for* without any copied
 *   text leaving the machine, and the executor — which does touch content —
 *   stays entirely local.
 *
 * A resolver that needs content to do its job would require a new, explicit,
 * user-consented channel. There is deliberately no way to smuggle content
 * through this interface.
 */

import { ValidationError } from '../core/errors.js';
import { CONTENT_KINDS } from '../core/types.js';

export const AGENT_INTENTS = Object.freeze({
  /** Find items matching terms and filters. */
  SEARCH: 'search',
  /** Most recently used items, no query. */
  RECENT: 'recent',
  /** Pinned items only. */
  PINNED: 'pinned',
  /** Describe the history itself rather than its contents. */
  STATS: 'stats',
  /** The request was not understood. Never guessed at. */
  UNKNOWN: 'unknown',
});

const ALL_INTENTS = Object.freeze(Object.values(AGENT_INTENTS));
const ALL_KINDS = Object.freeze(Object.values(CONTENT_KINDS));

/** Hard ceiling on how much a single request can return. */
export const MAX_PLAN_LIMIT = 200;
export const DEFAULT_PLAN_LIMIT = 20;

/**
 * @typedef {Object} AgentPlan
 * @property {string} intent one of AGENT_INTENTS
 * @property {string} query search terms, possibly empty
 * @property {Object} filters
 * @property {string[]|null} filters.kinds
 * @property {boolean} filters.pinnedOnly
 * @property {boolean} filters.includeSensitive
 * @property {number|null} filters.since epoch ms
 * @property {number|null} filters.until epoch ms
 * @property {number} limit
 * @property {string} explanation why the resolver chose this plan, for the UI
 * @property {number} confidence 0..1
 */

/**
 * Build the metadata-only context a resolver is given.
 *
 * Everything here is deliberately non-sensitive. If you find yourself wanting
 * to add previews or payloads, that is the signal to design a consent flow
 * instead.
 */
export function createAgentContext({ history, now }) {
  const items = history.list();
  const kinds = [...new Set(items.map((item) => item.kind))].sort();

  return Object.freeze({
    now,
    historySize: items.length,
    pinnedCount: items.filter((item) => item.pinned).length,
    sensitiveCount: items.filter((item) => item.sensitive).length,
    kinds,
    oldestAt: items.length > 0 ? Math.min(...items.map((item) => item.updatedAt)) : null,
    newestAt: items.length > 0 ? Math.max(...items.map((item) => item.updatedAt)) : null,
    availableIntents: ALL_INTENTS,
    availableKinds: ALL_KINDS,
  });
}

/**
 * Validate and normalize a plan.
 *
 * Plans come from resolvers, and a resolver may be a language model whose
 * output cannot be trusted to be well-formed. Every field is checked and
 * clamped here so a malformed plan becomes an error or a safe value, never an
 * unbounded query.
 */
export function validatePlan(plan) {
  if (!plan || typeof plan !== 'object') {
    throw new ValidationError('agent plan must be an object', { received: typeof plan });
  }
  if (!ALL_INTENTS.includes(plan.intent)) {
    throw new ValidationError('agent plan has an unknown intent', { intent: String(plan.intent) });
  }

  const filters = plan.filters ?? {};

  let kinds = null;
  if (filters.kinds !== null && filters.kinds !== undefined) {
    if (!Array.isArray(filters.kinds)) {
      throw new ValidationError('agent plan filters.kinds must be an array or null', {});
    }
    const unknown = filters.kinds.filter((kind) => !ALL_KINDS.includes(kind));
    if (unknown.length > 0) {
      throw new ValidationError('agent plan names an unknown content kind', { unknown });
    }
    kinds = filters.kinds.length > 0 ? [...filters.kinds] : null;
  }

  const timeBound = (value, field) => {
    if (value === null || value === undefined) return null;
    if (!Number.isFinite(value)) {
      throw new ValidationError(`agent plan filters.${field} must be a timestamp or null`, {
        field,
      });
    }
    return value;
  };

  const since = timeBound(filters.since, 'since');
  const until = timeBound(filters.until, 'until');
  if (since !== null && until !== null && since > until) {
    throw new ValidationError('agent plan time window ends before it starts', { since, until });
  }

  const requested = Number.isFinite(plan.limit) ? Math.floor(plan.limit) : DEFAULT_PLAN_LIMIT;
  // Clamped rather than rejected: an over-eager limit should be reined in, not
  // turned into a failed request the user has to rephrase.
  const limit = Math.min(MAX_PLAN_LIMIT, Math.max(1, requested));

  return {
    intent: plan.intent,
    query: typeof plan.query === 'string' ? plan.query : '',
    filters: {
      kinds,
      pinnedOnly: filters.pinnedOnly === true,
      // Secrets are excluded unless a plan asks for them, so a vague request
      // does not spray credentials across the results.
      includeSensitive: filters.includeSensitive === true,
      since,
      until,
    },
    limit,
    explanation: typeof plan.explanation === 'string' ? plan.explanation : '',
    confidence: Number.isFinite(plan.confidence) ? Math.min(1, Math.max(0, plan.confidence)) : 0,
  };
}

/** Throws unless the object satisfies the AgentResolver contract. */
export function assertResolver(resolver) {
  if (!resolver || typeof resolver.resolve !== 'function') {
    throw new ValidationError('agent resolver must expose resolve()', {
      received: typeof resolver,
    });
  }
  return resolver;
}

/**
 * @typedef {Object} AgentResponse
 * @property {AgentPlan} plan
 * @property {Array<{item: object, score: number, highlights: object[]}>} results
 * @property {object|null} stats populated only for the STATS intent
 * @property {string} explanation
 */

/**
 * Resolve a request into a plan and execute it against history.
 *
 * Execution is entirely local: the resolver decided *what* to look for, and
 * everything that touches clipboard content happens here, on this machine.
 *
 * @param {Object} options
 * @param {{resolve: Function}} options.resolver
 * @param {import('../history/index.js').HistoryService} options.history
 * @param {string} options.request
 * @returns {Promise<AgentResponse>}
 */
export async function runAgentRequest({ resolver, history, request, now = null }) {
  assertResolver(resolver);
  if (typeof request !== 'string') {
    throw new ValidationError('agent request must be a string', { received: typeof request });
  }

  const timestamp = now ?? history.clock.now();
  const context = createAgentContext({ history, now: timestamp });
  const plan = validatePlan(await resolver.resolve(request, context));

  if (plan.intent === AGENT_INTENTS.UNKNOWN) {
    return { plan, results: [], stats: null, explanation: plan.explanation };
  }

  if (plan.intent === AGENT_INTENTS.STATS) {
    return {
      plan,
      results: [],
      stats: await history.stats(),
      explanation: plan.explanation,
    };
  }

  const results = history.search(plan.query, {
    now: timestamp,
    limit: plan.limit,
    kinds: plan.filters.kinds,
    pinnedOnly: plan.intent === AGENT_INTENTS.PINNED || plan.filters.pinnedOnly,
    includeSensitive: plan.filters.includeSensitive,
    since: plan.filters.since,
    until: plan.filters.until,
    pinnedFirst: plan.intent === AGENT_INTENTS.PINNED,
  });

  return { plan, results, stats: null, explanation: plan.explanation };
}
