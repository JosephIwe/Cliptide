/**
 * Windows clipboard source (CLI fallback).
 *
 * Uses PowerShell's `Get-Clipboard` / `Set-Clipboard`. `-NoProfile` keeps a
 * user's profile script out of the hot path, and `-Raw` preserves newlines
 * instead of returning an array of lines.
 *
 * KNOWN LIMITATION — concealed-format detection.
 * Windows password managers signal "do not record" by placing the
 * `ExcludeClipboardContentFromMonitorProcessing` or
 * `CanIncludeInClipboardHistory` clipboard formats. PowerShell cannot enumerate
 * raw clipboard formats without loading arbitrary .NET types, so this source
 * does not attempt the check rather than performing an unreliable one. The
 * guarantee is delivered by the native source the desktop shell supplies (M6),
 * which reads the clipboard format list and `GetClipboardSequenceNumber`
 * directly.
 *
 * PowerShell startup dominates the cost of a tick here, which is the main
 * reason this source is a fallback rather than the shipping default.
 */

import { createCommandTextSource } from './command-source.js';

export function createWin32ClipboardSource(options = {}) {
  return createCommandTextSource({
    name: 'win32-powershell',
    read: {
      command: 'powershell',
      args: ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'],
    },
    write: {
      command: 'powershell',
      args: ['-NoProfile', '-NonInteractive', '-Command', 'Set-Clipboard -Value ($input | Out-String)'],
    },
    ...options,
  });
}
