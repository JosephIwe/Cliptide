/**
 * Concealed-content marker detection via Electron's clipboard API.
 *
 * Password managers mark clipboard content as "do not record". Honoring those
 * markers is Cliptide's strongest privacy guarantee, so how we detect them
 * matters more than almost anything else in the desktop layer.
 *
 * MEASURED FINDING (Electron 43.3.0, probe run under Linux/X11):
 *
 *   clipboard.availableFormats()  ->  []          after writeBuffer of a custom type
 *   clipboard.has('org.nspasteboard.ConcealedType') -> true
 *
 * That is the whole design constraint. `availableFormats()` reports only the
 * formats Electron classifies as standard, so a custom marker can be present
 * and absent from that list at the same time. `has(name)` probes a specific
 * type directly and does see it.
 *
 * So detection asks about each known marker by name. That is also cheaper: a
 * fixed handful of `has()` calls, no list allocation, no string scanning.
 *
 * SCOPE OF WHAT IS PROVEN: the round trip above was written and read inside
 * one Electron process on X11. It proves the API can carry a custom type. It
 * does NOT prove that a marker set by a *different* application through
 * NSPasteboard (macOS) or the Win32 clipboard (Windows) is visible here.
 * That requires running the probe on those machines; see docs/M1-SPIKE.md.
 */

/** Emitted marker strings match the engine's normalized vocabulary. */
export const MARKER_PROBES = Object.freeze([
  {
    format: 'org.nspasteboard.ConcealedType',
    platforms: ['darwin'],
    marker: () => 'org.nspasteboard.concealedtype',
  },
  {
    format: 'org.nspasteboard.TransientType',
    platforms: ['darwin'],
    marker: () => 'org.nspasteboard.transienttype',
  },
  {
    format: 'ExcludeClipboardContentFromMonitorProcessing',
    platforms: ['win32'],
    marker: () => 'excludeclipboardcontentfrommonitorprocessing',
  },
  {
    // Windows signals "keep this out of clipboard history" with a value of 0.
    // Presence alone is not the signal; the value is.
    format: 'CanIncludeInClipboardHistory',
    platforms: ['win32'],
    marker: (buffer) => {
      if (!buffer || buffer.length === 0) return null;
      return buffer[0] === 0 ? 'canincludeinclipboardhistory=0' : null;
    },
  },
  {
    format: 'x-kde-passwordManagerHint',
    platforms: ['linux'],
    marker: (buffer) => {
      const value = buffer?.toString('utf8').trim().toLowerCase();
      return value === 'secret' ? 'x-kde-passwordmanagerhint=secret' : null;
    },
  },
]);

/**
 * Every probe runs on every platform.
 *
 * Scoping probes to the "native" platform was a real bug: on Linux the source
 * probed only the KDE hint, so a macOS-style concealed marker sitting on the
 * clipboard was invisible and the content would have been recorded. The
 * verification script caught it.
 *
 * Probing everything is the correct default because the failure modes are not
 * symmetric. A false positive means one item is not saved — a minor annoyance.
 * A false negative means a password is written to disk — the exact failure this
 * product exists to prevent. Given that asymmetry, breadth wins.
 *
 * It is also affordable: five `has()` calls at ~84us is ~0.42ms per tick,
 * roughly 0.1% of a core at the 400ms default, and still hundreds of times
 * cheaper than the process spawn it replaced.
 *
 * Cross-platform password managers are the concrete case — an Electron or Qt
 * manager may well set a marker that is not the one "native" to the host OS.
 *
 * `platformsFor()` is retained so tooling can report which markers are
 * *expected* here, without narrowing what is actually checked.
 */
export function probesFor() {
  return MARKER_PROBES;
}

/** Markers conventionally set by this platform. Reporting only, never a filter. */
export function expectedMarkersFor(platform) {
  return MARKER_PROBES.filter((p) => p.platforms.includes(platform)).map((p) => p.format);
}

/**
 * Ask the clipboard which concealed markers are present.
 *
 * Every probe is individually guarded: `has()` and `readBuffer()` can throw for
 * an unregistered format on some platforms, and a throwing probe must read as
 * "not detected for this marker" rather than aborting the whole check and
 * losing the markers that would have matched.
 *
 * @param {object} clipboard Electron's clipboard (or a compatible fake)
 * @param {string} platform
 * @returns {string[]} normalized markers, ready for the engine's isConcealed()
 */
export function detectConcealedMarkers(clipboard, platform) {
  const found = [];

  // `platform` is accepted for signature stability and reporting; it must not
  // narrow the probe set — see probesFor().
  void platform;

  for (const probe of probesFor()) {
    let present = false;
    try {
      present = clipboard.has(probe.format) === true;
    } catch {
      continue;
    }
    if (!present) continue;

    // Presence-only markers do not need their payload read.
    if (probe.marker.length === 0) {
      const marker = probe.marker();
      if (marker) found.push(marker);
      continue;
    }

    let buffer = null;
    try {
      buffer = clipboard.readBuffer(probe.format);
    } catch {
      buffer = null;
    }
    const marker = probe.marker(buffer);
    if (marker) found.push(marker);
  }

  return found;
}
