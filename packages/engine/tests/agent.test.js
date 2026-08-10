import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  AGENT_INTENTS,
  MAX_PLAN_LIMIT,
  createAgentContext,
  validatePlan,
  assertResolver,
  runAgentRequest,
} from '../src/agent/protocol.js';
import { createLocalResolver, parseLimit, parseTimeWindow } from '../src/agent/local.js';
import { HistoryService } from '../src/history/index.js';
import { ClipStore } from '../src/storage/store.js';
import { SettingsStore } from '../src/settings/store.js';
import { createManualClock } from '../src/core/clock.js';
import { createIdFactory } from '../src/core/ids.js';
import { tempDir, textSnapshot } from './helpers/tempdir.js';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

async function harness(t) {
  const dataDir = await tempDir(t);
  // Anchored mid-afternoon so "today" and "yesterday" are unambiguous.
  const clock = createManualClock(new Date('2026-08-10T15:00:00').getTime());
  const store = await ClipStore.open({ dataDir, clock, idFactory: createIdFactory({ clock }) });
  const settings = await SettingsStore.open(path.join(dataDir, 'settings.json'));
  const history = new HistoryService({ store, settings, clock });
  t.after(() => store.close());
  return { history, store, settings, clock };
}

/** Add an item as though it were copied `agoMs` before now. */
async function addAt(store, clock, text, agoMs = 0, mutate = null) {
  const real = clock.now();
  clock.jump(-agoMs);
  const { item } = await store.add(textSnapshot(text));
  clock.jump(agoMs);
  if (mutate) await mutate(item);
  assert.equal(clock.now(), real);
  return item;
}

const resolver = createLocalResolver();

async function plan(request, context = { now: Date.now() }) {
  return validatePlan(await resolver.resolve(request, context));
}

test('the resolver declares that it uses no network and reads no content', () => {
  assert.equal(resolver.usesNetwork, false);
  assert.equal(resolver.readsClipboardContent, false);
});

test('the resolver context carries metadata and no clipboard content', async (t) => {
  const { history, store, clock } = await harness(t);
  await addAt(store, clock, 'a very secret AKIAIOSFODNN7EXAMPLE value');
  await addAt(store, clock, 'ordinary note');

  const context = createAgentContext({ history, now: clock.now() });
  const serialized = JSON.stringify(context);

  assert.equal(context.historySize, 2);
  assert.equal(context.sensitiveCount, 1);
  assert.deepEqual(context.kinds, ['text']);
  assert.ok(context.newestAt >= context.oldestAt);

  // The load-bearing assertion: a remote resolver could receive this object
  // without any copied text leaving the machine.
  assert.ok(!serialized.includes('AKIAIOSFODNN7EXAMPLE'), 'no payload');
  assert.ok(!serialized.includes('ordinary note'), 'no preview');
  for (const item of history.list()) {
    assert.ok(!serialized.includes(item.hash), 'not even a content hash');
  }
});

test('an empty request shows recent history rather than failing', async () => {
  const result = await plan('');
  assert.equal(result.intent, AGENT_INTENTS.RECENT);
  assert.equal(result.confidence, 1);
});

test('a request naming what was copied becomes a search', async () => {
  const result = await plan('find the invoice I copied');

  assert.equal(result.intent, AGENT_INTENTS.SEARCH);
  assert.equal(result.query, 'invoice');
  assert.match(result.explanation, /invoice/);
});

test('quoted phrases survive into the query', async () => {
  const result = await plan('show me "acme corp" from yesterday');
  assert.equal(result.query, '"acme corp"');
});

test('pinned phrasings resolve to the pinned intent', async () => {
  for (const request of ['show my pinned items', 'favourites', 'what did I star', 'saved']) {
    const result = await plan(request);
    assert.ok(
      result.intent === AGENT_INTENTS.PINNED || result.filters.pinnedOnly,
      `"${request}" should target pins, got ${result.intent}`,
    );
  }
});

test('a statistics question resolves to the stats intent', async () => {
  for (const request of ['how many items do I have', 'clipboard stats', 'give me a summary']) {
    assert.equal((await plan(request)).intent, AGENT_INTENTS.STATS, request);
  }
});

test('content kinds are recognized', async () => {
  assert.deepEqual((await plan('show me images')).filters.kinds, ['image']);
  assert.deepEqual((await plan('files I copied')).filters.kinds, ['files']);
  assert.deepEqual((await plan('recent snippets')).filters.kinds, ['text']);
  assert.equal((await plan('find the invoice')).filters.kinds, null);
});

test('relative time windows are parsed', () => {
  const now = new Date('2026-08-10T15:00:00').getTime();

  assert.equal(parseTimeWindow('last 2 hours', now).since, now - 2 * HOUR);
  assert.equal(parseTimeWindow('in the past 30 minutes', now).since, now - 30 * 60_000);
  assert.equal(parseTimeWindow('last 3 days', now).since, now - 3 * DAY);
  assert.equal(parseTimeWindow('last week', now).since, now - 7 * DAY);
  assert.equal(parseTimeWindow('last hour', now).since, now - HOUR, 'a bare unit means one');
  assert.equal(parseTimeWindow('nothing temporal here', now).matched, null);
});

test('named days are parsed against the local day boundary', () => {
  const now = new Date('2026-08-10T15:00:00').getTime();
  const dayStart = new Date('2026-08-10T00:00:00').getTime();

  assert.equal(parseTimeWindow('today', now).since, dayStart);
  assert.equal(parseTimeWindow('yesterday', now).since, dayStart - DAY);
  assert.equal(parseTimeWindow('yesterday', now).until, dayStart - 1, 'yesterday ends at midnight');
  assert.equal(parseTimeWindow('this morning', now).until, dayStart + 12 * HOUR);
  assert.equal(parseTimeWindow('this week', now).since, dayStart - 6 * DAY);
});

test('an explicit count becomes the plan limit and is clamped', async () => {
  assert.equal(parseLimit('last 5 things'), 5);
  assert.equal(parseLimit('top 10'), 10);
  assert.equal(parseLimit('3 links I copied'), 3);
  assert.equal(parseLimit('no number here'), null);
  assert.equal(parseLimit('last 999 items'), MAX_PLAN_LIMIT, 'clamped to the ceiling');

  assert.equal((await plan('last 5 links')).limit, 5);
});

test('secrets are excluded unless the request names them', async () => {
  assert.equal((await plan('find the invoice')).filters.includeSensitive, false);
  assert.equal((await plan('the api key I copied')).filters.includeSensitive, true);
  assert.equal((await plan('my password from today')).filters.includeSensitive, true);
});

test('an unparseable request says so instead of guessing', async () => {
  const result = await plan('!!! ??? ...');

  assert.equal(result.intent, AGENT_INTENTS.UNKNOWN);
  assert.equal(result.confidence, 0);
  assert.match(result.explanation, /no search terms or filters were recognized/i);
});

test('a filter with no search terms still returns recent items', async () => {
  const result = await plan('what did I copy yesterday');

  assert.equal(result.intent, AGENT_INTENTS.RECENT);
  assert.ok(result.filters.since !== null);
});

test('plan validation clamps limits and defaults hostile fields safely', () => {
  const clamped = validatePlan({ intent: 'search', limit: 10_000 });
  assert.equal(clamped.limit, MAX_PLAN_LIMIT);
  assert.equal(validatePlan({ intent: 'search', limit: -5 }).limit, 1);
  assert.equal(validatePlan({ intent: 'search', limit: 'many' }).limit, 20);

  const defaults = validatePlan({ intent: 'recent' });
  assert.equal(defaults.query, '');
  assert.equal(defaults.filters.includeSensitive, false, 'secrets are opt-in');
  assert.equal(defaults.filters.pinnedOnly, false);
  assert.equal(defaults.confidence, 0);

  assert.equal(validatePlan({ intent: 'search', confidence: 5 }).confidence, 1);
  assert.equal(validatePlan({ intent: 'search', query: 42 }).query, '');
});

test('plan validation rejects malformed plans from an untrusted resolver', () => {
  assert.throws(() => validatePlan(null), { kind: 'validation' });
  assert.throws(() => validatePlan({ intent: 'delete_everything' }), { kind: 'validation' });
  assert.throws(() => validatePlan({ intent: 'search', filters: { kinds: 'text' } }), {
    kind: 'validation',
  });
  assert.throws(() => validatePlan({ intent: 'search', filters: { kinds: ['video'] } }), {
    kind: 'validation',
  });
  assert.throws(() => validatePlan({ intent: 'search', filters: { since: 'today' } }), {
    kind: 'validation',
  });
  assert.throws(() => validatePlan({ intent: 'search', filters: { since: 200, until: 100 } }), {
    kind: 'validation',
  });
});

test('the resolver contract is enforced', () => {
  assert.throws(() => assertResolver(null), { kind: 'validation' });
  assert.throws(() => assertResolver({}), { kind: 'validation' });
  assert.doesNotThrow(() => assertResolver(resolver));
});

test('a request runs end to end against real history', async (t) => {
  const { history, store, clock } = await harness(t);
  await addAt(store, clock, 'https://example.com/meeting-notes', 2 * HOUR);
  await addAt(store, clock, 'invoice 2026-08 for acme corp', 30 * 60_000);
  await addAt(store, clock, 'unrelated shopping list', 5 * DAY);

  const response = await runAgentRequest({ resolver, history, request: 'find the acme invoice' });

  assert.equal(response.plan.intent, AGENT_INTENTS.SEARCH);
  assert.equal(response.results.length, 1);
  assert.equal(response.results[0].item.text, 'invoice 2026-08 for acme corp');
  assert.ok(response.explanation.length > 0, 'the UI can show why these results');
});

test('a time-windowed request filters by when things were copied', async (t) => {
  const { history, store, clock } = await harness(t);
  await addAt(store, clock, 'copied one hour ago', HOUR);
  await addAt(store, clock, 'copied three days ago', 3 * DAY);

  const response = await runAgentRequest({ resolver, history, request: 'what did I copy today' });

  assert.equal(response.results.length, 1);
  assert.equal(response.results[0].item.text, 'copied one hour ago');
});

test('a pinned request returns only pinned items, pins first', async (t) => {
  const { history, store, clock } = await harness(t);
  const pinned = await addAt(store, clock, 'pinned reference', 2 * HOUR);
  await addAt(store, clock, 'loose note', 10 * 60_000);
  await history.pin(pinned.id);

  const response = await runAgentRequest({ resolver, history, request: 'show my pinned items' });

  assert.equal(response.results.length, 1);
  assert.equal(response.results[0].item.id, pinned.id);
});

test('a secret is withheld from a general request and returned when asked for', async (t) => {
  const { history, store, clock } = await harness(t);
  await addAt(store, clock, 'deployment key AKIAIOSFODNN7EXAMPLE', HOUR);

  const general = await runAgentRequest({ resolver, history, request: 'find deployment' });
  assert.equal(general.results.length, 0, 'a vague request does not surface credentials');

  const explicit = await runAgentRequest({ resolver, history, request: 'the deployment key' });
  assert.equal(explicit.results.length, 1, 'naming it returns it');
});

test('a stats request describes the history rather than its contents', async (t) => {
  const { history, store, clock } = await harness(t);
  await addAt(store, clock, 'one');
  await addAt(store, clock, 'two');

  const response = await runAgentRequest({ resolver, history, request: 'how many items do I have' });

  assert.equal(response.plan.intent, AGENT_INTENTS.STATS);
  assert.equal(response.stats.items, 2);
  assert.deepEqual(response.results, []);
});

test('an unknown request returns nothing and explains why', async (t) => {
  const { history, store, clock } = await harness(t);
  await addAt(store, clock, 'something');

  const response = await runAgentRequest({ resolver, history, request: '???' });

  assert.equal(response.plan.intent, AGENT_INTENTS.UNKNOWN);
  assert.deepEqual(response.results, []);
  assert.ok(response.explanation.length > 0);
});

test('the plan limit caps how much a single request returns', async (t) => {
  const { history, store, clock } = await harness(t);
  for (let i = 0; i < 30; i++) await addAt(store, clock, `note number ${i}`, i * 60_000);

  const response = await runAgentRequest({ resolver, history, request: 'show me the last 5' });

  assert.equal(response.plan.intent, AGENT_INTENTS.RECENT);
  assert.equal(response.plan.limit, 5);
  assert.equal(response.results.length, 5);
});

test('a hostile resolver cannot produce an unbounded or malformed query', async (t) => {
  const { history, store, clock } = await harness(t);
  await addAt(store, clock, 'anything');

  const hostile = {
    resolve: async () => ({
      intent: AGENT_INTENTS.SEARCH,
      query: '',
      limit: Number.MAX_SAFE_INTEGER,
      filters: { includeSensitive: true },
    }),
  };

  const response = await runAgentRequest({ resolver: hostile, history, request: 'anything' });
  assert.equal(response.plan.limit, MAX_PLAN_LIMIT);

  const broken = { resolve: async () => ({ intent: 'exfiltrate' }) };
  await assert.rejects(() => runAgentRequest({ resolver: broken, history, request: 'x' }), {
    kind: 'validation',
  });
});

test('a non-string request is rejected', async (t) => {
  const { history } = await harness(t);
  await assert.rejects(() => runAgentRequest({ resolver, history, request: 42 }), {
    kind: 'validation',
  });
});

test('an alternative resolver drops in without the engine noticing', async (t) => {
  const { history, store, clock } = await harness(t);
  await addAt(store, clock, 'findable by a different resolver');

  // Stands in for a future LLM-backed resolver: same contract, different brain.
  const alternative = {
    resolve: async (request, context) => {
      assert.ok(context.historySize >= 1, 'it receives metadata');
      assert.equal(context.previews, undefined, 'and no clipboard content');
      return {
        intent: AGENT_INTENTS.SEARCH,
        query: 'findable',
        filters: {},
        limit: 5,
        explanation: 'resolved elsewhere',
        confidence: 0.5,
      };
    },
  };

  const response = await runAgentRequest({ resolver: alternative, history, request: 'anything' });

  assert.equal(response.results.length, 1);
  assert.equal(response.explanation, 'resolved elsewhere');
});
