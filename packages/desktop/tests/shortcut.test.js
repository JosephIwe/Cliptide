import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createShortcutManager,
  DEFAULT_SUMMON_SHORTCUT,
  FALLBACK_SHORTCUTS,
} from '../src/shortcut.js';
import { createFakeElectron } from './helpers/fake-electron.js';

test('the default binding is paste-adjacent and platform-neutral', () => {
  assert.equal(DEFAULT_SUMMON_SHORTCUT, 'CommandOrControl+Shift+V');
  // CommandOrControl resolves per platform, so no branch is needed anywhere.
  assert.ok(DEFAULT_SUMMON_SHORTCUT.startsWith('CommandOrControl'));
});

test('registration binds the preferred accelerator and invokes the callback', () => {
  const { electron, pressShortcut } = createFakeElectron();
  let summoned = 0;

  const manager = createShortcutManager({
    globalShortcut: electron.globalShortcut,
    onSummon: () => (summoned += 1),
  });
  const result = manager.register();

  assert.deepEqual(result, {
    ok: true,
    accelerator: DEFAULT_SUMMON_SHORTCUT,
    fellBack: false,
    error: null,
  });
  assert.equal(manager.registered, true);

  pressShortcut(DEFAULT_SUMMON_SHORTCUT);
  assert.equal(summoned, 1, 'the OS pressing the shortcut reaches the callback');
});

test('a taken accelerator falls back and says so', () => {
  const { electron } = createFakeElectron({ refuseShortcuts: [DEFAULT_SUMMON_SHORTCUT] });

  const result = createShortcutManager({
    globalShortcut: electron.globalShortcut,
    onSummon: () => {},
  }).register();

  assert.equal(result.ok, true);
  assert.equal(result.accelerator, FALLBACK_SHORTCUTS[0]);
  assert.equal(result.fellBack, true, 'the user is told the preferred binding was unavailable');
});

test('a throwing registration is treated as unavailable, not fatal', () => {
  const { electron } = createFakeElectron({ throwShortcuts: [DEFAULT_SUMMON_SHORTCUT] });

  const manager = createShortcutManager({
    globalShortcut: electron.globalShortcut,
    onSummon: () => {},
  });
  const result = manager.register();

  assert.equal(result.ok, true, 'it moved on to a fallback');
  assert.equal(result.accelerator, FALLBACK_SHORTCUTS[0]);
  assert.ok(
    manager.diagnostics.attempts.some((a) => a.error?.includes('cannot register')),
    'the throw is recorded as a diagnostic',
  );
});

test('total failure is reported with an actionable diagnostic', () => {
  const { electron } = createFakeElectron({
    refuseShortcuts: [DEFAULT_SUMMON_SHORTCUT, ...FALLBACK_SHORTCUTS],
  });

  const manager = createShortcutManager({
    globalShortcut: electron.globalShortcut,
    onSummon: () => {},
  });
  const result = manager.register();

  assert.equal(result.ok, false);
  assert.equal(result.accelerator, null);
  assert.equal(manager.registered, false);
  assert.match(result.error, /another application is likely holding/);

  const { attempts } = manager.diagnostics;
  assert.equal(attempts.length, 1 + FALLBACK_SHORTCUTS.length, 'every candidate was tried');
  assert.ok(attempts.every((a) => a.ok === false));
});

test('diagnostics never contain clipboard data', () => {
  const { electron } = createFakeElectron({
    refuseShortcuts: [DEFAULT_SUMMON_SHORTCUT, ...FALLBACK_SHORTCUTS],
  });
  const manager = createShortcutManager({
    globalShortcut: electron.globalShortcut,
    onSummon: () => {},
  });
  manager.register();

  const serialized = JSON.stringify(manager.diagnostics);
  assert.ok(!/clipboard|payload|preview/i.test(serialized), 'accelerators and errors only');
});

test('a custom accelerator from settings is honoured', () => {
  const { electron, state } = createFakeElectron();

  const result = createShortcutManager({
    globalShortcut: electron.globalShortcut,
    accelerator: 'Alt+Space',
    onSummon: () => {},
  }).register();

  assert.equal(result.accelerator, 'Alt+Space');
  assert.equal(state.registered.has('Alt+Space'), true);
});

test('unregister releases the binding and is idempotent', () => {
  const { electron, state } = createFakeElectron();
  const manager = createShortcutManager({
    globalShortcut: electron.globalShortcut,
    onSummon: () => {},
  });
  manager.register();

  assert.equal(manager.unregister(), true);
  assert.equal(state.registered.size, 0);
  assert.equal(manager.registered, false);
  assert.equal(manager.unregister(), false, 'unregistering twice is not an error');
});

test('construction validates its dependencies', () => {
  const { electron } = createFakeElectron();

  assert.throws(() => createShortcutManager({ onSummon: () => {} }), TypeError);
  assert.throws(
    () => createShortcutManager({ globalShortcut: electron.globalShortcut }),
    TypeError,
  );
});
