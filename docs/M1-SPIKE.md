# M1 — Native Clipboard Source Spike

Status: **verified on Linux, macOS, and Windows.** One manual test remains.
Electron **43.3.0**. Node **>=22**.

Goal: prove `OS clipboard → Electron native clipboard API → Cliptide engine`
and retire the process-spawning CLI scaffolding.

---

## M1 final status

| Verification | Result |
| --- | --- |
| Linux pipeline | **VERIFIED** |
| macOS pipeline | **VERIFIED** |
| Windows pipeline | **VERIFIED** |
| macOS cross-process concealed marker | **VERIFIED** |
| Windows cross-process concealed marker | **VERIFIED** |
| Concealed content refusal + non-storage | **VERIFIED** |
| Verification exit-code behaviour | **VERIFIED** |
| **Real password-manager compatibility** | **NOT VERIFIED — MANUAL TEST REQUIRED** |

**Runtime requirement:** Node **>=22**. `node --test` only supports glob patterns
after Node 20; the manifests previously claimed `>=20`, which the first
cross-platform CI run proved could never have worked.

**CI:** `.github/workflows/m1-platform-verification.yml` — `macos-latest` and
`windows-latest`, on push and on demand. No `continue-on-error` anywhere, and
the deliberate-failure step asserts a non-zero exit, so a failed verification
cannot surface as a green run.

Evidence run: <https://github.com/JosephIwe/Cliptide/actions/runs/31475789553>
(macOS `darwin arm64 25.5.0`, Windows `win32 x64`). macOS pipeline 18/18 with
idle CPU 0.314%; cross-process 8/8 on each platform, with the marker written by
a separate OS process (macOS pid 3712 vs Electron 3310; Windows pid 1852 vs
Electron 10144).

**Commits**

| SHA | Change |
| --- | --- |
| `861ec62` | Electron-native clipboard source (M1 spike) |
| `3033660` | Verification scripts signal failure via exit code |
| `100c5d4` | Self-test switches; all four exit paths proven |
| `74f0c51` | CI workflow + cross-process native marker helpers |
| `af29c44` | Node requirement corrected to `>=22` |

### The one thing still outstanding

Cross-process verification proves an **external native process** can place a
concealed marker that Electron detects and the engine refuses. It does **not**
prove that 1Password, Bitwarden, Keeper, or Apple Passwords set that same
marker — they may use a different type, or none.

Closing it requires a human on a real desktop:

```
npx electron packages/desktop/scripts/verify-concealed.js
```

then copying a **throwaway** password from a real manager. PASS is step 2
reporting `CONCEALED -> would NOT be recorded` with exit code 0. Full procedure
in section 6.

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
| Linux (X11) | `has(marker)` per known marker | **VERIFIED** — same-process marker; token `concealed`, payload never read, content not recorded |
| macOS | same | **VERIFIED** — marker written by a separate Swift/NSPasteboard process; Electron detected it and the engine refused to store it |
| Windows | same | **VERIFIED** — marker written by a separate Win32 `SetClipboardData` process; same result |
| **Any real password manager** | — | **NOT VERIFIED** — manual desktop test required |

### A bug M1.1 found before any real machine ran

Marker probes were originally **scoped to the host platform**: on Linux only the
KDE hint was checked, on macOS only the NSPasteboard types. A macOS-style marker
sitting on a Linux clipboard was therefore invisible, and that content **would
have been recorded**.

Worse, the first version of `verify-pipeline.js` reported this as a pass. It
only asserted that the sentinel text was absent from history — and it was
absent, but for an unrelated reason (on X11, `writeBuffer` replaces the whole
clipboard, so the text was already gone). **The check was green for the wrong
reason.**

Two fixes, both now pinned by tests:

1. **Every known marker is probed on every platform.** The failure modes are not
   symmetric: a false positive means one item is not saved; a false negative
   writes a password to disk. Cost is five `has()` calls (~0.42 ms/tick, ~0.1 %
   of a core at 400 ms). Cross-platform managers are the concrete case — an
   Electron or Qt manager may set a marker that is not native to the host OS.
2. **The verification now asserts the ordering directly**, not a side effect:
   `changeToken()` must return `concealed` *and* `read()` must return markers
   with an empty payload. That is the actual guarantee — refusal before the
   payload is ever read.

### What the Linux result does and does not prove

It proves the mechanism, the wiring, and the refusal ordering are correct, and
that Electron's API can carry an arbitrary custom pasteboard type that `has()`
can see.

It does **not** prove that a marker written by a *different* application through
`NSPasteboard` (macOS) or the Win32 clipboard (Windows) is visible to
`clipboard.has()`. Those paths involve platform type coercion this never
exercised. **Do not claim macOS or Windows concealed detection works until §6
has been run there with a real password manager.**

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

## 6. Real-machine verification (M1.1)

Neither script runs headlessly against a real password manager. Run both on a
Mac and on a Windows box.

### Safety properties (enforced in the scripts, not just promised)

- **No clipboard content is ever printed.** Only booleans, lengths, hashes, and
  format names reach stdout or the JSON report.
- **Nothing you already copied is captured.** `verify-pipeline.js` starts the
  monitor with `captureOnStart` disabled, so only sentinel values the script
  writes itself are recorded. `verify-concealed.js` has no store at all and
  persists nothing.
- **Nothing survives the run.** History goes to a throwaway temp directory
  removed in a `finally` block, so it is cleaned up even if a check throws.
- **Your clipboard is cleared at the end.**

`verify-pipeline.js` **will overwrite your clipboard**. Copy anything you need
first. Use a **throwaway password** for the concealed test — never a real one.

### Setup (both platforms)

Node 22+ and network access for the Electron binary download.

```bash
git clone https://github.com/JosephIwe/Cliptide.git
cd Cliptide
npm install
npm test            # expect 266 engine + 44 desktop, all passing
```

### Required OS permissions

- **macOS** — none needed to read the pasteboard. However, macOS 14 (Sonoma)
  and later may show a **paste confirmation prompt** when an app reads clipboard
  content it did not write. If a prompt appears, allow it and **note it in your
  report** — it materially affects how a shipping clipboard manager must behave
  and is exactly the kind of thing this run exists to discover.
  Gatekeeper may also warn about an unsigned binary; `npx electron` run from a
  terminal is normally unaffected.
- **Windows** — none needed. Some endpoint-protection tools flag clipboard
  monitors; if the run is blocked, note the product and rule.
- **Neither** requires admin/root.

### A. macOS — exact commands

```bash
npx electron packages/desktop/scripts/verify-pipeline.js
npx electron packages/desktop/scripts/verify-concealed.js
```

### B. Windows — exact commands

PowerShell or Command Prompt, from the repository root:

```powershell
npx electron packages/desktop/scripts/verify-pipeline.js
npx electron packages/desktop/scripts/verify-concealed.js
```

### The password-manager test (required)

While `verify-concealed.js` is running (120s by default; override with
`CLIPTIDE_PROBE_SECONDS`), copy in this order:

1. ordinary text from a text editor
2. a **throwaway** password from a real manager
3. ordinary text again

Required manager, at least one of:

| Platform | Test with |
| --- | --- |
| macOS | 1Password 8, Bitwarden, or Apple Passwords |
| Windows | 1Password 8, Bitwarden, or Keeper |

1Password is the highest-value single test on both: it sets the concealed
markers deliberately and is the most common manager among the target users.

### PASS criteria

**`verify-pipeline.js` — PASS when it prints `OVERALL: PASS` and exit code 0.**
All 18 checks pass, including:

- normal text copy captured; a second, different copy also captured
- re-copying does not duplicate, and promotes (`copyCount >= 2`)
- search finds a captured item; `history.use()` restores the payload
- `changeToken()` returns `concealed` **and** `read()` returns markers with an
  empty payload — the refusal-before-read ordering
- concealed content not recorded; 12 MB payload neither crashes nor hangs
- idle CPU below 2% of one core
- monitor starts, stops, and captures nothing after stop

**`verify-concealed.js` — PASS when step 2 prints
`ENGINE VERDICT: CONCEALED -> would NOT be recorded`** and the run ends with
`OVERALL: PASS` and exit code 0.

### FAIL criteria

Any of these is a FAIL — report it, do not work around it:

- `verify-pipeline.js` prints `OVERALL: FAIL`, or any individual `FAIL` line
- `verify-concealed.js` shows step 2 as `not concealed -> WOULD be recorded`
  **This is the milestone-blocking failure.** It means Electron cannot see the
  password manager's marker on that platform, and the native addon in section 7
  becomes mandatory rather than optional.
- either script throws, hangs past its stated duration, or a check reports a
  non-zero `errors` count
- idle CPU at or above 2% of one core
- macOS shows a paste prompt on **every** poll tick (as opposed to once) — that
  would make polling unusable and changes the architecture

### Confirm the harness can actually fail (run this first)

A verification script that always exits 0 is indistinguishable from one that
works. Before trusting a green result on a new machine, prove both paths:

```bash
# Expect: OVERALL: FAIL, exit code 1
CLIPTIDE_VERIFY_FORCE_FAIL=1 npx electron packages/desktop/scripts/verify-pipeline.js
echo $?

# Expect: OVERALL: PASS, exit code 0  (plants a synthetic marker, no manager needed)
CLIPTIDE_VERIFY_SELFTEST=1 npx electron packages/desktop/scripts/verify-concealed.js
echo $?
```

On Windows PowerShell use `$env:CLIPTIDE_VERIFY_FORCE_FAIL=1; npx electron ...`
and `$LASTEXITCODE`.

Both scripts exit **0 on pass and non-zero on fail**, so they can be chained or
run in CI. `app.exit()` is used rather than `app.quit()`, which discards the
status.

### What to send back

Both `===CLIPTIDE_*_JSON===` blocks, plus the saved report path printed by
`verify-pipeline.js`. They contain no clipboard content. If
`verify-concealed.js` fails, its `availableFormats` and `has()` output for step
2 is the critical evidence — it determines whether a different marker name
works or the native addon is required.

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
