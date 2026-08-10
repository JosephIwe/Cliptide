/**
 * macOS clipboard source (CLI fallback).
 *
 * Uses `pbpaste`/`pbcopy`, which are present on every macOS install.
 *
 * KNOWN LIMITATION — concealed-type detection.
 * The strongest privacy guarantee in this project is that password-manager
 * content is never recorded. On macOS that means checking the pasteboard for
 * `org.nspasteboard.ConcealedType`, which requires reading NSPasteboard types
 * directly. No shipped command-line tool reports custom UTIs reliably, so this
 * source does not attempt the check rather than performing an unreliable one:
 * a privacy guarantee that silently fails is worse than one that is documented
 * as pending. `markers` is therefore always empty here, and the guarantee is
 * delivered by the native source the desktop shell supplies (M6), which reads
 * `NSPasteboard.general.types` and `changeCount` directly.
 *
 * Until then, `secretPolicy` and retention still apply to anything captured.
 */

import { createCommandTextSource } from './command-source.js';

export function createDarwinClipboardSource(options = {}) {
  return createCommandTextSource({
    name: 'darwin-pbpaste',
    // -Prefer txt keeps rich-text pastes from arriving as RTF markup.
    read: { command: 'pbpaste', args: ['-Prefer', 'txt'] },
    write: { command: 'pbcopy', args: [] },
    ...options,
  });
}
