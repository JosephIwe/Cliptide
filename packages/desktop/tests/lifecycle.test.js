/**
 * Application lifecycle: start, summon, dismiss, quit.
 *
 * Runs against fake Electron bindings and a real engine, so the wiring and
 * ordering are genuinely exercised without a display server. What this does
 * NOT cover is whether the overlay actually renders on screen — that stays a
 * documented manual check.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCliptide, MemoryClipboardSource } from '@cliptide/engine';
import { createDesktopApp } from '../src/app.js';
import { IPC_CHANNELS } from '../src/ipc.js';
import { createFakeElectron } from './helpers/fake-electron.js';

async function harness(t, { platform = 'darwin', electronOptions = {} } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cliptide-lifecycle-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));

  const fake = createFakeElectron(electronOptions);
  const source = new MemoryClipboardSource();
  const cliptide = await createCliptide({ dataDir, source, platform: 'linux', env: {} });

  const logs = [];
  const desktop = createDesktopApp({
    electron: fake.electron,
    cliptide,
    platform,
    log: (line) => logs.push(line),
  });

  t.after(async () => {
    if (desktop.started) await desktop.stop();
  });

  return { desktop, cliptide, fake, source, logs };
}

test('starting the app starts the engine monitor and builds every surface', async (t) => {
  const { desktop, cliptide, fake } = await harness(t);

  await desktop.start();

  assert.equal(cliptide.monitor.running, true, 'capture is running');
  assert.equal(fake.state.windows.length, 1, 'the overlay window exists');
  assert.equal(fake.state.trays.length, 1, 'the tray exists');
  assert.equal(desktop.shortcut.registered, true);
  assert.equal(desktop.started, true);
});

test('no window is visible on startup', async (t) => {
  const { desktop, fake } = await harness(t);
  await desktop.start();

  const [window] = fake.state.windows;
  assert.equal(window.options.show, false, 'constructed hidden');
  assert.equal(window.isVisible(), false);
  assert.equal(window.options.skipTaskbar, true, 'stays out of the taskbar');
});

test('the dock icon is hidden on macOS so it runs as a background utility', async (t) => {
  const mac = await harness(t, { platform: 'darwin' });
  await mac.desktop.start();
  assert.equal(mac.fake.state.dockHidden, true);

  const win = await harness(t, { platform: 'win32' });
  await win.desktop.start();
  assert.equal(win.fake.state.dockHidden, false, 'not applicable off macOS');
});

test('the global shortcut summons and re-pressing dismisses', async (t) => {
  const { desktop, fake } = await harness(t);
  await desktop.start();

  const accelerator = desktop.shortcut.accelerator;
  const [window] = fake.state.windows;

  fake.pressShortcut(accelerator);
  assert.equal(window.isVisible(), true, 'summoned');

  fake.pressShortcut(accelerator);
  assert.equal(window.isVisible(), false, 'pressing again dismisses');
});

test('the app still starts when no shortcut can be bound', async (t) => {
  const { desktop, logs, fake } = await harness(t, {
    electronOptions: {
      refuseShortcuts: [
        'CommandOrControl+Shift+V',
        'CommandOrControl+Shift+C',
        'Alt+Shift+V',
      ],
    },
  });

  await desktop.start();

  assert.equal(desktop.shortcut.registered, false);
  assert.equal(desktop.started, true, 'the app is usable via the tray');
  assert.equal(fake.state.trays.length, 1);
  assert.ok(
    logs.some((line) => line.includes('WARNING') && line.includes('tray')),
    'the failure is reported with a way forward',
  );
});

test('the tray can open the overlay', async (t) => {
  const { desktop, fake } = await harness(t);
  await desktop.start();

  fake.state.trays[0].emit('click');
  assert.equal(fake.state.windows[0].isVisible(), true);
});

test('IPC channels are registered and answer through the engine', async (t) => {
  const { desktop, cliptide, fake } = await harness(t);
  await desktop.start();
  await cliptide.store.add({ kind: 'text', text: 'via ipc' });

  const items = await fake.invoke(IPC_CHANNELS.LIST, {});

  assert.deepEqual(desktop.diagnostics.channels.sort(), Object.values(IPC_CHANNELS).sort());
  assert.equal(items.length, 1);
  assert.equal(items[0].preview, 'via ipc');
});

test('the close channel hides the overlay', async (t) => {
  const { desktop, fake } = await harness(t);
  await desktop.start();
  fake.pressShortcut(desktop.shortcut.accelerator);
  assert.equal(fake.state.windows[0].isVisible(), true);

  await fake.invoke(IPC_CHANNELS.CLOSE, {});

  assert.equal(fake.state.windows[0].isVisible(), false);
});

test('losing focus dismisses the overlay', async (t) => {
  const { desktop, fake } = await harness(t);
  await desktop.start();
  fake.pressShortcut(desktop.shortcut.accelerator);

  fake.state.windows[0].emit('blur');

  assert.equal(fake.state.windows[0].isVisible(), false, 'a utility strip should not linger');
});

test('stopping tears everything down and stops the monitor', async (t) => {
  const { desktop, cliptide, fake } = await harness(t);
  await desktop.start();

  await desktop.stop();

  assert.equal(cliptide.monitor.running, false, 'capture stopped');
  assert.equal(fake.state.registered.size, 0, 'shortcut released');
  assert.equal(fake.state.trays[0].destroyed, true, 'tray destroyed');
  assert.equal(fake.state.windows[0].destroyed, true, 'window destroyed');
  assert.equal(fake.state.handlers.size, 0, 'IPC handlers removed');
  assert.equal(desktop.started, false);
});

test('start and stop are idempotent', async (t) => {
  const { desktop, fake } = await harness(t);

  await desktop.start();
  await desktop.start();
  assert.equal(fake.state.trays.length, 1, 'a second start does not duplicate surfaces');

  await desktop.stop();
  await desktop.stop();
  assert.equal(desktop.started, false);
});

test('history survives a stop and a fresh start', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cliptide-restart-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));

  const first = await createCliptide({ dataDir, source: new MemoryClipboardSource(), platform: 'linux', env: {} });
  const firstApp = createDesktopApp({
    electron: createFakeElectron().electron,
    cliptide: first,
    platform: 'linux',
    log: () => {},
  });
  await firstApp.start();
  await first.store.add({ kind: 'text', text: 'persisted across restart' });
  await firstApp.stop();

  const second = await createCliptide({ dataDir, source: new MemoryClipboardSource(), platform: 'linux', env: {} });
  const fake = createFakeElectron();
  const secondApp = createDesktopApp({ electron: fake.electron, cliptide: second, platform: 'linux', log: () => {} });
  t.after(() => secondApp.stop());
  await secondApp.start();

  const items = await fake.invoke(IPC_CHANNELS.LIST, {});
  assert.equal(items[0].preview, 'persisted across restart');
});

test('construction validates its dependencies', () => {
  assert.throws(() => createDesktopApp({ cliptide: {} }), TypeError);
  assert.throws(() => createDesktopApp({ electron: {} }), TypeError);
});
