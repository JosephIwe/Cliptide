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

## 8. Remaining manual verification

On a real Mac and a real Windows machine:

```bash
npm install
npx electron packages/desktop/src/main.js
```

Then confirm:

1. No window appears at launch; a tray icon does.
2. `Cmd/Ctrl+Shift+V` summons the overlay **over another focused application**.
3. ↑/↓ move the highlight; the first row is selected on open.
4. Typing filters; clearing the box restores recent history.
5. **Enter** puts the item on the clipboard, the overlay closes, focus returns
   to the previous app, and `Cmd/Ctrl+V` pastes it.
6. **Escape** dismisses and the clipboard is unchanged.
7. Copy from a password manager — it must **not** appear in the overlay.
8. Tray → Quit shuts down cleanly with no leftover process.
9. Pressing the shortcut again while open dismisses.
10. On macOS: note whether a paste-permission prompt appears, and whether once
    or repeatedly.

Item 7 is the same manual password-manager test M1 left open; the overlay is now
the surface where a failure would be visible.
