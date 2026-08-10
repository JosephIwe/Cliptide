import test from 'node:test';
import assert from 'node:assert/strict';
import { ClipboardMonitor, MONITOR_EVENTS } from '../src/capture/monitor.js';
import { MemoryClipboardSource, assertClipboardSource } from '../src/capture/source.js';
import { ClipStore } from '../src/storage/store.js';
import { createManualClock } from '../src/core/clock.js';
import { createIdFactory } from '../src/core/ids.js';
import { tempDir, textSnapshot } from './helpers/tempdir.js';

const POLL = 400;

async function harness(t, options = {}) {
  const dataDir = await tempDir(t);
  const clock = createManualClock();
  const store = await ClipStore.open({
    dataDir,
    clock,
    idFactory: createIdFactory({ clock }),
    ...options.store,
  });
  const source = new MemoryClipboardSource(options.initial ?? null);
  const monitor = new ClipboardMonitor({
    source,
    store,
    clock,
    pollIntervalMs: POLL,
    captureOnStart: options.captureOnStart ?? false,
    ...options.monitor,
  });

  const events = [];
  for (const name of Object.values(MONITOR_EVENTS)) {
    monitor.on(name, (payload) => events.push({ name, payload }));
  }

  t.after(async () => {
    monitor.stop();
    await store.close();
  });

  return { store, source, monitor, clock, events };
}

const named = (events, name) => events.filter((event) => event.name === name);

test('a copy is captured on the next tick', async (t) => {
  const { source, monitor, clock, store, events } = await harness(t);
  await monitor.start();

  source.set(textSnapshot('first copy'));
  await clock.advance(POLL);

  assert.equal(store.size, 1);
  assert.equal(store.list()[0].text, 'first copy');
  assert.equal(named(events, MONITOR_EVENTS.CAPTURED).length, 1);
});

test('an unchanged clipboard costs one cheap token read and no payload read', async (t) => {
  const { source, monitor, clock, store } = await harness(t);
  await monitor.start();

  const readsBefore = source.reads;
  await clock.advance(POLL * 5);

  assert.equal(store.size, 0);
  assert.equal(source.reads, readsBefore, 'the payload was never read while idle');
  assert.ok(source.tokenReads >= 5, 'but the token was checked each tick');
});

test('re-copying identical content promotes rather than duplicating', async (t) => {
  const { source, monitor, clock, store, events } = await harness(t);
  await monitor.start();

  source.set(textSnapshot('same text'));
  await clock.advance(POLL);
  // An app re-sets the clipboard to identical content: the token moves, the
  // content does not.
  source.touch();
  await clock.advance(POLL);

  assert.equal(store.size, 1);
  assert.equal(named(events, MONITOR_EVENTS.CAPTURED).length, 1);
  assert.equal(named(events, MONITOR_EVENTS.PROMOTED).length, 1);
  assert.equal(store.list()[0].copyCount, 2);
});

test('concealed content is skipped with a reason and never stored', async (t) => {
  const { source, monitor, clock, store, events } = await harness(t);
  await monitor.start();

  source.set(textSnapshot('master-password', { markers: ['org.nspasteboard.ConcealedType'] }));
  await clock.advance(POLL);

  assert.equal(store.size, 0);
  assert.deepEqual(named(events, MONITOR_EVENTS.SKIPPED)[0].payload, { reason: 'concealed' });
});

test('captureOnStart records what is already on the clipboard', async (t) => {
  const { monitor, clock, store } = await harness(t, {
    initial: textSnapshot('already copied'),
    captureOnStart: true,
  });

  await monitor.start();
  await clock.advance(1);

  assert.equal(store.size, 1);
  assert.equal(store.list()[0].text, 'already copied');
});

test('captureOnStart false leaves the pre-existing clipboard alone', async (t) => {
  const { monitor, clock, store } = await harness(t, {
    initial: textSnapshot('was here before launch'),
    captureOnStart: false,
  });

  await monitor.start();
  await clock.advance(POLL * 3);

  assert.equal(store.size, 0, 'launching the agent is not a copy event');
});

test('pause stops recording but keeps the token current', async (t) => {
  const { source, monitor, clock, store, events } = await harness(t);
  await monitor.start();

  monitor.pause();
  source.set(textSnapshot('copied while paused'));
  await clock.advance(POLL * 2);
  assert.equal(store.size, 0);

  monitor.resume();
  await clock.advance(POLL * 2);
  assert.equal(store.size, 0, 'resuming does not replay the backlog');

  source.set(textSnapshot('copied after resume'));
  await clock.advance(POLL);
  assert.equal(store.size, 1);
  assert.equal(store.list()[0].text, 'copied after resume');

  assert.equal(named(events, MONITOR_EVENTS.PAUSED).length, 1);
  assert.equal(named(events, MONITOR_EVENTS.RESUMED).length, 1);
});

test('pause and resume are idempotent', async (t) => {
  const { monitor, events } = await harness(t);
  await monitor.start();

  monitor.pause();
  monitor.pause();
  monitor.resume();
  monitor.resume();

  assert.equal(named(events, MONITOR_EVENTS.PAUSED).length, 1);
  assert.equal(named(events, MONITOR_EVENTS.RESUMED).length, 1);
  assert.equal(monitor.paused, false);
});

test('a failing source backs off exponentially and then recovers', async (t) => {
  const { source, monitor, clock, store, events } = await harness(t);
  await monitor.start();

  source.breakFor(3);
  await clock.advance(POLL);
  const first = named(events, MONITOR_EVENTS.ERROR);
  assert.equal(first.length, 1);
  assert.ok(first[0].payload.backoffMs > POLL, 'the retry is delayed');

  // Backoff means the next attempt is not at the normal cadence.
  await clock.advance(POLL * 20);
  assert.equal(monitor.running, true, 'the monitor is still alive');

  source.set(textSnapshot('after recovery'));
  await clock.advance(60_000);

  assert.equal(store.size, 1);
  assert.equal(store.list()[0].text, 'after recovery');
});

test('backoff is capped so a broken source is still retried', async (t) => {
  const { source, monitor, clock, events } = await harness(t, {
    monitor: { maxBackoffMs: 5000 },
  });
  await monitor.start();

  source.breakFor(50);
  await clock.advance(120_000);

  const errors = named(events, MONITOR_EVENTS.ERROR);
  assert.ok(errors.length >= 5, `kept retrying (${errors.length} attempts)`);
  for (const error of errors) {
    assert.ok(error.payload.backoffMs <= 5000, 'never exceeds the cap');
  }
});

test('waking from sleep resyncs without firing a burst of catch-up ticks', async (t) => {
  const { source, monitor, clock, store, events } = await harness(t);
  await monitor.start();
  await clock.advance(POLL);

  const ticksBefore = monitor.stats.ticks;

  // The machine sleeps: time passes, timers do not fire.
  clock.jump(4 * 60 * 60 * 1000);
  source.set(textSnapshot('copied around wake'));
  await clock.advance(POLL);

  const sleptMs = 4 * 60 * 60 * 1000;
  const missedIntervals = sleptMs / POLL;
  const ticksDuringWake = monitor.stats.ticks - ticksBefore;

  const wakes = named(events, MONITOR_EVENTS.WAKE);
  assert.equal(wakes.length, 1);
  assert.ok(wakes[0].payload.gapMs >= sleptMs);
  // The point is that the loop resumes its cadence rather than replaying every
  // interval it slept through: a couple of ticks, not 36,000.
  assert.ok(
    ticksDuringWake <= 2,
    `resumed the normal cadence (${ticksDuringWake} ticks, not ${missedIntervals})`,
  );
  assert.equal(store.size, 1);
});

test('a wake clears any backoff so recovery is immediate', async (t) => {
  const { source, monitor, clock, store } = await harness(t);
  await monitor.start();

  source.breakFor(1);
  await clock.advance(POLL);

  clock.jump(60_000);
  source.set(textSnapshot('post-wake copy'));
  await clock.advance(POLL);

  assert.equal(monitor.stats.wakes, 1);
  assert.equal(store.size, 1);
});

test('an oversized payload is skipped without stopping the monitor', async (t) => {
  const { source, monitor, clock, store, events } = await harness(t, {
    store: { maxItemBytes: 1024 },
  });
  await monitor.start();

  source.set(textSnapshot('x'.repeat(4096)));
  await clock.advance(POLL);

  assert.equal(store.size, 0);
  assert.deepEqual(named(events, MONITOR_EVENTS.SKIPPED)[0].payload, { reason: 'too_large' });

  source.set(textSnapshot('normal again'));
  await clock.advance(POLL);
  assert.equal(store.size, 1, 'the loop kept running');
});

test('a throwing event listener cannot kill the poll loop', async (t) => {
  const { source, monitor, clock, store } = await harness(t);
  monitor.on(MONITOR_EVENTS.CAPTURED, () => {
    throw new Error('listener blew up');
  });
  await monitor.start();

  source.set(textSnapshot('one'));
  await clock.advance(POLL);
  source.set(textSnapshot('two'));
  await clock.advance(POLL);

  assert.equal(store.size, 2);
  assert.equal(monitor.running, true);
});

test('stop halts polling and start is idempotent', async (t) => {
  const { source, monitor, clock, store } = await harness(t);
  await monitor.start();
  await monitor.start();

  monitor.stop();
  source.set(textSnapshot('after stop'));
  await clock.advance(POLL * 5);

  assert.equal(store.size, 0);
  assert.equal(monitor.running, false);
  assert.equal(clock.pendingTimers, 0, 'no timer is left holding the process open');
});

test('captureNow records the current clipboard regardless of the token', async (t) => {
  const { source, monitor, store } = await harness(t);
  source.set(textSnapshot('forced capture'));

  const result = await monitor.captureNow();

  assert.equal(result.stored, true);
  assert.equal(store.size, 1);
  assert.equal(store.list()[0].text, 'forced capture');
});

test('captureNow on an empty clipboard reports rather than throwing', async (t) => {
  const { monitor } = await harness(t);
  const result = await monitor.captureNow();

  assert.equal(result.stored, false);
  assert.equal(result.reason, 'empty');
});

test('stats count what actually happened', async (t) => {
  const { source, monitor, clock } = await harness(t);
  await monitor.start();

  source.set(textSnapshot('one'));
  await clock.advance(POLL);
  source.touch();
  await clock.advance(POLL);
  source.set(textSnapshot('secret', { markers: ['org.nspasteboard.ConcealedType'] }));
  await clock.advance(POLL);

  assert.equal(monitor.stats.captured, 1);
  assert.equal(monitor.stats.promoted, 1);
  assert.equal(monitor.stats.skipped, 1);
  assert.ok(monitor.stats.ticks >= 3);
});

test('a slow read does not overlap the next tick', async (t) => {
  const { source, monitor, clock, store } = await harness(t);
  let inFlight = 0;
  let maxConcurrent = 0;

  const originalRead = source.read.bind(source);
  source.read = async () => {
    inFlight += 1;
    maxConcurrent = Math.max(maxConcurrent, inFlight);
    await new Promise((resolve) => setImmediate(resolve));
    const value = await originalRead();
    inFlight -= 1;
    return value;
  };

  await monitor.start();
  source.set(textSnapshot('slow one'));
  await clock.advance(POLL * 4);

  assert.equal(maxConcurrent, 1, 'reads never overlapped');
  assert.equal(store.size, 1);
});

test('the source contract is enforced at construction', () => {
  assert.throws(() => assertClipboardSource(null), { kind: 'validation' });
  assert.throws(() => assertClipboardSource({ read: () => {} }), { kind: 'validation' });
  assert.doesNotThrow(() => assertClipboardSource(new MemoryClipboardSource()));
});
