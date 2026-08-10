import test from 'node:test';
import assert from 'node:assert/strict';
import { createCliptide } from '../src/index.js';
import { MemoryClipboardSource } from '../src/capture/source.js';
import { createManualClock } from '../src/core/clock.js';
import { AGENT_INTENTS } from '../src/agent/protocol.js';
import { tempDir, textSnapshot } from './helpers/tempdir.js';

const POLL = 400;

async function boot(t, options = {}) {
  const dataDir = await tempDir(t);
  const clock = createManualClock();
  const source = new MemoryClipboardSource();
  const app = await createCliptide({ dataDir, clock, source, platform: 'linux', env: {}, ...options });
  t.after(() => app.stop());
  return { app, source, clock, dataDir };
}

test('a fresh instance wires every layer together', async (t) => {
  const { app } = await boot(t);

  assert.ok(app.store, 'storage');
  assert.ok(app.monitor, 'capture');
  assert.ok(app.history, 'history facade');
  assert.ok(app.settings, 'settings');
  assert.equal(app.resolver.usesNetwork, false, 'the default resolver is local');
  assert.ok(app.paths.historyFile.endsWith('history.jsonl'));
});

test('settings drive how the engine is constructed', async (t) => {
  const dataDir = await tempDir(t);
  const clock = createManualClock();

  const first = await createCliptide({ dataDir, clock, source: new MemoryClipboardSource(), platform: 'linux', env: {} });
  await first.settings.update({ capture: { pollIntervalMs: 1234, secretPolicy: 'skip' } });
  await first.stop();

  const second = await createCliptide({ dataDir, clock, source: new MemoryClipboardSource(), platform: 'linux', env: {} });
  t.after(() => second.stop());

  assert.equal(second.monitor.pollIntervalMs, 1234);
  assert.equal(second.store.secretPolicy, 'skip');
});

test('capture.enabled false starts the agent without watching the clipboard', async (t) => {
  const { app, source, clock } = await boot(t);
  await app.settings.update({ capture: { enabled: false } });

  const disabled = await createCliptide({
    dataDir: app.paths.dataDir,
    clock,
    source,
    platform: 'linux',
    env: {},
  });
  t.after(() => disabled.stop());
  await disabled.start();

  source.set(textSnapshot('copied while disabled'));
  await clock.advance(POLL * 5);

  assert.equal(disabled.monitor.running, false);
  assert.equal(disabled.store.size, 0);
});

test('the whole loop runs through the bootstrap', async (t) => {
  const { app, source, clock } = await boot(t);
  await app.start();

  source.set(textSnapshot('ssh deploy@prod.example.com'));
  await clock.advance(POLL);
  source.set(textSnapshot('https://example.com/standup'));
  await clock.advance(POLL);

  assert.equal(app.store.size, 2);

  clock.jump(2000);
  const [match] = app.history.search('prod');
  await app.history.use(match.item.id);

  assert.equal(source.current.text, 'ssh deploy@prod.example.com');
  assert.equal(app.history.list()[0].text, 'ssh deploy@prod.example.com');
});

test('ask() answers a natural-language request locally', async (t) => {
  const { app, source, clock } = await boot(t);
  await app.start();

  source.set(textSnapshot('invoice 4417 for acme corp'));
  await clock.advance(POLL);
  source.set(textSnapshot('unrelated grocery list'));
  await clock.advance(POLL);

  const response = await app.ask('find the acme invoice');

  assert.equal(response.plan.intent, AGENT_INTENTS.SEARCH);
  assert.equal(response.results.length, 1);
  assert.equal(response.results[0].item.text, 'invoice 4417 for acme corp');
});

test('the retention sweep runs on start and on its interval', async (t) => {
  const { app, source, clock } = await boot(t, { retentionIntervalMs: 60_000 });
  await app.settings.update({ retention: { maxAgeMinutes: 30 } });
  await app.start();

  source.set(textSnapshot('will go stale'));
  await clock.advance(POLL);
  assert.equal(app.store.size, 1);

  // Past the retention age, then far enough for a sweep to fire.
  clock.jump(45 * 60_000);
  await clock.advance(60_000);

  assert.equal(app.store.size, 0, 'the sweep expired it without being called by hand');
});

test('a pinned item survives every automatic sweep', async (t) => {
  const { app, source, clock } = await boot(t, { retentionIntervalMs: 60_000 });
  await app.settings.update({ retention: { maxAgeMinutes: 30, maxItems: 1 } });
  await app.start();

  source.set(textSnapshot('pin me'));
  await clock.advance(POLL);
  await app.history.pin(app.history.list()[0].id);

  clock.jump(365 * 24 * 60 * 60_000);
  await clock.advance(60_000 * 3);

  assert.equal(app.store.size, 1, 'a pin outranks every automatic policy');
});

test('stop leaves no timer holding the process open', async (t) => {
  const dataDir = await tempDir(t);
  const clock = createManualClock();
  const app = await createCliptide({
    dataDir,
    clock,
    source: new MemoryClipboardSource(),
    platform: 'linux',
    env: {},
  });

  await app.start();
  await app.stop();

  assert.equal(clock.pendingTimers, 0);
  assert.equal(app.monitor.running, false);
});

test('history written by one instance is read by the next', async (t) => {
  const dataDir = await tempDir(t);
  const clock = createManualClock();

  const first = await createCliptide({
    dataDir,
    clock,
    source: new MemoryClipboardSource(),
    platform: 'linux',
    env: {},
  });
  await first.store.add(textSnapshot('survives a restart'));
  await first.stop();

  const second = await createCliptide({
    dataDir,
    clock,
    source: new MemoryClipboardSource(),
    platform: 'linux',
    env: {},
  });
  t.after(() => second.stop());

  assert.equal(second.history.list()[0].text, 'survives a restart');
});

test('a failing retention sweep does not stop the agent', async (t) => {
  const { app, source, clock } = await boot(t, { retentionIntervalMs: 60_000 });
  await app.start();

  app.history.applyRetention = async () => {
    throw new Error('storage went away');
  };

  clock.jump(10_000);
  await clock.advance(60_000 * 2);

  source.set(textSnapshot('still capturing'));
  await clock.advance(POLL);

  assert.equal(app.monitor.running, true);
  assert.equal(app.store.size, 1);
});
