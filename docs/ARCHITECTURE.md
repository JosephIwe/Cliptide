# Cliptide Architecture

Cliptide is a local-first clipboard agent. It keeps a durable history of what you
copy and lets you summon that history from anywhere: **Copy → Remember → Summon →
Select → Paste**.

This document fixes the module boundaries before feature work spreads across them.
Every boundary below is an interface, not a suggestion: the capture layer knows
nothing about storage, storage knows nothing about the UI, and no layer knows
anything about an AI provider.

## Non-negotiable properties

1. **Local-first.** All state lives on the user's disk. There is no network client
   anywhere in the engine, and no module may add one without an explicit,
   user-facing consent gate.
2. **Never silently destroy user data.** Deletions are explicit and auditable.
   Retention is a policy that reports what it removed. Pinned items are never
   evicted by any automatic policy.
3. **Crash-safe.** A power loss mid-write must not corrupt history. Readers
   tolerate a torn trailing record instead of failing closed.
4. **Quiet and lightweight.** The background monitor does bounded work per tick
   and holds bounded memory regardless of history size or payload size.
5. **Secret-aware.** Content that the OS marks concealed (password managers) is
   never persisted. Content that looks like a credential is flagged and masked in
   previews.

## Module boundaries

```
src/core/       Domain model. Pure, dependency-free, no I/O.
                types.js   ClipItem shape, content kinds, validation, previews
                ids.js     sortable monotonic ids
                hash.js    content fingerprinting (dedupe key)
                redact.js  sensitive-content classification + masking
                clock.js   injectable time source (tests never sleep)
                errors.js  structured error kinds

src/storage/    Durability. Knows the disk, not the domain rules.
                paths.js       per-platform data directory resolution
                log.js         append-only JSONL with atomic durable writes
                blobs.js       content-addressed spill for large payloads
                store.js       ClipStore: the persistence contract
                retention.js   retention policy evaluation (pure)

src/capture/    The clipboard watcher.
                source.js      ClipboardSource interface + in-memory fake
                monitor.js     poll loop, dedupe, debounce, pause/resume
                platform/      per-OS ClipboardSource implementations

src/search/     Ranked query over history. Pure, no I/O.

src/history/    HistoryService: the single facade the UI and agent consume.

src/agent/      Natural-language boundary. Provider-agnostic by construction:
                a resolver interface plus a deterministic local implementation.

src/settings/   Validated, versioned user settings with safe defaults.
```

### Dependency direction

```
capture ──▶ history ──▶ storage ──▶ core
                │           │
   agent ───────┤           └──▶ (disk)
    ui  ────────┘
search ──▶ core
```

Arrows point at dependencies. Nothing points back up. `core` imports nothing but
the Node standard library. The UI shell depends on `history` only — it can be
replaced (Electron, native, CLI) without touching anything below it.

## The clipboard item

A `ClipItem` is the durable unit of history. Full shape and validation rules live
in `src/core/types.js`; the fields that matter architecturally:

| Field | Why it exists |
| --- | --- |
| `id` | Monotonic, lexicographically sortable. History order needs no separate sequence. |
| `hash` | Content fingerprint. The dedupe key — re-copying promotes instead of duplicating. |
| `kind` / `format` | `text` is the MVP payload; `image` and `files` are modeled now so adding them later is not a schema break. |
| `text` / `blobRef` | Small payloads inline, large payloads spilled to content-addressed blobs. The engine never holds an unbounded string. |
| `pinned` | Pinned items are exempt from every automatic eviction path. |
| `sensitive` / `secretLabels` | Drives preview masking and retention policy. |
| `copyCount` / `updatedAt` | Re-copy promotes an existing item; this is where that is recorded. |

## Persistence design

History is an **append-only JSONL log** plus a derived in-memory index, the same
shape Cliptide uses for every durable surface:

```
<dataDir>/history.jsonl     append-only operation log
<dataDir>/blobs/<hash>      content-addressed large payloads
<dataDir>/settings.json     user settings (atomic replace)
```

The log records *operations* (`put`, `promote`, `pin`, `delete`), not final state.
Replaying the log yields current history. This is what makes crash-safety cheap:
an append that does not complete leaves a torn final line, which the reader drops.
No prior record is ever at risk, because no prior byte is ever rewritten.

**Why not SQLite.** A clipboard history is an append-heavy, small-read workload
with one writer. An append-only log gives crash-safety and zero native
dependencies, which keeps the background process light and the build portable
across macOS, Windows, and Linux. `ClipStore` is an interface — if history sizes
ever justify a real database, it can be swapped without touching callers.

**Compaction.** The log grows with operations, not with distinct items. When the
ratio of records to live items crosses a threshold, the store rewrites a compacted
log to a temp file and atomically renames it over the original. A crash during
compaction leaves the original log intact; the temp file is discarded on the next
open.

## Capture design

The monitor polls, because no mainstream OS offers a reliable, permission-free
clipboard change *push* notification. Polling is made cheap by reading a
**change token** first (macOS `NSPasteboard.changeCount`, Windows
`GetClipboardSequenceNumber`, Linux selection ownership) and only reading the
payload when the token moves. Idle cost is one cheap syscall per tick.

The monitor handles, and has tests for:

- **Duplicate events.** Same hash as the newest item → promote, never duplicate.
- **Large payloads.** Reads are capped; oversized content is spilled or skipped by
  policy, never held whole in memory twice.
- **Sleep/wake.** A tick gap far longer than the poll interval means the machine
  slept; the monitor resynchronizes its change token instead of replaying stale
  content.
- **Source failure.** A throwing source backs off exponentially and recovers
  instead of killing the process.
- **Pause.** An explicit pause stops persistence without stopping the loop, so
  the change token stays current and resuming does not capture a backlog.

## Agent boundary

The agent surface is a contract, not an implementation:

```js
resolve(request, context) -> AgentPlan   // { intent, filters, limit, explanation }
```

`src/agent/local.js` implements it deterministically with no AI provider and no
network. A future LLM-backed resolver implements the same interface, and the
clipboard engine is unaware either way. The engine never calls a provider, and no
clipboard content is transmitted anywhere by any code path in this repository.

## Enforced, not just documented

The architectural claims above are checked by `tests/privacy.boundaries.test.js`,
which reads the source rather than trusting the prose:

- no module imports a network transport (`node:http`, `net`, `tls`, …)
- no module calls `fetch`, `XMLHttpRequest`, `WebSocket`, or `sendBeacon`
- `core/` imports nothing outside the standard library
- the dependency direction never points back up
- the agent layer names no AI provider
- the package declares zero dependencies
- no `console` call is handed a clipboard payload

A layering violation or a new network client fails the suite, which forces the
change to be deliberate and visible instead of quiet.

## Milestone status

| Milestone | Scope | State |
| --- | --- | --- |
| M0 | Workspace, architecture, security model | complete |
| M1 | Core domain model | complete |
| M2 | Storage, blobs, retention | complete |
| M3 | Capture engine + platform adapters | complete |
| M4 | Search, history service, settings | complete |
| M5 | Agent boundary | complete |
| M6 | Desktop shell: overlay, global shortcut, paste | not started |

M6 is the remaining MVP surface. Everything below it is engine work that runs and
is tested headlessly; M6 is the part that needs a real desktop session to verify.

### What M6 must supply

The interfaces it plugs into already exist, so M6 adds implementations rather
than architecture:

1. **Native clipboard sources** implementing `ClipboardSource` — `changeCount`
   on macOS and `GetClipboardSequenceNumber` on Windows for a genuinely cheap
   change token, image payloads, and the concealed-type checks the CLI sources
   cannot perform. This is the one outstanding gap in the privacy model.
2. **A global shortcut** bound to `settings.ui.summonShortcut`, already
   validated as an accelerator.
3. **An overlay window** consuming `HistoryService.search()` — results carry
   `highlights` indexed into `preview`, ready to render.
4. **Synthetic paste** after `history.use(id)` places the payload.

None of these require a change below `src/history/`.
