import test from 'node:test';
import assert from 'node:assert/strict';
import { assertClipboardSource } from '@cliptide/engine';
import { createElectronClipboardSource } from '../src/clipboard/electron-source.js';
import { FakeClipboard, FakeNativeImage } from './helpers/fake-clipboard.js';

function makeSource(clipboard, options = {}) {
  return createElectronClipboardSource({ clipboard, platform: 'darwin', ...options });
}

test('it satisfies the engine ClipboardSource contract', () => {
  const source = makeSource(new FakeClipboard());
  assert.doesNotThrow(() => assertClipboardSource(source));
  assert.equal(source.name, 'electron-native');
});

test('it refuses to construct without a clipboard', () => {
  assert.throws(() => createElectronClipboardSource({}), TypeError);
  assert.throws(() => createElectronClipboardSource({ clipboard: {} }), TypeError);
});

test('the token is stable while content is unchanged and moves when it changes', async () => {
  const clipboard = new FakeClipboard().setText('first');
  const source = makeSource(clipboard);

  const a = await source.changeToken();
  const b = await source.changeToken();
  assert.equal(a, b, 'unchanged clipboard yields a stable token');

  clipboard.setText('second');
  assert.notEqual(await source.changeToken(), a);
});

test('identical content written twice yields the same token', async () => {
  const clipboard = new FakeClipboard().setText('repeat me');
  const source = makeSource(clipboard);

  const first = await source.changeToken();
  clipboard.setText('something else');
  await source.changeToken();
  clipboard.setText('repeat me');

  assert.equal(await source.changeToken(), first, 'dedupe happens before any read');
});

test('read returns the text snapshot handed off by changeToken', async () => {
  const clipboard = new FakeClipboard().setText('payload');
  const source = makeSource(clipboard);

  await source.changeToken();
  const readsBefore = clipboard.calls.readText;
  const snapshot = await source.read();

  assert.deepEqual(snapshot, { kind: 'text', format: 'text/plain', text: 'payload', markers: [] });
  assert.equal(clipboard.calls.readText, readsBefore, 'read reused the token read');
});

test('the hand-off is single use, so a forced read goes back to the system', async () => {
  const clipboard = new FakeClipboard().setText('original');
  const source = makeSource(clipboard);

  await source.changeToken();
  await source.read();

  clipboard.setText('changed underneath');
  const second = await source.read();
  assert.equal(second.text, 'changed underneath', 'no stale payload was served');
});

test('an empty clipboard yields a stable token and no snapshot', async () => {
  const source = makeSource(new FakeClipboard());

  assert.equal(await source.changeToken(), 'empty');
  assert.equal(await source.read(), null);
});

test('an oversized payload yields one stable token and is not read into memory', async () => {
  const clipboard = new FakeClipboard().setText('x'.repeat(5000));
  const source = makeSource(clipboard, { maxTextBytes: 1000 });

  assert.equal(await source.changeToken(), 'oversized');
  assert.equal(await source.changeToken(), 'oversized', 'the loop does not spin on it');
  assert.equal(await source.read(), null);
});

test('concealed content short-circuits before the payload is read', async () => {
  const clipboard = new FakeClipboard().setConcealed('hunter2', 'org.nspasteboard.ConcealedType');
  const source = makeSource(clipboard);

  const readsBefore = clipboard.calls.readText;
  const token = await source.changeToken();

  assert.equal(token, 'concealed');
  assert.equal(clipboard.calls.readText, readsBefore, 'the password was never read');

  const snapshot = await source.read();
  assert.deepEqual(snapshot.markers, ['org.nspasteboard.concealedtype']);
  assert.equal(snapshot.text, '', 'no payload is carried alongside the marker');
});

test('the concealed token stays stable so the loop does not spin', async () => {
  const clipboard = new FakeClipboard().setConcealed('pw', 'org.nspasteboard.ConcealedType');
  const source = makeSource(clipboard);

  assert.equal(await source.changeToken(), 'concealed');
  assert.equal(await source.changeToken(), 'concealed');
});

test('a read with no prior token still honours markers', async () => {
  const clipboard = new FakeClipboard().setConcealed('pw', 'org.nspasteboard.ConcealedType');
  const source = makeSource(clipboard);

  const snapshot = await source.read();
  assert.deepEqual(snapshot.markers, ['org.nspasteboard.concealedtype']);
});

test('an image is probed by dimensions and encoded only on capture', async () => {
  const image = new FakeNativeImage({ width: 800, height: 600, png: Buffer.alloc(64, 9) });
  const clipboard = new FakeClipboard().setImage(image);
  const source = makeSource(clipboard);

  await source.changeToken();
  await source.changeToken();
  await source.changeToken();
  assert.equal(image.toPNGCalls, 0, 'polling must never encode the image');

  const snapshot = await source.read();
  assert.equal(snapshot.kind, 'image');
  assert.equal(snapshot.format, 'image/png');
  assert.equal(snapshot.bytes.length, 64);
  assert.equal(image.toPNGCalls, 1, 'encoded exactly once, on capture');
});

test('the image token changes with dimensions', async () => {
  const clipboard = new FakeClipboard();
  const source = makeSource(clipboard);

  clipboard.setImage(new FakeNativeImage({ width: 100, height: 100, png: Buffer.alloc(4) }));
  const small = await source.changeToken();

  clipboard.setImage(new FakeNativeImage({ width: 200, height: 200, png: Buffer.alloc(4) }));
  assert.notEqual(await source.changeToken(), small);
});

test('text on the clipboard never triggers the image decode path', async () => {
  const clipboard = new FakeClipboard().setText('just text');
  const source = makeSource(clipboard);

  await source.changeToken();
  assert.equal(clipboard.calls.readImage, 0);
});

test('write puts text on the clipboard and clears the hand-off', async () => {
  const clipboard = new FakeClipboard().setText('before');
  const source = makeSource(clipboard);

  await source.changeToken();
  await source.write({ kind: 'text', text: 'pasted from history' });

  assert.equal(clipboard.readText(), 'pasted from history');
  const snapshot = await source.read();
  assert.equal(snapshot.text, 'pasted from history', 'read reflects the system, not a stale cache');
});

test('write accepts a bare string and an image', async () => {
  const clipboard = new FakeClipboard();
  const source = makeSource(clipboard);

  await source.write('bare string');
  assert.equal(clipboard.readText(), 'bare string');

  await source.write({ kind: 'image', bytes: Buffer.alloc(8, 3) });
  assert.equal(clipboard.image.png.length, 8);
});

test('without a native counter the mechanism is content-derived and declared', async () => {
  const source = makeSource(new FakeClipboard().setText('x'));

  assert.equal(source.cheapToken, false, 'the cost is declared, not hidden');
  assert.equal(source.mechanism, 'content-digest');
});

test('a native change counter makes the token O(1) and skips reading content', async () => {
  const clipboard = new FakeClipboard().setText('some content');
  let counter = 7;
  const source = makeSource(clipboard, { changeCounter: () => counter });

  assert.equal(source.cheapToken, true);
  assert.equal(source.mechanism, 'native-change-counter');

  const readsBefore = clipboard.calls.readText;
  const first = await source.changeToken();
  assert.equal(clipboard.calls.readText, readsBefore, 'no payload read to derive the token');
  assert.equal(await source.changeToken(), first, 'stable while the counter is stable');

  counter = 8;
  assert.notEqual(await source.changeToken(), first);

  // The engine still gets a real snapshot; only change detection changed.
  const snapshot = await source.read();
  assert.equal(snapshot.text, 'some content');
});

test('a native counter still yields to concealed markers', async () => {
  const clipboard = new FakeClipboard().setConcealed('pw', 'org.nspasteboard.ConcealedType');
  const source = makeSource(clipboard, { changeCounter: () => 1 });

  assert.equal(await source.changeToken(), 'concealed', 'privacy outranks the fast path');
});

test('the clipboard modules cannot spawn a process', async () => {
  // The regression this whole milestone exists to prevent: the old Windows
  // source spawned PowerShell on every tick. Asserting statically is stronger
  // than counting spawns at runtime — it fails even on a code path a test
  // never reaches.
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const dir = fileURLToPath(new URL('../src/clipboard/', import.meta.url));

  for (const file of ['electron-source.js', 'markers.js']) {
    const source = readFileSync(dir + file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

    for (const banned of ['child_process', 'spawn(', 'execFile(', 'execSync']) {
      assert.equal(source.includes(banned), false, `${file} must not reference ${banned}`);
    }
  }
});

test('a poll tick performs a bounded number of clipboard calls', async () => {
  const clipboard = new FakeClipboard().setText('content');
  const source = makeSource(clipboard);

  await source.changeToken();
  const baseline = { ...clipboard.calls };
  await source.changeToken();

  const delta = Object.fromEntries(
    Object.keys(clipboard.calls).map((k) => [k, clipboard.calls[k] - baseline[k]]),
  );

  // One marker probe per platform-applicable format, plus one text read.
  assert.equal(delta.readText, 1, 'exactly one payload read per tick');
  assert.ok(delta.has <= 4, `bounded marker probes (${delta.has})`);
  assert.equal(delta.readImage, 0, 'no image decode while text is present');
});
