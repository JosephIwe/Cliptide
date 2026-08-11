import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrayController } from '../src/tray.js';
import { createFakeElectron } from './helpers/fake-electron.js';

function build({ shortcut = 'CommandOrControl+Shift+V' } = {}) {
  const { electron, state } = createFakeElectron();
  const calls = { open: 0, quit: 0 };

  const controller = createTrayController({
    Tray: electron.Tray,
    Menu: electron.Menu,
    nativeImage: electron.nativeImage,
    onOpen: () => (calls.open += 1),
    onQuit: () => (calls.quit += 1),
    getShortcut: () => shortcut,
  });

  return { controller, calls, state, electron };
}

const labels = (template) => template.filter((i) => i.label).map((i) => i.label);

test('the tray offers exactly open, summon hint, and quit', () => {
  const { controller } = build();
  const template = controller.buildTemplate();

  assert.deepEqual(labels(template), [
    'Open Cliptide',
    'Summon: CommandOrControl+Shift+V',
    'Quit Cliptide',
  ]);
});

test('creating the tray sets a tooltip, a menu, and a click handler', () => {
  const { controller, state, calls } = build();

  const tray = controller.create();

  assert.equal(state.trays.length, 1);
  assert.equal(tray.tooltip, 'Cliptide');
  assert.ok(tray.menu.template, 'a context menu was installed');

  // Clicking the icon is the fastest path to the overlay.
  tray.emit('click');
  assert.equal(calls.open, 1);
});

test('the open and quit items invoke their actions', () => {
  const { controller, calls } = build();
  const template = controller.buildTemplate();

  template.find((i) => i.label === 'Open Cliptide').click();
  template.find((i) => i.label === 'Quit Cliptide').click();

  assert.equal(calls.open, 1);
  assert.equal(calls.quit, 1);
});

test('a failed shortcut registration is surfaced in the menu', () => {
  const { controller } = build({ shortcut: null });
  const template = controller.buildTemplate();

  assert.ok(
    labels(template).includes('Summon shortcut unavailable'),
    'the user can see why nothing happens when they press the shortcut',
  );
  // Still openable, so the app remains usable without a binding.
  assert.ok(labels(template).includes('Open Cliptide'));
});

test('refresh rebuilds the menu after the accelerator changes', () => {
  const { electron, state } = createFakeElectron();
  let shortcut = null;

  const controller = createTrayController({
    Tray: electron.Tray,
    Menu: electron.Menu,
    nativeImage: electron.nativeImage,
    onOpen: () => {},
    onQuit: () => {},
    getShortcut: () => shortcut,
  });
  controller.create();
  assert.ok(labels(state.trays[0].menu.template).includes('Summon shortcut unavailable'));

  shortcut = 'Alt+Space';
  assert.equal(controller.refresh(), true);
  assert.ok(labels(state.trays[0].menu.template).includes('Summon: Alt+Space'));
});

test('destroy tears the tray down and is idempotent', () => {
  const { controller, state } = build();
  controller.create();

  assert.equal(controller.destroy(), true);
  assert.equal(state.trays[0].destroyed, true);
  assert.equal(controller.destroy(), false);
});

test('refresh before create is a no-op rather than a crash', () => {
  const { controller } = build();
  assert.equal(controller.refresh(), false);
});

test('construction validates its dependencies', () => {
  const { electron } = createFakeElectron();

  assert.throws(() => createTrayController({ Menu: electron.Menu }), TypeError);
  assert.throws(
    () => createTrayController({ Tray: electron.Tray, Menu: electron.Menu, onOpen: () => {} }),
    TypeError,
  );
});
