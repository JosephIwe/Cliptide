/**
 * Public surface of the capture layer.
 */

export {
  ClipboardMonitor,
  MONITOR_EVENTS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_SLEEP_THRESHOLD_MS,
  DEFAULT_MAX_BACKOFF_MS,
} from './monitor.js';

export { MemoryClipboardSource, assertClipboardSource } from './source.js';
export { createPlatformClipboardSource, SUPPORTED_PLATFORMS } from './platform/index.js';
export { runCapture, runWithInput } from './exec.js';
