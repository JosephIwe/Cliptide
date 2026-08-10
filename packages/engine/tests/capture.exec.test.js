import test from 'node:test';
import assert from 'node:assert/strict';
import { runCapture, runWithInput } from '../src/capture/exec.js';

// `node` is the one executable guaranteed to exist wherever these tests run,
// so it stands in for pbpaste/xclip/powershell.
const NODE = process.execPath;

test('captures stdout and the exit code', async () => {
  const result = await runCapture(NODE, ['-e', 'process.stdout.write("clipboard text")']);

  assert.equal(result.stdout.toString('utf8'), 'clipboard text');
  assert.equal(result.code, 0);
  assert.equal(result.truncated, false);
});

test('a non-zero exit is reported, not thrown', async () => {
  const result = await runCapture(NODE, ['-e', 'process.exit(3)']);

  assert.equal(result.code, 3);
  assert.equal(result.stdout.length, 0);
});

test('stderr is captured for diagnostics', async () => {
  const result = await runCapture(NODE, ['-e', 'process.stderr.write("no clipboard")']);

  assert.equal(result.stderr, 'no clipboard');
});

test('output is capped so a huge clipboard cannot be buffered whole', async () => {
  const result = await runCapture(
    NODE,
    ['-e', 'process.stdout.write("A".repeat(5 * 1024 * 1024))'],
    { maxBytes: 64 * 1024 },
  );

  assert.equal(result.truncated, true);
  assert.equal(result.stdout.length, 64 * 1024, 'exactly the cap, no overshoot');
});

test('a hung command is killed at the timeout instead of stalling the poll loop', async () => {
  const started = Date.now();

  await assert.rejects(
    () => runCapture(NODE, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 300 }),
    { kind: 'capture' },
  );

  assert.ok(Date.now() - started < 5000, 'returned promptly rather than hanging');
});

test('a missing executable is a structured error, not a crash', async () => {
  await assert.rejects(() => runCapture('cliptide-no-such-binary', []), { kind: 'capture' });
});

test('arguments are passed without a shell, so content cannot become syntax', async () => {
  const hostile = '$(touch /tmp/cliptide-pwned); rm -rf /; `whoami`';
  const result = await runCapture(NODE, ['-e', 'process.stdout.write(process.argv[1])', hostile]);

  assert.equal(result.stdout.toString('utf8'), hostile, 'passed through verbatim');
});

test('input is delivered to stdin', async () => {
  const script = `
    let data = '';
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => {
      if (data !== 'pasted value') process.exit(9);
      process.exit(0);
    });
  `;

  await assert.doesNotReject(() => runWithInput(NODE, ['-e', script], 'pasted value'));
});

test('a write that fails rejects with the exit code', async () => {
  await assert.rejects(() => runWithInput(NODE, ['-e', 'process.exit(4)'], 'ignored'), {
    kind: 'capture',
  });
});

test('a child exiting before reading stdin does not produce an unhandled error', async () => {
  // pbcopy and friends can exit early; an EPIPE must not escape as a crash.
  const big = 'x'.repeat(2 * 1024 * 1024);

  await assert.rejects(() => runWithInput(NODE, ['-e', 'process.exit(1)'], big), {
    kind: 'capture',
  });
});

test('unicode survives a stdin round trip', async () => {
  const script = `
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => { process.stdout.write(data); });
  `;
  const payload = 'emoji 🎉 CJK 漢字 rtl عربى';

  await runWithInput(NODE, ['-e', script], payload);
  const echo = await runCapture(NODE, ['-e', `process.stdout.write(${JSON.stringify(payload)})`]);

  assert.equal(echo.stdout.toString('utf8'), payload);
});
