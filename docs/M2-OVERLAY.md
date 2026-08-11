# M2 — Summonable Desktop Overlay

Status: **implemented and tested headlessly. On-screen behaviour needs a manual
pass on macOS and Windows.**

The interaction: **copy → copy → copy → summon → find → Enter → back to work.**

---

## 1. What runs

Cliptide is now a background desktop application. No window on startup, no dock
icon on macOS, a tray icon as the always-available handle, and a global shortcut
that summons a keyboard-first overlay over whatever you were doing.

```
CommandOrControl+Shift+V
        │
        ▼
  overlay appears ──▶ type to search ──▶ ↑ ↓ to move ──▶ Enter
        │                                                  │
      Escape                                     clipboard restored,
   (clipboard untouched)                       overlay hides, focus returns
```

## 2. Architecture

Electron stays a thin shell. Everything with behaviour lives in a pure module
with its dependencies injected, which is why the whole lifecycle is tested on a
machine with no display server.

```
packages/desktop/src/
  app.js                  lifecycle orchestration (injected Electron)
  main.js                 the only file that touches real Electron
  ipc.js                  handler map over HistoryService
  shortcut.js             global accelerator + fallback ladder
  tray.js                 tray menu and actions
  preload.cjs             four-function bridge, nothing else
  overlay/
    window.js             BrowserWindow lifecycle, focus return
    view-model.js         THE PRIVACY BOUNDARY — strips payload
    controller.js         selection state machine (shared with the renderer)
    renderer.{html,css,js}  the view
```

**No new dependencies.** **No engine changes.** The engine still knows nothing
about Electron; `packages/engine` was not touched by this milestone.

The renderer imports `controller.js` directly — the same module the tests drive,
so the keyboard behaviour asserted in CI is the behaviour that ships.

## 3. The privacy boundary

`view-model.js` is the only path from engine to UI, and it projects a ClipItem
down to `{id, kind, kindLabel, preview, updatedAt, relativeAge, pinned,
sensitive, bytes}`. `text`, `files`, `blobRef`, and `hash` never cross.

Two consequences, both measured or tested:

- **A renderer compromise cannot exfiltrate history.** The payload never
  arrives. There is no "read payload" bridge — `use()` sends an id and the main
  process does the clipboard write.
- **Big items cost the same as small ones.** Fifty rows serialise to ~11 KB
  whether history holds 102 or 2002 items, and whether or not it contains a 2 MB
  text item and a 512 KB image (§5).

### Concealed vs sensitive — not the same thing

| | Concealed | Sensitive |
| --- | --- | --- |
| What | Password-manager content | Credential-*shaped* content the user copied |
| Stored? | **Never** — refused at `store.add()` | Yes |
| In the overlay? | Cannot be: it does not exist | Yes, flagged, preview masked by the engine |
| Pasteable? | No | Yes — it is the user's own content |

Concealed exclusion needs no filter in M2 because it is structural. What M2 adds
is *tests proving the property still holds* end to end: not listed, not
searchable, not selectable, not pasteable, not logged.

## 4. Automatic paste — deliberately not implemented

**Electron cannot deliver a keystroke to another application.**
`webContents.sendInputEvent` targets Electron's own webContents only. Reaching a
foreign app requires OS-level synthetic input:

| Platform | Mechanism | Cost |
| --- | --- | --- |
| macOS | `CGEventPost` / AppleScript System Events | Accessibility (TCC) grant, user prompt |
| Windows | `SendInput` via a native addon | No addon exists; M1 ruled one out for now |

Both are platform-specific, permission-gated, and fragile in exactly the way the
brief warned against. **M2 therefore ships: select → restore clipboard → hide
overlay → return focus.** The user presses paste, as they already would.

Focus return *is* implemented: hiding the window returns focus to the previous
application, and on macOS `app.hide()` is used because hiding a single window
would leave Cliptide frontmost.

**Follow-up (not M2):** an opt-in auto-paste behind an explicit Accessibility
grant on macOS, and a scoped `SendInput` addon on Windows. It should be a
setting the user turns on, never a default, because it means the app can type
into other applications.

## 5. Measurements

Recorded, not estimated. Linux, Node 22.22.2, Electron 43.3.0.

### Engine side (`scripts/measure-overlay.mjs`)

| Operation | 102 items | 502 items | 2002 items |
| --- | --- | --- | --- |
| History render (list + project 50) | 0.042 ms | 0.008 ms | **0.009 ms** |
| Search hit | 0.21 ms | 0.50 ms | **1.448 ms** (p95 2.66) |
| Search miss | 0.048 ms | 0.076 ms | 0.341 ms |
| Clear query (restore recent) | 0.026 ms | 0.008 ms | 0.008 ms |
| Store open (cold log replay) | 3.6 ms | 5.4 ms | 15.9 ms |
| **Renderer transfer, 50 rows** | 11,289 B | 11,337 B | **11,385 B** |

Each corpus also contained a 2 MB text item and a 512 KB image. Transfer size
barely moves — that is the view-model boundary doing its job.

### Electron side (`scripts/measure-overlay-electron.js`, under xvfb)

| Measurement | Value |
| --- | --- |
| Process start → app ready | 578 ms |
| App start (engine + window + IPC + shortcut + tray) | 552 ms |
| **Summon: hidden → visible + focused** | **0.639 ms median, 3.17 ms max** |
| History list (50 of 301) inside Electron | 0.163 ms |
| Tray created | yes |
| Shortcut bound | `CommandOrControl+Shift+V` |
| RSS | 198.7 MB |

Summon is ~0.6 ms because the window is built once at startup and then shown,
rather than constructed per press. Startup is ~1.1 s total — acceptable for a
login-item background app, and off the latency-critical path.

RSS ~199 MB is the Electron cost accepted in D3. Reducing it is a Tauri-shaped
decision, not a tuning one.

## 6. Platform status

| | Logic (headless tests) | On-screen behaviour |
| --- | --- | --- |
| Linux | VERIFIED — full suite + live Electron run | partial (xvfb: tray + shortcut bound) |
| macOS | VERIFIED — full suite runs on `macos-latest` in CI | **NOT VERIFIED** |
| Windows | VERIFIED — full suite runs on `windows-latest` in CI | **NOT VERIFIED** |

The M1 workflow runs `npm test` on both platforms, so every M2 test executes
there on each push. **That is not the same as verifying the GUI.** A passing
headless suite says the wiring and the privacy properties hold; it says nothing
about whether the overlay is legible, positioned sensibly, or focusable over a
full-screen app.

## 7. Known limitations

1. **No automatic paste** (§4). By design.
2. **On-screen behaviour unverified on macOS and Windows** (§8).
3. **macOS 14+ may prompt on clipboard read.** Flagged in M1, still unconfirmed.
   If it prompts per poll rather than once, polling is unusable and the
   architecture changes.
4. **Tray icon is a placeholder** — a transparent 16×16 PNG. Real artwork before
   any release.
5. **Shortcut is not user-configurable yet.** It reads `ui.summonShortcut` from
   settings and falls back through a fixed ladder, but there is no settings UI.
6. **No pin/delete from the overlay.** Read and paste only; the engine supports
   both, the UI does not expose them yet.
7. **Images have no thumbnail** — they show as `PNG image · 240 KB`. Rendering a
   thumbnail would mean shipping pixels to the renderer, which is exactly what
   the view-model boundary exists to prevent. A bounded thumbnail path can be
   designed later.

## 8. Manual verification package

**For a tester with a real Mac or Windows machine. No knowledge of the codebase
is required — follow the steps in order and record PASS/FAIL.**

Verified against commit **`3296c8c`**, Electron **43.3.0**.

### Before you start

Install **Node 22 or newer** (`node --version` must print v22 or higher), then:

```bash
git clone https://github.com/JosephIwe/Cliptide.git
cd Cliptide
npm install
git rev-parse --short HEAD          # record this SHA in your report
```

Leave the terminal open. Cliptide prints its log there, and **step 21 checks
that log**, so do not close it until you are finished.

### Safety rules — read before step 17

- Use a **throwaway** credential you create for this test. **Never a real
  production password.**
- **Never paste the password, or any clipboard content, into your report.**
  Record only PASS/FAIL, booleans, and format names.
- Cliptide will overwrite your clipboard during these tests. Save anything you
  need first.
- Delete the throwaway credential from your password manager afterwards.

---

## A. macOS procedure

Start Cliptide (leave this running, and leave the terminal visible):

```bash
npm start --workspace @cliptide/desktop
```

| # | Step | Expected result | PASS/FAIL |
| --- | --- | --- | --- |
| 1 | Run the command above | App launches without error | |
| 2 | Look at the Dock and the menu bar | **No** Dock icon and **no** app window. A Cliptide icon **is** in the menu bar (top right) | |
| 3 | Open TextEdit (or any app), type something, and click into it | That app has focus | |
| 4 | Copy three different short texts (⌘C) from TextEdit, a few seconds apart | — | |
| 5 | With TextEdit still focused, press **⌘⇧V** | Overlay appears | |
| 6 | Look at where the overlay appeared | It is **on top of** TextEdit, not behind it | |
| 7 | Type a letter | The letter lands in the overlay's search box, not TextEdit — the overlay has keyboard focus | |
| 8 | Clear the search box | Your three copied items are listed, newest first. The first row is visibly highlighted | |
| 9 | Press **↓** twice, then **↑** once | The highlight moves down, down, then up. It does not wrap around the ends | |
| 10 | Press **Enter** on a row you recognise | Overlay closes | |
| 11 | Note which app is now focused | Focus returned to TextEdit | |
| 12 | Press **⌘V** in TextEdit | The item you selected is pasted | |
| 13 | Press **⌘⇧V**, then press **Escape** | Overlay closes | |
| 14 | Press **⌘V** in TextEdit again | The **same** item as step 12 pastes — Escape changed nothing | |
| 15 | Press **⌘⇧V** and type a word that appears in only one item | Results filter as you type, with no delay | |
| 16 | Delete what you typed | Full recent history returns | |
| 17 | Press **Escape**. In your password manager, create a **throwaway** entry and copy its password | — | |
| 18 | Press **⌘⇧V** | Overlay appears | |
| 19 | Look at the list | The password is **not** listed. **Do not record the value.** | |
| 20 | Type part of the password, then try **↓** and **Enter** | Nothing matches; the password cannot be selected or pasted | |
| 21 | Look at the terminal running Cliptide | Lines like `[cliptide] captured kind=text bytes=42 sensitive=false`. **No clipboard content anywhere** | |
| 22 | Menu bar icon → **Quit Cliptide** | App exits; no Cliptide process remains (`pgrep -fl cliptide`) | |

**macOS notes to record:** if any permission prompt appears (especially a paste
or Accessibility prompt on macOS 14+), note **what it asked for** and whether it
appeared **once or repeatedly**. This is important — a prompt on every poll would
change the architecture.

---

## B. Windows procedure

Start Cliptide (leave this running, and leave the terminal visible):

```powershell
npm start --workspace @cliptide/desktop
```

| # | Step | Expected result | PASS/FAIL |
| --- | --- | --- | --- |
| 1 | Run the command above | App launches without error | |
| 2 | Look at the taskbar and the system tray | **No** taskbar button and **no** app window. A Cliptide icon **is** in the system tray (bottom right; check the hidden-icons arrow) | |
| 3 | Open Notepad, type something, click into it | Notepad has focus | |
| 4 | Copy three different short texts (Ctrl+C) from Notepad, a few seconds apart | — | |
| 5 | With Notepad still focused, press **Ctrl+Shift+V** | Overlay appears | |
| 6 | Look at where the overlay appeared | It is **on top of** Notepad, not behind it | |
| 7 | Type a letter | The letter lands in the overlay's search box, not Notepad | |
| 8 | Clear the search box | Your three copied items are listed, newest first. First row visibly highlighted | |
| 9 | Press **↓** twice, then **↑** once | Highlight moves down, down, up. Does not wrap | |
| 10 | Press **Enter** on a row you recognise | Overlay closes | |
| 11 | Note which app is now focused | Focus returned to Notepad | |
| 12 | Press **Ctrl+V** in Notepad | The item you selected is pasted | |
| 13 | Press **Ctrl+Shift+V**, then **Escape** | Overlay closes | |
| 14 | Press **Ctrl+V** in Notepad again | The **same** item as step 12 pastes — Escape changed nothing | |
| 15 | Press **Ctrl+Shift+V** and type a word in only one item | Results filter as you type | |
| 16 | Delete what you typed | Full recent history returns | |
| 17 | Press **Escape**. In your password manager, create a **throwaway** entry and copy its password | — | |
| 18 | Press **Ctrl+Shift+V** | Overlay appears | |
| 19 | Look at the list | The password is **not** listed. **Do not record the value.** | |
| 20 | Type part of the password, then try **↓** and **Enter** | Nothing matches; cannot be selected or pasted | |
| 21 | Look at the terminal running Cliptide | Lines like `[cliptide] captured kind=text bytes=42 sensitive=false`. **No clipboard content anywhere** | |
| 22 | Tray icon → right-click → **Quit Cliptide** | App exits; no Cliptide process remains (Task Manager) | |

**Windows notes to record:** if endpoint protection or SmartScreen blocks the
run, record the product name and the rule.

---

### Pinned-item check (both platforms)

Pinning has no UI in M2, so verify it does not regress rather than exercising it:

Steps 8 and 16 must list your recent items in a stable order, and re-copying an
item already in history must move it to the top **without creating a duplicate
row**. Copy an earlier item again, summon, and confirm one row, at the top.

### If the shortcut does nothing

Another application already owns the combination. Cliptide falls back
automatically — check the terminal for a line beginning
`[cliptide] summon shortcut`, which names the accelerator that actually bound,
or `[cliptide] WARNING:` if none did. Use the tray icon to open the overlay and
record which accelerator was used.

---

## 9. Reporting template

Copy this, fill it in, and send it back. **It must contain no clipboard
contents.**

```
Cliptide M2 manual verification

Platform:            macOS __ / Windows __
OS version:          
Cliptide commit SHA: 
Electron version:    43.3.0
Node version:        
Shortcut used:       (from the [cliptide] summon shortcut log line)
Password manager:    (name + version, step 17)

A. M2 FUNCTIONAL VERIFICATION
  1  install / launch                        PASS / FAIL
  2  runs as background + tray app           PASS / FAIL
  5  global shortcut summons overlay         PASS / FAIL
  7  overlay receives keyboard focus         PASS / FAIL
  8  recent clipboard items appear           PASS / FAIL
  9  Arrow Up / Down navigation              PASS / FAIL
 10  Enter selects                           PASS / FAIL
 12  Enter restored the item (paste works)   PASS / FAIL
 11  overlay closes on Enter                 PASS / FAIL
 11  focus returned to previous app          PASS / FAIL
 13  Escape closes overlay                   PASS / FAIL
 14  Escape left clipboard unchanged         PASS / FAIL
 15  search filters                          PASS / FAIL
 16  clearing search restores history        PASS / FAIL
  -  re-copy promotes without duplicating    PASS / FAIL
 22  clean shutdown, no leftover process     PASS / FAIL

B. M2 VISUAL / UX VERIFICATION
  6  overlay appears above the other app     PASS / FAIL
  -  overlay is legible and correctly sized  PASS / FAIL
  -  selected row is obvious                 PASS / FAIL
  -  felt instant (no perceptible lag)       PASS / FAIL
  -  visible UI problems:                    (describe, or NONE)

C. PASSWORD-MANAGER PRIVACY VERIFICATION
 19  password absent from the overlay        PASS / FAIL
 20  password not searchable                 PASS / FAIL
 20  password not selectable / pasteable     PASS / FAIL
 21  no clipboard content in logs            PASS / FAIL
     (record booleans and format names only — never the value)

D. AUTOMATIC CROSS-APPLICATION PASTE
     NOT IMPLEMENTED — nothing to test.
     Cliptide restores the clipboard; the user presses paste themselves.
     Do not mark this PASS. See section 4.

OS permission prompts:   (what it asked, and once or repeatedly — or NONE)
Error output:            (paste terminal errors, or NONE)
Other observations:
```

### What a FAIL means

- **Step 19, 20, or 21 FAIL** — stop and report immediately. That is a privacy
  guarantee breaking, and it blocks the milestone.
- **Step 6 or 7 FAIL** — the overlay is not usable as a summonable utility;
  M2 is not complete.
- Anything else — record it and continue; the remaining steps are still useful.
