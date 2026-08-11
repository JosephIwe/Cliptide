/**
 * Cliptide application bootstrap.
 *
 * This is the one place the layers are wired together, and it is deliberately
 * small: every layer is constructible on its own, so a desktop shell, a CLI, or
 * a test can assemble a different combination without going through here.
 *
 * What it owns beyond wiring is the retention sweep — the periodic job that
 * makes the configured policy actually take effect in a running process rather
 * than only when something calls applyRetention().
 */

import { systemClock } from './core/clock.js';
import { createIdFactory } from './core/ids.js';
import { ClipStore } from './storage/store.js';
import { resolveDataDir, resolvePaths } from './storage/paths.js';
import { SettingsStore } from './settings/store.js';
import { ClipboardMonitor } from './capture/monitor.js';
import { createPlatformClipboardSource } from './capture/platform/index.js';
import { HistoryService } from './history/index.js';
import { createLocalResolver } from './agent/local.js';
import { runAgentRequest } from './agent/protocol.js';

/** How often the retention policy is applied while the agent runs. */
export const DEFAULT_RETENTION_INTERVAL_MS = 5 * 60_000;

/**
 * Build a running Cliptide instance.
 *
 * @param {Object} [options]
 * @param {string} [options.dataDir] overrides the per-platform location
 * @param {string} [options.platform]
 * @param {Record<string,string|undefined>} [options.env]
 * @param {import('./core/clock.js').Clock} [options.clock]
 * @param {object} [options.source] inject a ClipboardSource (tests, or a
 *   native source supplied by the desktop shell)
 * @param {number} [options.retentionIntervalMs]
 */
export async function createCliptide(options = {}) {
  const {
    platform = process.platform,
    env = process.env,
    clock = systemClock,
    source = null,
    retentionIntervalMs = DEFAULT_RETENTION_INTERVAL_MS,
  } = options;

  const dataDir = options.dataDir ?? resolveDataDir({ platform, env });
  const paths = resolvePaths(dataDir);

  const settings = await SettingsStore.open(paths.settingsFile);
  const config = settings.get();

  const store = await ClipStore.open({
    dataDir,
    clock,
    idFactory: createIdFactory({ clock }),
    inlineLimitBytes: config.capture.inlineLimitBytes,
    maxItemBytes: config.capture.maxItemBytes,
    secretPolicy: config.capture.secretPolicy,
  });

  const clipboardSource = source ?? createPlatformClipboardSource({ platform, env });

  const monitor = new ClipboardMonitor({
    source: clipboardSource,
    store,
    clock,
    pollIntervalMs: config.capture.pollIntervalMs,
    captureOnStart: config.capture.captureOnStart,
  });

  const history = new HistoryService({
    store,
    source: clipboardSource,
    monitor,
    settings,
    clock,
  });

  const resolver = createLocalResolver();
  let retentionTimer = null;

  const scheduleRetention = () => {
    retentionTimer = clock.setTimeout(async () => {
      try {
        await history.applyRetention();
      } catch {
        // A failed sweep must not stop the agent or the next sweep. Nothing is
        // deleted on failure, so the only cost is history staying larger.
      }
      if (retentionTimer !== null) scheduleRetention();
    }, retentionIntervalMs);
  };

  return {
    paths,
    settings,
    store,
    source: clipboardSource,
    monitor,
    history,
    resolver,

    /** Ask a natural-language question about history. Local by default. */
    async ask(request, withResolver = resolver) {
      return runAgentRequest({ resolver: withResolver, history, request });
    },

    async start() {
      // A sweep on start catches everything that expired while the agent was
      // not running, which is most of what expires on a laptop.
      await history.applyRetention().catch(() => {});
      if (settings.get().capture.enabled) await monitor.start();
      scheduleRetention();
      return this;
    },

    async stop() {
      monitor.stop();
      if (retentionTimer !== null) {
        clock.clearTimeout(retentionTimer);
        retentionTimer = null;
      }
      await store.close();
      return this;
    },
  };
}

export { ClipStore } from './storage/store.js';
export { ClipboardMonitor, MONITOR_EVENTS } from './capture/monitor.js';
export { MemoryClipboardSource, assertClipboardSource } from './capture/source.js';
export { HistoryService } from './history/index.js';
export { SettingsStore, DEFAULT_SETTINGS } from './settings/index.js';
export { searchHistory } from './search/index.js';
export { createLocalResolver, runAgentRequest, AGENT_INTENTS } from './agent/index.js';
export { resolveDataDir, resolvePaths } from './storage/paths.js';

/**
 * Vocabulary a host process needs to implement a ClipboardSource correctly.
 *
 * A platform source has to emit concealed markers the engine recognizes and
 * content kinds it accepts. Without these exported, a host would hardcode the
 * strings and a rename on either side would silently disable the
 * never-record-concealed-content guarantee. Additive only — no existing
 * contract changes.
 */
export { CONCEALED_MARKERS, CONTENT_KINDS, isConcealed } from './core/types.js';
