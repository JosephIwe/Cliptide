/**
 * M2 privacy properties.
 *
 * These are the guarantees the overlay must not weaken. Each is asserted
 * against real behaviour rather than trusted to code review.
 *
 * The CONCEALED vs SENSITIVE distinction runs through all of it:
 *
 *  - Concealed (password-manager) content is refused by the engine at
 *    `store.add()`. It is never persisted, so it cannot be listed, searched,
 *    selected, or pasted. These tests prove the property end to end rather
 *    than assuming the M1 behaviour still holds.
 *  - Sensitive (credential-shaped) content the user copied themselves IS
 *    stored, with a preview the engine already masked. It appears in the
 *    overlay flagged, and the raw value never crosses into the renderer.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCliptide, MemoryClipboardSource } from '@cliptide/engine';
import { createDesktopApp } from '../src/app.js';
import { IPC_CHANNELS } from '../src/ipc.js';
import { PAYLOAD_FIELDS } from '../src/overlay/view-model.js';
import { createFakeElectron } from './helpers/fake-electron.js';

const SRC = path.dirname(fileURLToPath(import.meta.url)) + '/../src/';
const SECRET = 'correct-horse-battery-staple';
const CONCEALED_SNAPSHOT = {
  kind: 'text',
  text: SECRET,
  markers: ['org.nspasteboard.concealedtype'],
};

async function harness(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cliptide-privacy-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));

  const fake = createFakeElectron();
  const source = new MemoryClipboardSource();
  const cliptide = await createCliptide({ dataDir, source, platform: 'linux', env: {} });

  const logs = [];
  const desktop = createDesktopApp({
    electron: fake.electron,
    cliptide,
    platform: 'linux',
    log: (line) => logs.push(line),
  });
  await desktop.start();
  t.after(() => desktop.stop());

  return { desktop, cliptide, fake, source, logs, dataDir };
}

test('concealed content never reaches the renderer', async (t) => {
  const { cliptide, fake } = await harness(t);

  const result = await cliptide.store.add(CONCEALED_SNAPSHOT);
  assert.equal(result.stored, false);
  assert.equal(result.reason, 'concealed');

  const listed = await fake.invoke(IPC_CHANNELS.LIST, {});
  assert.deepEqual(listed, [], 'nothing to show — it was never stored');
  assert.ok(!JSON.stringify(listed).includes(SECRET));
});

test('concealed content is not searchable', async (t) => {
  const { cliptide, fake } = await harness(t);
  await cliptide.store.add(CONCEALED_SNAPSHOT);
  await cliptide.store.add({ kind: 'text', text: 'an ordinary note' });

  for (const query of ['correct', 'horse', 'battery', 'staple', SECRET]) {
    const results = await fake.invoke(IPC_CHANNELS.SEARCH, { query });
    assert.deepEqual(results, [], `"${query}" must not surface concealed content`);
  }

  const ordinary = await fake.invoke(IPC_CHANNELS.SEARCH, { query: 'ordinary' });
  assert.equal(ordinary.length, 1, 'ordinary content is still searchable');
});

test('concealed content cannot be selected or pasted', async (t) => {
  const { cliptide, fake, source } = await harness(t);
  await source.write({ kind: 'text', text: 'clipboard before' });
  await cliptide.store.add(CONCEALED_SNAPSHOT);

  // There is no id to select — but even a forged one must not paste anything.
  const forged = await fake.invoke(IPC_CHANNELS.USE, { id: '0'.repeat(26) });
  assert.deepEqual(forged, { ok: false, reason: 'not_found' });

  assert.equal(source.current.text, 'clipboard before', 'clipboard untouched');
});

test('concealed content captured through the live monitor is never recorded', async (t) => {
  const { cliptide, fake, source, logs } = await harness(t);

  source.set(CONCEALED_SNAPSHOT);
  await new Promise((r) => setTimeout(r, cliptide.monitor.pollIntervalMs * 3));

  assert.equal(cliptide.store.size, 0);
  assert.deepEqual(await fake.invoke(IPC_CHANNELS.LIST, {}), []);
  assert.ok(!logs.join('\n').includes(SECRET), 'and it never reached a log line');
});

test('no clipboard payload or preview is written to logs', async (t) => {
  const { cliptide, source, logs } = await harness(t);
  const payload = 'a-very-distinctive-clipboard-payload-value';

  source.set({ kind: 'text', text: payload });
  await new Promise((r) => setTimeout(r, cliptide.monitor.pollIntervalMs * 3));
  assert.equal(cliptide.store.size, 1, 'it was captured');

  const joined = logs.join('\n');
  assert.ok(joined.length > 0, 'the capture was logged at all');
  assert.ok(!joined.includes(payload), 'but the payload is absent');
  assert.ok(/kind=text/.test(joined), 'only kind, size, and flags are recorded');
});

test('sensitive content is flagged and masked, never raw', async (t) => {
  const { cliptide, fake } = await harness(t);
  await cliptide.store.add({ kind: 'text', text: 'export AWS_KEY=AKIAIOSFODNN7EXAMPLE' });

  const [item] = await fake.invoke(IPC_CHANNELS.LIST, {});

  assert.equal(item.sensitive, true);
  assert.ok(!item.preview.includes('AKIAIOSFODNN7EXAMPLE'));
  assert.ok(!JSON.stringify(item).includes('AKIAIOSFODNN7EXAMPLE'));
});

test('dismissing the overlay does not change clipboard state', async (t) => {
  const { fake, source, cliptide } = await harness(t);
  await cliptide.store.add({ kind: 'text', text: 'an item in history' });
  await source.write({ kind: 'text', text: 'what the user had' });

  fake.pressShortcut('CommandOrControl+Shift+V');
  await fake.invoke(IPC_CHANNELS.CLOSE, {});

  assert.equal(source.current.text, 'what the user had', 'Escape leaves the clipboard alone');
  assert.equal(fake.state.windows[0].isVisible(), false);
});

test('pinning behaviour is intact and pins survive a clear', async (t) => {
  const { cliptide, fake } = await harness(t);
  const { item: kept } = await cliptide.store.add({ kind: 'text', text: 'pinned note' });
  await cliptide.store.add({ kind: 'text', text: 'loose note' });
  await cliptide.history.pin(kept.id);

  await cliptide.history.clear();

  const items = await fake.invoke(IPC_CHANNELS.LIST, {});
  assert.equal(items.length, 1);
  assert.equal(items[0].pinned, true, 'a pin is not removed by an automatic path');
});

test('retention behaviour is intact and never expires a pin', async (t) => {
  const { cliptide, fake } = await harness(t);
  const { item: pinned } = await cliptide.store.add({ kind: 'text', text: 'pinned forever' });
  await cliptide.store.add({ kind: 'text', text: 'ordinary one' });
  await cliptide.store.add({ kind: 'text', text: 'ordinary two' });
  await cliptide.history.pin(pinned.id);

  // A cap of 1 applies to UNPINNED items only — pins do not consume the
  // budget, so two ordinary items means exactly one expires.
  const report = await cliptide.history.applyRetention({ maxAgeMinutes: null, maxItems: 1 });

  assert.equal(report.expired.length, 1, 'the cap was enforced against unpinned items');
  const items = await fake.invoke(IPC_CHANNELS.LIST, {});
  assert.ok(
    items.some((i) => i.pinned && i.preview === 'pinned forever'),
    'the pin survived',
  );
  assert.equal(items.length, 2, 'the pin plus the one surviving ordinary item');
});

test('the preload bridge exposes no way to read clipboard content', () => {
  const preload = readFileSync(SRC + 'preload.cjs', 'utf8');

  assert.match(preload, /contextBridge\.exposeInMainWorld/);
  for (const banned of ['readPayload', 'readText', 'getPayload', 'nodeIntegration']) {
    assert.equal(preload.includes(banned), false, `preload must not expose ${banned}`);
  }
  // Exactly four capabilities, all id-or-query based.
  const exposed = [...preload.matchAll(/^\s{2}([a-z]+):/gm)].map((m) => m[1]);
  assert.deepEqual(exposed.sort(), ['close', 'list', 'search', 'use']);
});

test('the overlay window is created with a locked-down renderer', async (t) => {
  const { fake } = await harness(t);
  const { webPreferences } = fake.state.windows[0].options;

  assert.equal(webPreferences.contextIsolation, true);
  assert.equal(webPreferences.nodeIntegration, false);
  assert.equal(webPreferences.sandbox, true);
  assert.equal(webPreferences.webSecurity, true);
});

test('the renderer never parses a preview as markup', () => {
  // Comments are stripped first: prose *about* the banned APIs is not a use of
  // them, and matching raw text would make the guard unmaintainable.
  const renderer = readFileSync(SRC + 'overlay/renderer.js', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  // A clipboard preview is untrusted input; assigning it as markup would make
  // it executable.
  for (const banned of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'eval(']) {
    assert.equal(renderer.includes(banned), false, `renderer must not use ${banned}`);
  }
  assert.match(renderer, /textContent/);
});

test('no desktop module imports a network client', () => {
  const files = ['ipc.js', 'app.js', 'tray.js', 'shortcut.js', 'overlay/view-model.js', 'overlay/controller.js', 'overlay/renderer.js'];

  for (const file of files) {
    const source = readFileSync(SRC + file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

    for (const banned of ['node:http', 'node:https', 'node:net', 'fetch(', 'XMLHttpRequest', 'WebSocket']) {
      assert.equal(source.includes(banned), false, `${file} must not reference ${banned}`);
    }
  }
});

test('view models cannot be widened to carry a payload without failing', async (t) => {
  const { cliptide, fake } = await harness(t);
  await cliptide.store.add({ kind: 'text', text: 'guard the boundary' });

  const [item] = await fake.invoke(IPC_CHANNELS.LIST, {});

  for (const field of PAYLOAD_FIELDS) {
    assert.equal(field in item, false, `'${field}' must never cross to the renderer`);
  }
});
