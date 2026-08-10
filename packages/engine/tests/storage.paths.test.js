import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveDataDir, resolvePaths, APP_NAME } from '../src/storage/paths.js';

test('macOS uses Application Support', () => {
  const dir = resolveDataDir({ platform: 'darwin', env: {}, homedir: '/Users/ada' });
  assert.equal(dir, path.join('/Users/ada', 'Library', 'Application Support', APP_NAME));
});

test('Windows uses %APPDATA% and falls back to the roaming path', () => {
  assert.equal(
    resolveDataDir({ platform: 'win32', env: { APPDATA: 'C:\\Users\\Ada\\AppData\\Roaming' } }),
    path.join('C:\\Users\\Ada\\AppData\\Roaming', APP_NAME),
  );
  assert.equal(
    resolveDataDir({ platform: 'win32', env: {}, homedir: 'C:\\Users\\Ada' }),
    path.join('C:\\Users\\Ada', 'AppData', 'Roaming', APP_NAME),
  );
});

test('Linux follows XDG with a spec-compliant default', () => {
  assert.equal(
    resolveDataDir({ platform: 'linux', env: { XDG_DATA_HOME: '/home/ada/.local/share' } }),
    path.join('/home/ada/.local/share', 'cliptide'),
  );
  assert.equal(
    resolveDataDir({ platform: 'linux', env: {}, homedir: '/home/ada' }),
    path.join('/home/ada', '.local', 'share', 'cliptide'),
  );
});

test('an unknown platform still resolves rather than throwing', () => {
  const dir = resolveDataDir({ platform: 'freebsd', env: {}, homedir: '/home/ada' });
  assert.equal(dir, path.join('/home/ada', '.local', 'share', 'cliptide'));
});

test('CLIPTIDE_DATA_DIR overrides every platform default', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    assert.equal(
      resolveDataDir({ platform, env: { CLIPTIDE_DATA_DIR: '/portable/cliptide' } }),
      path.resolve('/portable/cliptide'),
    );
  }
});

test('an empty override is ignored rather than resolving to the process cwd', () => {
  const dir = resolveDataDir({
    platform: 'linux',
    env: { CLIPTIDE_DATA_DIR: '   ' },
    homedir: '/home/ada',
  });
  assert.equal(dir, path.join('/home/ada', '.local', 'share', 'cliptide'));
});

test('every file location derives from the one data directory', () => {
  const paths = resolvePaths('/data/cliptide');
  assert.equal(paths.dataDir, '/data/cliptide');
  assert.equal(paths.historyFile, path.join('/data/cliptide', 'history.jsonl'));
  assert.equal(paths.settingsFile, path.join('/data/cliptide', 'settings.json'));
  assert.equal(paths.blobDir, path.join('/data/cliptide', 'blobs'));
});
