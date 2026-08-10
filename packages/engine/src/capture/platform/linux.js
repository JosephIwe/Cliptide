/**
 * Linux clipboard source (CLI).
 *
 * Linux is the one platform where the command-line tools genuinely expose
 * pasteboard type lists, so concealed-marker detection works here without a
 * native module: KDE's password managers advertise the
 * `x-kde-passwordManagerHint` target, and honoring it is exactly the guarantee
 * macOS and Windows still need their native sources for.
 *
 * Wayland and X11 use different tools; the backend is chosen from the session
 * environment, with an explicit override for testing and for unusual setups.
 */

import { createCommandTextSource } from './command-source.js';

export const LINUX_BACKENDS = Object.freeze({ WAYLAND: 'wayland', X11: 'x11' });

/** Wayland is preferred when the session advertises it. */
export function detectLinuxBackend(env = process.env) {
  if (env.WAYLAND_DISPLAY && env.WAYLAND_DISPLAY.trim() !== '') return LINUX_BACKENDS.WAYLAND;
  if (env.XDG_SESSION_TYPE === 'wayland') return LINUX_BACKENDS.WAYLAND;
  return LINUX_BACKENDS.X11;
}

/**
 * Map advertised clipboard targets to the normalized concealed markers the
 * core model understands.
 */
export function parseLinuxMarkers(raw) {
  const markers = [];
  const lowered = raw.toLowerCase();
  if (lowered.includes('x-kde-passwordmanagerhint')) {
    markers.push('x-kde-passwordmanagerhint=secret');
  }
  return markers;
}

export function createLinuxClipboardSource(options = {}) {
  const { backend = detectLinuxBackend(options.env), ...rest } = options;

  if (backend === LINUX_BACKENDS.WAYLAND) {
    return createCommandTextSource({
      name: 'linux-wl-paste',
      read: { command: 'wl-paste', args: ['--no-newline', '--type', 'text/plain'] },
      write: { command: 'wl-copy', args: [] },
      types: { command: 'wl-paste', args: ['--list-types'] },
      parseMarkers: parseLinuxMarkers,
      ...rest,
    });
  }

  return createCommandTextSource({
    name: 'linux-xclip',
    read: { command: 'xclip', args: ['-selection', 'clipboard', '-o'] },
    write: { command: 'xclip', args: ['-selection', 'clipboard', '-i'] },
    types: { command: 'xclip', args: ['-selection', 'clipboard', '-t', 'TARGETS', '-o'] },
    parseMarkers: parseLinuxMarkers,
    ...rest,
  });
}
