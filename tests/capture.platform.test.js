import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlatformClipboardSource, SUPPORTED_PLATFORMS } from '../src/capture/platform/index.js';
import { createCommandTextSource } from '../src/capture/platform/command-source.js';
import { detectLinuxBackend, parseLinuxMarkers, LINUX_BACKENDS } from '../src/capture/platform/linux.js';
import { assertClipboardSource } from '../src/capture/source.js';

/** A fake command runner so platform sources can be driven without a desktop. */
function fakeRunner({ text = '', types = '', truncated = false, code = 0 } = {}) {
  const calls = { capture: [], input: [] };
  return {
    calls,
    written: [],
    runCapture: async (command, args) => {
      calls.capture.push({ command, args });
      const isTypes = args.includes('--list-types') || args.includes('TARGETS');
      const payload = isTypes ? types : text;
      return { stdout: Buffer.from(payload, 'utf8'), stderr: '', code, truncated: isTypes ? false : truncated };
    },
    runWithInput: async (command, args, input) => {
      calls.input.push({ command, args, input });
      return { code: 0 };
    },
  };
}

test('each supported platform resolves to a conforming source', () => {
  for (const platform of SUPPORTED_PLATFORMS) {
    const source = createPlatformClipboardSource({ platform, env: {} });
    assert.doesNotThrow(() => assertClipboardSource(source), platform);
    assert.ok(source.name.startsWith(platform === 'win32' ? 'win32' : platform));
  }
});

test('an unsupported platform fails with a listed alternative', () => {
  assert.throws(() => createPlatformClipboardSource({ platform: 'aix', env: {} }), {
    kind: 'unsupported_platform',
  });
});

test('macOS resolves to pbpaste and Windows to PowerShell', () => {
  assert.equal(createPlatformClipboardSource({ platform: 'darwin', env: {} }).name, 'darwin-pbpaste');
  assert.equal(createPlatformClipboardSource({ platform: 'win32', env: {} }).name, 'win32-powershell');
});

test('Linux picks its backend from the session environment', () => {
  assert.equal(detectLinuxBackend({ WAYLAND_DISPLAY: 'wayland-0' }), LINUX_BACKENDS.WAYLAND);
  assert.equal(detectLinuxBackend({ XDG_SESSION_TYPE: 'wayland' }), LINUX_BACKENDS.WAYLAND);
  assert.equal(detectLinuxBackend({ DISPLAY: ':0' }), LINUX_BACKENDS.X11);
  assert.equal(detectLinuxBackend({}), LINUX_BACKENDS.X11);
  assert.equal(detectLinuxBackend({ WAYLAND_DISPLAY: '  ' }), LINUX_BACKENDS.X11);
});

test('the Linux source follows the detected backend', () => {
  assert.equal(
    createPlatformClipboardSource({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' } }).name,
    'linux-wl-paste',
  );
  assert.equal(
    createPlatformClipboardSource({ platform: 'linux', env: {} }).name,
    'linux-xclip',
  );
});

test('the KDE password-manager hint maps to a concealed marker', () => {
  const targets = ['TIMESTAMP', 'TARGETS', 'text/plain', 'x-kde-passwordManagerHint'].join('\n');
  assert.deepEqual(parseLinuxMarkers(targets), ['x-kde-passwordmanagerhint=secret']);
  assert.deepEqual(parseLinuxMarkers('TARGETS\ntext/plain\nUTF8_STRING'), []);
});

test('a command source reads text and reports a content-derived token', async () => {
  const runner = fakeRunner({ text: 'clipboard contents' });
  const source = createCommandTextSource({
    name: 'test',
    read: { command: 'fake-paste', args: [] },
    write: { command: 'fake-copy', args: [] },
    runner,
  });

  const token = await source.changeToken();
  const snapshot = await source.read();

  assert.equal(source.cheapToken, false, 'the cost of deriving a token is declared');
  assert.equal(typeof token, 'string');
  assert.equal(snapshot.kind, 'text');
  assert.equal(snapshot.text, 'clipboard contents');
  assert.equal(runner.calls.capture.length, 1, 'read() reused the token read, not a second one');
});

test('the token changes only when the content does', async () => {
  const runner = fakeRunner({ text: 'stable' });
  const source = createCommandTextSource({
    name: 'test',
    read: { command: 'fake-paste', args: [] },
    write: { command: 'fake-copy', args: [] },
    runner,
  });

  assert.equal(await source.changeToken(), await source.changeToken());
});

test('an empty clipboard yields a stable token and no snapshot', async () => {
  const runner = fakeRunner({ text: '' });
  const source = createCommandTextSource({
    name: 'test',
    read: { command: 'fake-paste', args: [] },
    write: { command: 'fake-copy', args: [] },
    runner,
  });

  assert.equal(await source.changeToken(), 'empty');
  assert.equal(await source.read(), null);
});

test('an oversized clipboard yields one stable token, not a re-read every tick', async () => {
  const runner = fakeRunner({ text: 'x'.repeat(64), truncated: true });
  const source = createCommandTextSource({
    name: 'test',
    read: { command: 'fake-paste', args: [] },
    write: { command: 'fake-copy', args: [] },
    runner,
  });

  assert.equal(await source.changeToken(), 'oversized');
  assert.equal(await source.changeToken(), 'oversized', 'the monitor sees no change and moves on');
});

test('a source with a types command surfaces concealed markers', async () => {
  const runner = fakeRunner({ text: 'a password', types: 'text/plain\nx-kde-passwordManagerHint' });
  const source = createCommandTextSource({
    name: 'test',
    read: { command: 'fake-paste', args: [] },
    write: { command: 'fake-copy', args: [] },
    types: { command: 'fake-paste', args: ['--list-types'] },
    parseMarkers: parseLinuxMarkers,
    runner,
  });

  await source.changeToken();
  const snapshot = await source.read();

  assert.deepEqual(snapshot.markers, ['x-kde-passwordmanagerhint=secret']);
});

test('a source without a types command reports no markers rather than guessing', async () => {
  const runner = fakeRunner({ text: 'content' });
  const source = createCommandTextSource({
    name: 'test',
    read: { command: 'fake-paste', args: [] },
    write: { command: 'fake-copy', args: [] },
    runner,
  });

  await source.changeToken();
  assert.deepEqual((await source.read()).markers, []);
});

test('failing type enumeration does not block capture', async () => {
  const runner = fakeRunner({ text: 'content' });
  const original = runner.runCapture;
  runner.runCapture = async (command, args) => {
    if (args.includes('--list-types')) throw new Error('no such tool');
    return original(command, args);
  };

  const source = createCommandTextSource({
    name: 'test',
    read: { command: 'fake-paste', args: [] },
    write: { command: 'fake-copy', args: [] },
    types: { command: 'missing-tool', args: ['--list-types'] },
    parseMarkers: parseLinuxMarkers,
    runner,
  });

  await source.changeToken();
  const snapshot = await source.read();
  assert.equal(snapshot.text, 'content');
  assert.deepEqual(snapshot.markers, []);
});

test('write sends the payload to the platform copy command', async () => {
  const runner = fakeRunner({ text: 'old' });
  const source = createCommandTextSource({
    name: 'test',
    read: { command: 'fake-paste', args: [] },
    write: { command: 'fake-copy', args: ['-selection', 'clipboard'] },
    runner,
  });

  await source.write({ kind: 'text', text: 'pasted from history' });
  await source.write('a bare string works too');

  assert.deepEqual(runner.calls.input[0], {
    command: 'fake-copy',
    args: ['-selection', 'clipboard'],
    input: 'pasted from history',
  });
  assert.equal(runner.calls.input[1].input, 'a bare string works too');
});

test('read after a write goes back to the system rather than trusting a cache', async () => {
  const runner = fakeRunner({ text: 'what the system actually holds' });
  const source = createCommandTextSource({
    name: 'test',
    read: { command: 'fake-paste', args: [] },
    write: { command: 'fake-copy', args: [] },
    runner,
  });

  await source.write({ kind: 'text', text: 'written value' });
  const snapshot = await source.read();

  assert.equal(snapshot.text, 'what the system actually holds');
});

test('a non-zero exit with no output reads as an empty clipboard, not a failure', async () => {
  const runner = fakeRunner({ text: '', code: 1 });
  const source = createCommandTextSource({
    name: 'test',
    read: { command: 'fake-paste', args: [] },
    write: { command: 'fake-copy', args: [] },
    runner,
  });

  assert.equal(await source.changeToken(), 'empty');
  assert.equal(await source.read(), null);
});
