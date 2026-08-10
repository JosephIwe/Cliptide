# Milestone 0 — Audit and Architecture Proposal

Status: **awaiting approval**. Nothing in this document has been implemented as a
result of it. It records what the repository already contains, what was decided
implicitly by that code, and which decisions are still genuinely open.

---

## 0. Audit findings

### 0.1 The engine already exists

This is the finding that changes how the rest of this document should be read.

A prior session on this branch (`claude/cliptide-clipboard-agent-jkiaky`, six
commits) already built Cliptide's engine through what it labelled M0–M5:

| Area | Files | Tests |
| --- | --- | --- |
| `core/` domain model | 7 | 50 |
| `storage/` log, blobs, retention | 6 | 74 |
| `capture/` monitor, exec, adapters | 7 | 47 |
| `search/` | 1 | 18 |
| `history/` facade | 1 | 18 |
| `settings/` | 3 | 14 |
| `agent/` boundary | 3 | 27 |
| bootstrap + structural tests | 3 | 18 |
| **Total** | **31 src files, 4,089 lines** | **266 passing** |

So "inspect the repository first" produces an unusual result: the architecture
this milestone was meant to propose is largely already in the tree and under
test. This document therefore does two jobs — it states the architecture
explicitly for approval, and it marks each decision **[IMPLEMENTED]** or
**[OPEN]** so approval means something concrete.

If the intent was a clean-slate design, say so and I will treat the existing
code as a prototype to be replaced rather than a baseline to be extended.

### 0.2 The repository is not a clipboard project

`JosephIwe/Tradr` is an active AI crypto trading desk — market adapter, scoring,
risk, paper trading, journal, analytics — at its own Milestone 6, with 254
passing tests and commits from the same day. Cliptide currently lives in an
isolated `cliptide/` subdirectory with its own manifest and test suite; **zero
Tradr files are modified** on this branch.

That isolation is deliberate and reversible, but it is not a resolution.
**[OPEN]** — see §9.

### 0.3 Development environment

| | |
| --- | --- |
| Node | v22.22.2 (npm 10.9.7) |
| Platform | Linux x86_64, containerised, ephemeral |
| Rust / cargo | 1.94.1 — present, so Tauri is toolchain-feasible |
| npm registry | reachable (`electron@43.3.0` resolves) |
| Disk | ~30 GB writable |
| **Display server** | **none** — `DISPLAY` and `WAYLAND_DISPLAY` unset |
| **Clipboard CLIs** | **none** — `xclip`, `wl-paste`, `pbpaste`, `powershell` all absent |
| Chromium | headless shell only, at `/opt/pw-browsers` |

Two consequences drive the plan:

1. **No UI or global shortcut can be verified here.** Anything requiring a real
   desktop session must be built against interfaces and validated on a Mac or
   Windows machine. This is why the shell is last, not first.
2. **No real clipboard exists here either.** The platform adapters cannot be
   exercised end-to-end in this container; only their command construction and
   parsing can be. Existing tests reflect that honestly by injecting a fake
   command runner rather than pretending to drive a pasteboard.

---

## 1. Architecture proposal

A single local process, layered one way, with the UI as a replaceable shell.

```
        ┌─────────────────────────────────────────────┐
        │  Shell (M6): overlay · global shortcut ·    │
        │  tray · synthetic paste                     │
        └──────────────────┬──────────────────────────┘
                           │  depends on nothing below this line
        ┌──────────────────▼──────────────────────────┐
        │  HistoryService — the only public surface   │
        └───┬───────────────┬──────────────────┬──────┘
            │               │                  │
     ┌──────▼─────┐  ┌──────▼──────┐   ┌───────▼───────┐
     │  capture/  │  │   search/   │   │    agent/     │
     │  monitor + │  │  pure, no   │   │  resolver     │
     │  platform  │  │     I/O     │   │  contract     │
     └──────┬─────┘  └──────┬──────┘   └───────┬───────┘
            │               │                  │
        ┌───▼───────────────▼──────────────────▼──────┐
        │  storage/ — append-only log · blobs ·        │
        │  retention · settings                        │
        └──────────────────┬──────────────────────────┘
        ┌──────────────────▼──────────────────────────┐
        │  core/ — model · hash · ids · redaction      │
        │  pure, standard library only                 │
        └─────────────────────────────────────────────┘
```

**Principles.** Arrows point down only. `core/` imports nothing but the Node
standard library. The UI touches `HistoryService` and nothing else, so the
shell can be Electron, native, or a CLI without the engine noticing. No layer
holds a network client.

**[IMPLEMENTED]** — and enforced by `tests/privacy.boundaries.test.js`, which
reads the source and fails on a layering violation, a network import, a
`fetch` call, an AI-provider reference, or a non-empty `dependencies` block. An
architectural rule nothing checks is a comment that will quietly stop being
true.

---

## 2. Recommended cross-platform stack

**Recommendation: Electron for the shell, keeping the existing Node engine
unchanged in the main process.**

### The candidates

| | Electron | Tauri v2 | Node daemon + native helper |
| --- | --- | --- | --- |
| Install size | ~150–250 MB | ~5–15 MB | ~50 MB |
| Idle RAM | ~110–180 MB | ~40–80 MB | ~40 MB |
| Reuses the 266-tested engine | **yes, unchanged** | no — backend is Rust | yes |
| Global shortcut | built in | plugin | must build |
| Overlay window | built in | built in | **no UI toolkit** |
| Pasteboard type access | likely (§2.2) | via Rust crates | via own addon |
| macOS notarization path | mature | maturing | manual |

### 2.1 Why Electron wins here despite being the heaviest

The decision is not "which framework is nicest" — it is "which one ships a
correct product soonest without discarding tested work."

- **Tauri is the better-behaved shell and the wrong choice today.** Its backend
  is Rust; the 4,089-line engine is JavaScript running under Node. Tauri's
  webview has no filesystem access, so the engine cannot simply move into the
  renderer. Choosing Tauri means rewriting storage, capture, retention, and the
  agent boundary in Rust and re-earning 266 tests. That is a real option if
  footprint is the top priority — but it should be chosen deliberately, not
  discovered halfway.
- **A bare Node daemon has no way to draw the overlay**, which is a core MVP
  requirement, so it only defers the problem.
- **Electron runs the engine as-is** in the main process, supplies
  `globalShortcut`, a frameless always-on-top `BrowserWindow` for the overlay,
  a tray icon, and a mature signing/notarization/auto-update path.

The cost is memory. It is mitigated, not ignored: one overlay window created
once and hidden rather than recreated, `backgroundThrottling` left on, no
renderer work while hidden, and the engine's own bounded-memory guarantees
(capped previews, blob spill, bounded scans) already prevent history size from
reaching the UI. Expected idle: one hidden renderer plus the main process.

**If a sub-50 MB footprint is a hard product requirement, say so now** — that
inverts the recommendation to Tauri and adds a Rust port to the plan, and it is
far cheaper to decide before M6 than after.

### 2.2 The one thing that must be verified first

Electron's `clipboard.availableFormats()` and `clipboard.read(format)` are the
plausible mechanism for detecting password-manager markers
(`org.nspasteboard.ConcealedType` on macOS,
`ExcludeClipboardContentFromMonitorProcessing` on Windows) — the single
outstanding gap in the privacy model, since no shipped CLI can enumerate
pasteboard types.

I have **not verified** that Electron surfaces custom UTIs rather than mapping
formats to a known MIME subset. That verification is the first task of the
shell milestone, and it is a gate, not a detail: if it fails, the fallback is a
small N-API addon reading `NSPasteboard.types` / `GetClipboardSequenceNumber`
directly. Shipping a privacy guarantee that silently fails would be worse than
the currently documented gap.

### 2.3 Dependencies

Zero runtime dependencies today, and the engine stays that way. Electron enters
as a dev/build dependency of the shell package only. A supply-chain surface is
a privacy surface.

---

## 3. Module boundaries

| Module | Owns | Must not know about |
| --- | --- | --- |
| `core/` | ClipItem model, hashing, ids, redaction, clock | disk, platform, UI, anything above it |
| `storage/` | durability, blobs, retention, settings | capture, UI, agent |
| `capture/` | `ClipboardSource` contract, poll loop, per-OS adapters | search, UI, agent |
| `search/` | ranking, filters, highlight offsets | disk, UI |
| `history/` | the single public facade | how storage persists, how capture polls |
| `agent/` | resolver contract + local resolver | clipboard content, any provider |
| `settings/` | validated, versioned config | everything else |
| **shell (M6)** | overlay, shortcut, tray, paste | anything below `history/` |
| **sync (future)** | — | must enter *above* `storage/`, never inside it |

### 3.1 The three seams that matter

**Clipboard capture** is `ClipboardSource`: `changeToken()`, `read()`,
`write()`. Sources declare `cheapToken: boolean` so the cost of change
detection is visible rather than surprising. The monitor knows nothing else,
which is why the same loop runs against a CLI source, a native source, and an
in-memory fake with no conditionals. **[IMPLEMENTED]**

**The agent boundary** is `resolve(request, context) → AgentPlan`. A resolver
returns a *declarative query*, never an answer and never an action; the engine
executes it locally. The context a resolver receives is metadata only — counts,
kinds, time bounds, current time. No previews, no payloads, **not even content
hashes**. A future model-backed resolver could therefore decide *what to look
for* without any copied text leaving the machine, and the part that touches
content stays local. Plans are validated and clamped before execution, because
a resolver's output is untrusted input. **[IMPLEMENTED]**

**Sync**, when it exists, is a consumer of `HistoryService`, not a feature of
`storage/`. It must not be able to observe writes from inside the store. That
placement is what keeps "local-first" structurally true instead of a promise.
**[OPEN — deliberately not started]**

---

## 4. Local data model and retention

### 4.1 Model **[IMPLEMENTED]**

`ClipItem` — one durable record per distinct piece of content.

| Field | Purpose |
| --- | --- |
| `id` | ULID-shaped, sortable, monotonic — history order needs no sequence column |
| `hash` | content fingerprint; the dedupe key *and* the blob address |
| `kind` / `format` | `text` today; `image` and `files` modeled now so adding them is not a schema break |
| `text` | inline payload, capped at 4,096 chars when spilled — bounded memory regardless of what was copied |
| `blobRef` | set when the payload exceeds the inline limit (256 KB default) |
| `bytes` | true full size, even when truncated |
| `pinned` | exempt from every automatic deletion path |
| `sensitive` / `secretLabels` | drives preview masking and the shorter retention clock |
| `copyCount` / `updatedAt` | re-copy promotes rather than duplicates |

### 4.2 Persistence **[IMPLEMENTED]**

An **append-only JSONL operation log** (`put` / `delete`) replayed into an
in-memory index, plus content-addressed blobs and an atomically-replaced
settings file.

Why not SQLite: clipboard history is append-heavy, small-read, single-writer.
A log gives crash-safety structurally — no existing byte is ever rewritten, so
no prior record can be damaged by a later failure — with no native module to
build per platform. `ClipStore` is an interface; if history sizes ever justify a
database it swaps without touching callers.

Three properties are load-bearing and tested: **tail repair on open** (a torn
final record is truncated *before* the append handle opens, so the next write
cannot weld onto it and corrupt the file's middle), **corruption tolerance** (a
damaged line is skipped and reported by number, never fatal), and **atomic
compaction** (temp file → fsync → rename; an interrupted compaction is detected
and discarded).

### 4.3 Retention **[IMPLEMENTED, defaults OPEN]**

Pure policy evaluation returning *what expires and why*; the store acts on it.

| Limit | Default | Rationale |
| --- | --- | --- |
| `maxItems` | 500 | **[OPEN]** — conservative; most managers default 1,000–5,000 |
| `maxAgeMinutes` | 14 days | long enough to be worth searching |
| `secretRetentionMinutes` | 15 | a token copied an hour ago should not be in a searchable list |
| `maxTotalBytes` | 256 MB | bounds disk without user attention |

Age is measured from **last use**, so re-copying keeps something fresh. Every
expiry carries a machine-readable reason. **Pinned items are exempt from all
four limits** — a pin is the user saying "keep this", and no automatic policy
outranks that.

---

## 5. Privacy / security threat model

| # | Threat | Mitigation | State |
| --- | --- | --- | --- |
| T1 | Copied secrets exfiltrated over the network | No network client anywhere in the engine; enforced by a source-reading test | **[IMPLEMENTED]** |
| T2 | Password-manager content recorded | Concealed/transient markers dropped before hashing, previewing, or writing | **[IMPLEMENTED]** for the model and Linux; **[OPEN]** for macOS/Windows (§2.2) |
| T3 | Credentials visible in the overlay | Heuristic detection → masked previews; full value still retrievable | **[IMPLEMENTED]** |
| T4 | Secrets linger in searchable history | Shorter retention clock for flagged items | **[IMPLEMENTED]** |
| T5 | Clipboard content leaks into logs or crash traces | Errors carry sizes/hashes/reasons only; a test rejects `console.*(payload)` | **[IMPLEMENTED]** |
| T6 | Content sent to an AI provider | Agent context is metadata-only by construction; no provider importable | **[IMPLEMENTED]** |
| T7 | Another local user reads history | Files `0600`, directories `0700`, under per-user app data | **[IMPLEMENTED]** |
| T8 | **Attacker with disk access reads history** | **None — not encrypted at rest** | **[OPEN]** |
| T9 | Malicious clipboard content attacks the app | Control characters stripped from previews; child args never pass through a shell; blob keys must be sha256, so traversal is impossible | **[IMPLEMENTED]** |
| T10 | Hostile/buggy resolver issues an unbounded query | Plans validated and clamped; secrets opt-in | **[IMPLEMENTED]** |
| T11 | Supply-chain compromise via a dependency | Zero runtime dependencies; asserted by test | **[IMPLEMENTED]** |
| T12 | Memory scraping by a local debugger | **Out of scope** — no user-space manager can prevent this | accepted |

### Explicitly not claimed

**History is not encrypted at rest.** An attacker with your logged-in account
can read it, exactly as they could read your documents. OS-keychain-backed
encryption is the obvious next step. **[OPEN]** — I recommend deferring it until
after the shell, because a keychain integration is untestable in this
environment and would otherwise be the third unverifiable thing in flight.

Secret detection is a **documented heuristic**, not a guarantee. It will miss
secrets with no recognizable shape. Flagging never deletes anything by itself.

---

## 6. MVP acceptance criteria

Testable, and marked with what already holds.

| # | Criterion | State |
| --- | --- | --- |
| A1 | Copying text records it within one poll interval | ✅ tested |
| A2 | Re-copying promotes the existing entry; history never duplicates | ✅ tested |
| A3 | Concealed content is never written to disk in any form | ✅ tested (model + Linux) |
| A4 | History survives process restart, power loss, and a corrupt line | ✅ tested |
| A5 | Pinned items survive every automatic deletion path | ✅ tested |
| A6 | Retention expires by age, count, size, and a shorter secret clock | ✅ tested |
| A7 | Search returns ranked results with stable ordering | ✅ tested |
| A8 | Selecting an item places the **complete** payload on the clipboard | ✅ tested |
| A9 | The agent's own paste is not recorded as a new copy | ✅ tested |
| A10 | Oversized payloads are refused or spilled, never held whole twice | ✅ tested |
| A11 | A source failure backs off and recovers without killing the process | ✅ tested |
| A12 | Sleep/wake resumes cadence without replaying missed intervals | ✅ tested |
| A13 | Settings validate, persist atomically, and survive corruption | ✅ tested |
| A14 | Natural-language requests resolve locally with no provider | ✅ tested |
| **A15** | **Global shortcut summons the overlay from any focused app** | ❌ M6 |
| **A16** | **Overlay appears in < 150 ms and is keyboard-navigable** | ❌ M6 |
| **A17** | **Selection pastes into the previously focused app** | ❌ M6 |
| **A18** | **Concealed detection verified on real macOS and Windows** | ❌ M6 |
| **A19** | **Idle CPU < 1%, idle RSS within the agreed budget** | ❌ M6 |
| **A20** | **Accessible: focus order, screen-reader labels, honours reduced-motion** | ❌ M6 |

**14 of 20 hold today. The remaining six all require a real desktop session.**

---

## 7. Test strategy

**Current, 266 tests. [IMPLEMENTED]**

- **Injectable clock everywhere.** No test sleeps. Sleep/wake, backoff, and
  retention are driven by advancing a manual clock, which is why the capture
  suite runs in milliseconds and is not flaky.
- **In-memory `ClipboardSource`.** The whole capture suite runs with no display
  server, which is what makes it runnable here at all.
- **Temp data directory per test**, so the suite never touches real history and
  stays order-independent.
- **Fault injection over mocking.** Torn records, corrupt lines, leftover temp
  files, deleted blobs, and throwing sources are produced for real and the
  recovery asserted.
- **Structural tests.** Architecture and privacy claims are checked by reading
  the source, so they fail loudly when violated.
- **Property-flavoured checks** where cheap: id monotonicity under clock
  regression and same-millisecond bursts; hash domain separation; search
  ordering stability under input permutation.

**Gaps, and how they get closed:**

| Gap | Plan |
| --- | --- |
| No real-clipboard test on any platform | Platform smoke suite, run manually on a Mac and a Windows box, gated in CI to those runners |
| No UI tests | Overlay driven via Playwright against Electron once the shell exists |
| No performance regression guard | Add a benchmark for search over 10k items and idle CPU sampling in M6 |
| Concealed detection unverified on macOS/Windows | The §2.2 spike, as an acceptance gate |

---

## 8. Implementation order

### 8.1 As executed (M1–M3 in the original numbering) — for the record

The order was chosen so each milestone could be fully tested before the next
depended on it, and it held up:

1. **M1 — core domain model.** Pure, no I/O. Everything else consumes it, so
   getting `ClipItem`, hashing, ids, and redaction wrong would have been
   expensive later. *Three real bugs were caught here by tests, not review:*
   ids could repeat when the random space overflowed inside one millisecond;
   previews stripped newlines as control characters and welded words together;
   and the manual clock ran time backwards when firing a timer left overdue by
   a simulated sleep — which had been hiding the entire wake-detection path.
2. **M2 — storage.** Durability before capture, so the first captured item was
   never at risk. Tail repair, corruption tolerance, atomic compaction.
3. **M3 — capture.** Only once there was somewhere safe to put things.

### 8.2 Proposed next three — what approval actually unblocks

Since M1–M3 are complete, the actionable ordering is the shell, split so the
riskiest unknown is resolved first rather than last:

**Next-1 — Native source spike (gate, ~small).**
Verify Electron can detect concealed pasteboard types on macOS and Windows
(§2.2). Implement `ClipboardSource` over Electron's `clipboard`, including a
real change token and image payloads. *Exit:* A18 provably holds, or the N-API
fallback is scoped. **Nothing else in the shell starts until this resolves** —
it is the only remaining hole in the privacy model, and it can invalidate the
stack choice.

**Next-2 — Overlay and shortcut.**
Frameless always-on-top window bound to `settings.ui.summonShortcut` (already
validated as an accelerator). Consumes `HistoryService.search()`; results
already carry `highlights` offsets indexed into `preview`, ready to render.
Keyboard-first: type to filter, arrows to move, Enter to paste, Escape to
dismiss. *Exit:* A15, A16, A20.

**Next-3 — Paste, tray, and packaging.**
Synthetic paste into the previously focused app after `history.use(id)`, tray
icon with pause/resume and quit, then signing, notarization, and installers for
macOS and Windows. *Exit:* A17, A19; MVP complete.

Each ends with tests run, behaviour verified on a real desktop, and a written
report of what changed and what is blocked — as with M1–M5.

---

## 9. Decisions I need from you

| # | Decision | My recommendation |
| --- | --- | --- |
| **D1** | **Does Cliptide belong in the Tradr repo?** It is currently isolated in `cliptide/` with zero Tradr files touched, but Tradr is an unrelated, actively developed product. | **Move to its own repo.** Two products in one repo means shared CI, shared release tags, and a confusing history for both. The directory lifts out unchanged. |
| **D2** | **Is the existing engine a baseline or a prototype?** This document assumes baseline. | **Baseline.** 266 tests, no dependencies, layering enforced. Re-deriving it would cost days and buy nothing. |
| **D3** | **Electron, or Tauri with a Rust port?** | **Electron**, unless sub-50 MB idle is a hard requirement — decide now, not after M6. |
| **D4** | **Encryption at rest — now or after the shell?** | **After.** Keychain integration is unverifiable in this environment; shipping it untested alongside two other unverifiable things is how privacy features silently fail. |
| **D5** | **Is `maxItems: 500` the right default?** | Raise to **2,000**. Storage is bounded by `maxTotalBytes` anyway, and 500 is low enough that users will hit it and lose things they expected to find. |

---

**Awaiting approval before implementing anything.**
