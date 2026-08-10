import test from 'node:test';
import assert from 'node:assert/strict';
import { createManualClock, systemClock } from '../src/core/clock.js';

test('the manual clock fires timers in due order', async () => {
  const clock = createManualClock(1000);
  const fired = [];

  clock.setTimeout(() => fired.push('third'), 300);
  clock.setTimeout(() => fired.push('first'), 100);
  clock.setTimeout(() => fired.push('second'), 200);

  await clock.advance(250);
  assert.deepEqual(fired, ['first', 'second']);
  assert.equal(clock.now(), 1250);

  await clock.advance(100);
  assert.deepEqual(fired, ['first', 'second', 'third']);
});

test('a timer that reschedules itself is stepped within one advance', async () => {
  const clock = createManualClock();
  let ticks = 0;

  const tick = () => {
    ticks += 1;
    if (ticks < 5) clock.setTimeout(tick, 100);
  };
  clock.setTimeout(tick, 100);

  await clock.advance(500);
  assert.equal(ticks, 5, 'a self-rescheduling poll loop advances naturally');
});

test('clearTimeout cancels a pending timer', async () => {
  const clock = createManualClock();
  let fired = false;

  const handle = clock.setTimeout(() => {
    fired = true;
  }, 50);
  clock.clearTimeout(handle);

  await clock.advance(100);
  assert.equal(fired, false);
  assert.equal(clock.pendingTimers, 0);
});

test('jump moves time without firing timers, modelling sleep', async () => {
  const clock = createManualClock(1000);
  let fired = false;
  clock.setTimeout(() => {
    fired = true;
  }, 50);

  clock.jump(60_000);

  assert.equal(clock.now(), 61_000);
  assert.equal(fired, false, 'the machine was asleep; the timer did not run');
  assert.equal(clock.pendingTimers, 1);
});

test('async timer callbacks are awaited before the next fires', async () => {
  const clock = createManualClock();
  const order = [];

  clock.setTimeout(async () => {
    order.push('start-a');
    await new Promise((resolve) => setImmediate(resolve));
    order.push('end-a');
  }, 10);
  clock.setTimeout(() => order.push('b'), 20);

  await clock.advance(30);
  assert.deepEqual(order, ['start-a', 'end-a', 'b']);
});

test('the system clock reports real time and unrefs its timers', () => {
  const before = Date.now();
  const now = systemClock.now();
  assert.ok(now >= before && now <= Date.now());

  const handle = systemClock.setTimeout(() => {}, 60_000);
  assert.ok(handle, 'a handle is returned');
  systemClock.clearTimeout(handle);
});
