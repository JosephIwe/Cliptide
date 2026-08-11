# M1 — Native Clipboard Source Spike

Status: **complete on Linux, unverified on macOS and Windows.**
Electron **43.3.0**.

Goal: prove `OS clipboard → Electron native clipboard API → Cliptide engine`
and retire the process-spawning CLI scaffolding.

---

## 1. The finding that shaped the design

**Electron's clipboard has no change-detection API.** Verified twice:

1. Against the shipped `electron.d.ts` — the `Clipboard` interface declares 19
   methods, none reporting change, and does not extend `EventEmitter`.
2. By enumerating the live object inside a running Electron main process — 20
   methods (one internal test helper), and:

```json
"changeDetection": {
  "hasChangeCount": false,
  "isEventEmitter": false,
  "matchingMethods": []
}
```

There is no `changeCount`, no sequence number, no event, no observer.

**Consequence:** an Electron-only implementation must derive a change token by
reading content. That is a real cost, and it is *not* the cost that made the old
sources unshippable — process spawning was. See §5.

## 2. The second finding: `availableFormats()` is the wrong detector

Measured on Linux/X11, after writing a custom type via `writeBuffer`:

```
clipboard.availableFormats()                      -> []
clipboard.has('org.nspasteboard.ConcealedType')   -> true   (1 byte)
```

`availableFormats()` lists only formats Electron classifies as standard. A
concealed marker can be present and absent from that list simultaneously.

This **corrects the assumption recorded in the M0 proposal**, which named
`availableFormats()` as the likely detection mechanism. Detection instead probes
each known marker by name with `has()`, which is also cheaper: a fixed handful of
calls, no list allocation, no string scanning.

`packages/desktop/tests/markers.test.js` pins this — the fake clipboard
reproduces the asymmetry, so a regression to format-list scanning fails.

## 3. Architecture

```
OS clipboard
    │
    ▼
Electron clipboard API            in-process C++ binding, no subprocess
    │
    ▼
createElectronClipboardSource()   packages/desktop/src/clipboard/
    │   • detectConcealedMarkers() runs FIRST, every tick
    │   • changeToken(): native counter if injected, else content digest
    │   • read(): single-use hand-off from the token read
    │   • write(): the paste path
    ▼
ClipboardSource contract          UNCHANGED — engine has no idea Electron exists
    │
    ▼
ClipboardMonitor → ClipStore → history / search / retention
```

**Order of operations per tick** — privacy first, deliberately:

1. `detectConcealedMarkers()` — if any marker is present, return a stable
   `concealed` token and **never read the payload**. A password does not enter
   this process's memory.
2. If a native counter is injected, return it. O(1), no content read.
3. Otherwise read bounded text and digest it.
4. If text is empty, probe an image by **dimensions only** — encoding to PNG on
   every tick would cost more than the text path it replaced. The encode is
   deferred to `read()`, so it happens once per capture, never per poll.

**Nothing above `capture/source.js` changed.** The engine's `ClipboardSource`
contract was sufficient as designed.

### The one engine change, and why

`packages/engine/src/index.js` now additionally exports `CONCEALED_MARKERS`,
`CONTENT_KINDS`, and `assertClipboardSource`.

A host process implementing a source must emit markers the engine recognizes.
Without these exported, the desktop package would hardcode the strings and a
rename on either side would silently disable the never-record-concealed-content
guarantee. Additive only — no existing contract, signature, or behavior changed.

## 4. Concealed-marker detection status

| Platform | Mechanism | Status |
| --- | --- | --- |
| Linux (X11) | `has('org.nspasteboard.ConcealedType')` | **VERIFIED** — round-tripped in a live Electron process; content was correctly not recorded |
| macOS | same | **NOT VERIFIED** — requires a Mac |
| Windows | `has('ExcludeClipboardContentFromMonitorProcessing')`, `CanIncludeInClipboardHistory == 0` | **NOT VERIFIED** — requires a Windows box |

### What the Linux result does and does not prove

It proves the Electron API can carry an arbitrary custom pasteboard type and
that `has()` sees it — so the *mechanism* is sound and the wiring is correct.

It does **not** prove that a marker written by a *different* application through
`NSPasteboard` (macOS) or the Win32 clipboard (Windows) is visible to
`clipboard.has()`. Those paths involve platform type coercion this test never
exercised. **Do not claim macOS or Windows concealed detection works until
§6 has been run there.**

## 5. Resource behaviour

Measured inside a live Electron 43.3.0 main process:

| Operation | Cost |
| --- | --- |
| `availableFormats()` | **29 µs** |
| `has(format)` | **84 µs** |
| `readText()` typical payload | **104 µs** |
| `readText()` 1 MB payload | **2,800 µs** |
| PowerShell spawn (old Windows source) | **~200,000–500,000 µs** |

**Roughly 2,000–5,000× faster, and zero child processes.** The old source
launched ~216,000 PowerShell processes per day at a 400 ms interval. This one
launches none — `packages/desktop/tests/electron-source.test.js` asserts
statically that the clipboard modules cannot reference `child_process`,
`spawn(`, `execFile(`, or `execSync`.

Live idle measurement, 200 ms polling (twice the production rate):

```
idleCpuPercent: 0.433   over 25 poll ticks
```

At the 400 ms default that is roughly **0.2 % of one core**, dominated by the
content digest. With a native change counter it becomes O(1) — call cost only.

### Remaining cost, stated plainly

Without a native counter, each tick reads the clipboard text. For a 1 MB payload
that is 2.8 ms per tick, ~0.7 % of a core at 400 ms. Acceptable, not ideal, and
the reason §7 exists.

## 6. Real-machine verification required

Neither script can run headlessly. Both print format names, lengths, and
booleans only — **never clipboard content**.

### B. macOS

```bash
npm install
npx electron packages/desktop/scripts/verify-pipeline.js    # 10 automated checks
npx electron packages/desktop/scripts/verify-concealed.js   # then follow prompts
```

For `verify-concealed.js`, copy in this order:
1. ordinary text from a text editor
2. a **throwaway** password from 1Password / Bitwarden / Apple Passwords
3. ordinary text again

**Pass condition:** step 2 reports
`ENGINE VERDICT: CONCEALED -> would NOT be recorded`.

**If it fails**, capture the `availableFormats` and `has()` output for step 2 —
that output determines whether a different marker name works or the native
fallback in §7 is required.

### C. Windows

Same two commands. Password managers to try: 1Password, Bitwarden, Keeper.
Expect `ExcludeClipboardContentFromMonitorProcessing` or
`CanIncludeInClipboardHistory` with a zero value.

### Also verify on both

- Copy a >10 MB payload — confirm it is skipped, not buffered.
- Sleep/wake the machine — confirm the monitor resumes without a tick burst.
- Copy an image — confirm capture and that idle CPU stays flat afterwards.

## 7. Native fallback — scoped, deliberately not built

Needed if §6 fails on either platform, and worth building regardless for O(1)
change detection.

**Smallest viable addon** — one N-API module, two functions:

```c
uint64_t clipboardChangeCount();          // NSPasteboard.changeCount
                                          // GetClipboardSequenceNumber()
bool     clipboardHasFormat(const char*); // NSPasteboard types / Win32 formats
```

- macOS: `[[NSPasteboard generalPasteboard] changeCount]` and `.types`
- Windows: `GetClipboardSequenceNumber()` and `EnumClipboardFormats`
- ~150 lines of platform code, no third-party dependency
- Ships prebuilt per platform-arch to avoid a user-side toolchain

**Integration is one line.** The source already accepts an injectable
`changeCounter` and reports `cheapToken: true` when present:

```js
createElectronClipboardSource({ clipboard, changeCounter: native.clipboardChangeCount })
```

`packages/desktop/tests/electron-source.test.js` and `integration.test.js`
already cover the counter-driven path with an injected fake, so the addon
arrives against passing tests rather than new ones.

**Not built now** because it is only justified once §6 says whether it is
required for correctness or merely for efficiency — and because it cannot be
compiled or tested in this environment.

## 8. Verdict

**Not yet the production source.** It is architecturally correct, measurably
sound, and it does not reproduce the spawning design. But Cliptide's central
privacy claim is unverified on both priority platforms, and promoting a
clipboard source whose password-manager handling has never been observed on
macOS or Windows would be exactly the kind of unverified privacy claim this
project refuses to make.

**Promote it once §6 passes on both.** If §6 fails, build §7 first.

The CLI scaffolding in `packages/engine/src/capture/platform/` remains in place
and untouched for now — it is still what a non-Electron host would use, and
removing it before the replacement is verified would leave no working source at
all. Deleting it is a follow-up, not part of this spike.
