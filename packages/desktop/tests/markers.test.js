import test from 'node:test';
import assert from 'node:assert/strict';
import { detectConcealedMarkers, probesFor, MARKER_PROBES } from '../src/clipboard/markers.js';
import { FakeClipboard } from './helpers/fake-clipboard.js';

test('a clean clipboard reports no markers', () => {
  const clipboard = new FakeClipboard().setText('ordinary content');
  assert.deepEqual(detectConcealedMarkers(clipboard, 'darwin'), []);
  assert.deepEqual(detectConcealedMarkers(clipboard, 'win32'), []);
  assert.deepEqual(detectConcealedMarkers(clipboard, 'linux'), []);
});

test('the macOS concealed type is detected and normalized for the engine', () => {
  const clipboard = new FakeClipboard().setConcealed('hunter2', 'org.nspasteboard.ConcealedType');

  assert.deepEqual(detectConcealedMarkers(clipboard, 'darwin'), ['org.nspasteboard.concealedtype']);
});

test('the macOS transient type is detected', () => {
  const clipboard = new FakeClipboard().setConcealed('temp', 'org.nspasteboard.TransientType');

  assert.deepEqual(detectConcealedMarkers(clipboard, 'darwin'), ['org.nspasteboard.transienttype']);
});

test('the Windows exclusion format is detected', () => {
  const clipboard = new FakeClipboard().setConcealed(
    'secret',
    'ExcludeClipboardContentFromMonitorProcessing',
  );

  assert.deepEqual(detectConcealedMarkers(clipboard, 'win32'), [
    'excludeclipboardcontentfrommonitorprocessing',
  ]);
});

test('CanIncludeInClipboardHistory conceals only when its value is zero', () => {
  const excluded = new FakeClipboard().setConcealed(
    'secret',
    'CanIncludeInClipboardHistory',
    Buffer.from([0]),
  );
  assert.deepEqual(detectConcealedMarkers(excluded, 'win32'), ['canincludeinclipboardhistory=0']);

  // Present but permitting history: NOT concealed. Treating presence alone as
  // the signal would silently stop recording ordinary content.
  const allowed = new FakeClipboard().setConcealed(
    'ordinary',
    'CanIncludeInClipboardHistory',
    Buffer.from([1]),
  );
  assert.deepEqual(detectConcealedMarkers(allowed, 'win32'), []);
});

test('the KDE hint conceals only when it equals secret', () => {
  const secret = new FakeClipboard().setConcealed(
    'pw',
    'x-kde-passwordManagerHint',
    Buffer.from('secret', 'utf8'),
  );
  assert.deepEqual(detectConcealedMarkers(secret, 'linux'), ['x-kde-passwordmanagerhint=secret']);

  const other = new FakeClipboard().setConcealed(
    'note',
    'x-kde-passwordManagerHint',
    Buffer.from('note', 'utf8'),
  );
  assert.deepEqual(detectConcealedMarkers(other, 'linux'), []);
});

test('detection does not depend on availableFormats', () => {
  // The measured Electron behaviour: a custom type is invisible to
  // availableFormats() but visible to has(). Detection must not regress to
  // scanning the format list.
  const clipboard = new FakeClipboard().setConcealed('pw', 'org.nspasteboard.ConcealedType');

  assert.equal(clipboard.availableFormats().includes('org.nspasteboard.ConcealedType'), false);
  assert.deepEqual(detectConcealedMarkers(clipboard, 'darwin'), ['org.nspasteboard.concealedtype']);
});

test('a throwing has() is treated as absent for that marker only', () => {
  const clipboard = new FakeClipboard().setConcealed('pw', 'org.nspasteboard.TransientType');
  clipboard.throwOnHas.add('org.nspasteboard.ConcealedType');

  // The first probe throws; the second must still be evaluated.
  assert.deepEqual(detectConcealedMarkers(clipboard, 'darwin'), ['org.nspasteboard.transienttype']);
});

test('a throwing readBuffer degrades safely instead of aborting', () => {
  const clipboard = new FakeClipboard().setConcealed(
    'x',
    'CanIncludeInClipboardHistory',
    Buffer.from([0]),
  );
  clipboard.throwOnReadBuffer.add('CanIncludeInClipboardHistory');

  assert.doesNotThrow(() => detectConcealedMarkers(clipboard, 'win32'));
  assert.deepEqual(detectConcealedMarkers(clipboard, 'win32'), []);
});

test('probes are scoped per platform and fall back to all for unknown ones', () => {
  assert.ok(probesFor('darwin').every((p) => p.platforms.includes('darwin')));
  assert.ok(probesFor('win32').every((p) => p.platforms.includes('win32')));
  assert.equal(probesFor('sunos').length, MARKER_PROBES.length, 'unknown platform probes all');
});

test('every emitted marker is one the engine recognizes', async () => {
  // Guards against a rename on either side silently disabling the guarantee.
  const { CONCEALED_MARKERS } = await import('@cliptide/engine');
  const emitted = [
    'org.nspasteboard.concealedtype',
    'org.nspasteboard.transienttype',
    'excludeclipboardcontentfrommonitorprocessing',
    'canincludeinclipboardhistory=0',
    'x-kde-passwordmanagerhint=secret',
  ];

  for (const marker of emitted) {
    assert.ok(CONCEALED_MARKERS.includes(marker), `engine must recognize ${marker}`);
  }
});
