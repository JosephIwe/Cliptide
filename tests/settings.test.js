import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SettingsStore } from '../src/settings/store.js';
import { DEFAULT_SETTINGS, validateSettings, validateShortcut } from '../src/settings/schema.js';
import { tempDir } from './helpers/tempdir.js';

async function openSettings(t) {
  const dir = await tempDir(t);
  const file = path.join(dir, 'settings.json');
  const store = await SettingsStore.open(file);
  return { dir, file, store };
}

test('defaults are private and bounded', () => {
  const settings = validateSettings({});

  assert.equal(settings.privacy.allowNetwork, false, 'nothing leaves the machine by default');
  assert.equal(settings.privacy.maskSensitivePreviews, true);
  assert.equal(settings.capture.secretPolicy, 'mark');
  assert.equal(settings.retention.secretRetentionMinutes, 15);
  assert.ok(settings.retention.maxItems > 0, 'history is capped by default');
  assert.deepEqual(settings, DEFAULT_SETTINGS);
});

test('a partial update merges over defaults rather than replacing them', () => {
  const settings = validateSettings({ ui: { theme: 'dark' } });

  assert.equal(settings.ui.theme, 'dark');
  assert.equal(settings.ui.summonShortcut, DEFAULT_SETTINGS.ui.summonShortcut, 'siblings survive');
  assert.equal(settings.capture.enabled, true, 'other sections survive');
});

test('unknown keys are preserved so a newer config is not silently stripped', () => {
  const settings = validateSettings({
    futureFeature: { enabled: true },
    ui: { theme: 'dark', unknownUiOption: 42 },
  });

  assert.deepEqual(settings.futureFeature, { enabled: true });
  assert.equal(settings.ui.unknownUiOption, 42);
});

test('invalid values are rejected with the offending field named', () => {
  const cases = [
    [{ capture: { pollIntervalMs: -1 } }, 'capture.pollIntervalMs'],
    [{ capture: { pollIntervalMs: 10 } }, 'capture.pollIntervalMs'],
    [{ capture: { secretPolicy: 'shred' } }, 'capture.secretPolicy'],
    [{ capture: { enabled: 'yes' } }, 'capture.enabled'],
    [{ retention: { maxItems: 0 } }, 'retention.maxItems'],
    [{ retention: { maxAgeMinutes: 'forever' } }, 'retention.maxAgeMinutes'],
    [{ ui: { theme: 'neon' } }, 'ui.theme'],
    [{ ui: { resultLimit: 0 } }, 'ui.resultLimit'],
    [{ privacy: { allowNetwork: 'sure' } }, 'privacy.allowNetwork'],
  ];

  for (const [partial, field] of cases) {
    assert.throws(() => validateSettings(partial), { kind: 'validation' }, `${field} must be checked`);
  }

  assert.throws(() => validateSettings(null), { kind: 'validation' });
  assert.throws(() => validateSettings([]), { kind: 'validation' });
});

test('null disables a retention limit without failing validation', () => {
  const settings = validateSettings({ retention: { maxAgeMinutes: null, maxItems: null } });

  assert.equal(settings.retention.maxAgeMinutes, null);
  assert.equal(settings.retention.maxItems, null);
});

test('the summon shortcut must name exactly one non-modifier key', () => {
  assert.equal(validateShortcut('CommandOrControl+Shift+V'), 'CommandOrControl+Shift+V');
  assert.equal(validateShortcut('Alt+Space'), 'Alt+Space');
  assert.equal(validateShortcut('F9'), 'F9');

  assert.throws(() => validateShortcut(''), { kind: 'validation' });
  assert.throws(() => validateShortcut('Shift+Control'), { kind: 'validation' }, 'modifiers only');
  assert.throws(() => validateShortcut('Ctrl+V+B'), { kind: 'validation' }, 'two keys');
  assert.throws(() => validateShortcut(42), { kind: 'validation' });
});

test('settings persist across a reopen', async (t) => {
  const { file, store } = await openSettings(t);

  await store.update({ ui: { theme: 'dark' }, capture: { pollIntervalMs: 250 } });

  const reopened = await SettingsStore.open(file);
  assert.equal(reopened.get().ui.theme, 'dark');
  assert.equal(reopened.get().capture.pollIntervalMs, 250);
});

test('a missing settings file yields defaults without creating one', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'settings.json');
  const store = await SettingsStore.open(file);

  assert.deepEqual(store.get(), DEFAULT_SETTINGS);
  await assert.rejects(() => fs.access(file), 'reading does not write');
});

test('a rejected update leaves both memory and disk on the last good value', async (t) => {
  const { file, store } = await openSettings(t);
  await store.update({ ui: { theme: 'dark' } });

  await assert.rejects(() => store.update({ ui: { theme: 'neon' } }), { kind: 'validation' });

  assert.equal(store.get().ui.theme, 'dark');
  const reopened = await SettingsStore.open(file);
  assert.equal(reopened.get().ui.theme, 'dark');
});

test('a corrupt settings file falls back to defaults and keeps the damaged copy', async (t) => {
  const { file } = await openSettings(t);
  await fs.writeFile(file, '{ this is not valid json');

  const store = await SettingsStore.open(file);

  assert.deepEqual(store.get(), DEFAULT_SETTINGS);
  assert.equal(store.recovery.corrupt, true);
  const preserved = await fs.readFile(`${file}.corrupt`, 'utf8');
  assert.match(preserved, /this is not valid json/, 'the user can see what they wrote');
});

test('a settings file with an invalid value reports which value and preserves it', async (t) => {
  const { file } = await openSettings(t);
  await fs.writeFile(file, JSON.stringify({ ui: { theme: 'neon' } }));

  const store = await SettingsStore.open(file);

  assert.equal(store.get().ui.theme, 'system', 'fell back to defaults');
  assert.equal(store.recovery.corrupt, true);
  assert.match(store.recovery.invalid, /ui\.theme/);
  await assert.doesNotReject(() => fs.access(`${file}.corrupt`));
});

test('reset restores defaults and persists them', async (t) => {
  const { file, store } = await openSettings(t);
  await store.update({ ui: { theme: 'dark' } });

  await store.reset();

  assert.deepEqual(store.get(), DEFAULT_SETTINGS);
  const reopened = await SettingsStore.open(file);
  assert.equal(reopened.get().ui.theme, 'system');
});

test('the settings file is written owner-only and leaves no temp file', async (t) => {
  const { dir, file, store } = await openSettings(t);
  await store.update({ ui: { theme: 'dark' } });

  const entries = await fs.readdir(dir);
  assert.deepEqual(entries, ['settings.json'], 'no .tmp left behind');

  if (process.platform !== 'win32') {
    const stats = await fs.stat(file);
    assert.equal(stats.mode & 0o777, 0o600);
  }
});

test('the written file is human-readable and re-parses', async (t) => {
  const { file, store } = await openSettings(t);
  await store.update({ ui: { theme: 'dark' } });

  const raw = await fs.readFile(file, 'utf8');
  assert.ok(raw.includes('\n  '), 'indented for hand-editing');
  assert.deepEqual(JSON.parse(raw), store.get());
});
