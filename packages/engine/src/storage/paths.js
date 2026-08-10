/**
 * Per-platform data directory resolution.
 *
 * Cliptide keeps everything under one owner-only directory. Resolution is a
 * pure function of platform, environment, and home directory so tests can
 * assert the macOS and Windows layouts without running on those platforms.
 */

import os from 'node:os';
import path from 'node:path';

export const APP_NAME = 'Cliptide';

/** Owner-only. History is as sensitive as the documents it was copied from. */
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

export const HISTORY_FILE = 'history.jsonl';
export const SETTINGS_FILE = 'settings.json';
export const BLOB_DIR = 'blobs';

/**
 * Resolve the application data directory.
 *
 * `CLIPTIDE_DATA_DIR` overrides everything — it is how the packaged app runs a
 * portable install, and how the test suite stays off the developer's real
 * history.
 *
 * @param {Object} [options]
 * @param {string} [options.platform] defaults to process.platform
 * @param {Record<string,string|undefined>} [options.env] defaults to process.env
 * @param {string} [options.homedir] defaults to os.homedir()
 */
export function resolveDataDir({ platform = process.platform, env = process.env, homedir } = {}) {
  const home = homedir ?? os.homedir();

  const override = env.CLIPTIDE_DATA_DIR;
  if (override && override.trim() !== '') return path.resolve(override);

  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', APP_NAME);
  }

  if (platform === 'win32') {
    // %APPDATA% is per-user roaming; its inherited ACLs give the owner-only
    // protection that DIR_MODE provides on POSIX.
    const appData = env.APPDATA;
    if (appData && appData.trim() !== '') return path.join(appData, APP_NAME);
    return path.join(home, 'AppData', 'Roaming', APP_NAME);
  }

  // Linux and anything else: XDG.
  const xdg = env.XDG_DATA_HOME;
  if (xdg && xdg.trim() !== '') return path.join(xdg, 'cliptide');
  return path.join(home, '.local', 'share', 'cliptide');
}

/** All file locations derived from a data directory. */
export function resolvePaths(dataDir) {
  return {
    dataDir,
    historyFile: path.join(dataDir, HISTORY_FILE),
    settingsFile: path.join(dataDir, SETTINGS_FILE),
    blobDir: path.join(dataDir, BLOB_DIR),
  };
}
