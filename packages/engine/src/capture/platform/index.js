/**
 * Platform clipboard source resolution.
 *
 * macOS and Windows are the priority targets; Linux is supported by the same
 * interface rather than by a special case, which is what "extensible to Linux"
 * has to mean in practice.
 *
 * Every source returned here implements the ClipboardSource contract, so the
 * monitor, the store, and the UI are identical across platforms. Swapping in
 * the native desktop sources (M6) is a change to this one function.
 */

import { UnsupportedPlatformError } from '../../core/errors.js';
import { createDarwinClipboardSource } from './darwin.js';
import { createWin32ClipboardSource } from './win32.js';
import { createLinuxClipboardSource } from './linux.js';

export const SUPPORTED_PLATFORMS = Object.freeze(['darwin', 'win32', 'linux']);

/**
 * @param {Object} [options]
 * @param {string} [options.platform] defaults to process.platform
 * @param {Record<string, string|undefined>} [options.env]
 */
export function createPlatformClipboardSource({
  platform = process.platform,
  env = process.env,
  ...options
} = {}) {
  switch (platform) {
    case 'darwin':
      return createDarwinClipboardSource(options);
    case 'win32':
      return createWin32ClipboardSource(options);
    case 'linux':
      return createLinuxClipboardSource({ env, ...options });
    default:
      throw new UnsupportedPlatformError(`no clipboard source for platform '${platform}'`, {
        platform,
        supported: SUPPORTED_PLATFORMS,
      });
  }
}

export { createDarwinClipboardSource } from './darwin.js';
export { createWin32ClipboardSource } from './win32.js';
export { createLinuxClipboardSource, detectLinuxBackend, LINUX_BACKENDS } from './linux.js';
export { createCommandTextSource } from './command-source.js';
