# Cliptide

A privacy-first, local-first clipboard agent.

**Copy → Remember → Summon → Select → Paste.**

Cliptide keeps a durable history of everything you copy and lets you summon it
from anywhere. It runs entirely on your machine. Nothing you copy is uploaded,
logged, or transmitted — not by default, not by a setting you might forget, and
not by a dependency you did not choose.

## Status

The **engine is complete and tested**: capture, storage, search, retention,
settings, and the agent boundary. 266 tests pass, and the whole product loop
runs headlessly.

The **desktop shell is not built yet** — the overlay window, the global summon
shortcut, and the synthetic paste keystroke are M6. Until then Cliptide is a
library and a demo, not something to install. Everything below describes what
actually runs today.

```
npm run demo   # the full loop, headless, in a temp directory
npm test       # runs every workspace suite
```

## What it does today

| Capability | State |
| --- | --- |
| Background clipboard monitoring | Working — polling with cheap change tokens, backoff, sleep/wake handling |
| Local persistent history | Working — crash-safe append-only log with recovery |
| Configurable retention | Working — by age, count, total size, with a shorter clock for secrets |
| Pin / favourite | Working — pins are exempt from every automatic deletion path |
| Search | Working — ranked, explainable, bounded cost |
| One-action retrieval | Working — `history.use(id)` resolves blobs and writes the clipboard |
| Settings | Working — validated, atomic, safe defaults |
| Secure handling of clipboard content | Working — see [Privacy](#privacy) |
| Natural-language requests over history | Working — deterministic local resolver, no AI provider |
| Global summon shortcut + overlay | **Not built (M6)** |
| Cloud sync | **Deliberately absent** until the local MVP is stable |

## Privacy

Full detail in [docs/SECURITY.md](docs/SECURITY.md). The short version:

- **Clipboard content never leaves the machine.** There is no network client
  anywhere in the engine. This is enforced by a test that reads the source and
  fails if anyone adds one — see `packages/engine/tests/privacy.boundaries.test.js`.
- **Password managers are never recorded.** Content marked concealed or
  transient by the OS is dropped before it is hashed, previewed, or written.
- **Credential-shaped content is masked in previews** and expires on a shorter
  clock (15 minutes by default). Masking is display-only; the real value is
  always retrievable. Detection is a documented heuristic, not a guarantee.
- **History is not encrypted at rest.** Said plainly rather than implied
  otherwise. Files are owner-only (`0600`) under your user data directory.
  Keychain-backed encryption is planned, and claiming it before it ships would
  be the security theater this project exists to avoid.
- **Deletion is real.** Removed items leave the log at the next compaction and
  their payloads are unlinked. Nothing is soft-hidden while staying on disk.

## Architecture

Full detail in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```
packages/engine/src/core/      domain model — pure, no I/O, standard library only
packages/engine/src/storage/   append-only log, content-addressed blobs, retention
packages/engine/src/capture/   clipboard source contract, poll loop, per-OS adapters
packages/engine/src/search/    ranked query, pure
packages/engine/src/history/   HistoryService — the only surface the UI and agent touch
packages/engine/src/agent/     provider-agnostic natural-language boundary
packages/engine/src/settings/  validated, versioned user settings
```

Dependencies point one way only, and a test enforces that too. The UI depends on
`history` and nothing below it, which is what makes the desktop shell
replaceable — Electron, native, or CLI — without touching the engine.

**Zero runtime dependencies.** A supply-chain surface is a privacy surface.

### Why an append-only log rather than SQLite

Clipboard history is an append-heavy, small-read workload with a single writer.
A log gives crash-safety for free — no existing byte is ever rewritten, so no
prior record can be damaged by a later failure — with no native module to build
per platform. `ClipStore` is an interface; if history sizes ever justify a real
database, it swaps without touching callers.

## Using the engine

```js
import { createCliptide } from '@cliptide/engine';

const app = await createCliptide();
await app.start();

// Summon → Select → Paste
const [best] = app.history.search('invoice');
await app.history.use(best.item.id);

// Or ask in plain language — resolved locally, no provider involved
const { results, explanation } = await app.ask('what did I copy this morning');
```

### The agent boundary

`app.ask()` runs a resolver that turns a request into a **plan** — a
declarative query — which the engine then executes locally.

The resolver receives **metadata only**: history size, kinds present, counts,
time bounds. Not previews, not payloads, not even content hashes. So a future
LLM-backed resolver could decide *what to look for* without any copied text
leaving the machine, and the part that touches content stays local. Plans are
validated and clamped before execution, because a resolver's output is never
trusted.

Swapping resolvers is one argument:

```js
await app.ask('the key from this morning', myResolver);  // same contract
```

No AI provider is wired in, and a test asserts the agent layer imports none.

## Platform support

macOS and Windows are the priority targets; Linux uses the same interface
rather than a special case.

| Platform | Source | Concealed-content detection |
| --- | --- | --- |
| macOS | `pbpaste` / `pbcopy` | Pending — needs the native source (M6) |
| Windows | PowerShell `Get-Clipboard` | Pending — needs the native source (M6) |
| Linux | `wl-paste` / `xclip` | Working — reads the KDE password-manager hint |

The CLI sources are the portable fallback: they work on a stock system with no
native modules, which is what makes the engine runnable and testable before a
shell exists. They cannot enumerate pasteboard types on macOS and Windows, so
those platforms' concealed-content check waits for the native sources rather
than shipping an unreliable one — a privacy guarantee that silently fails is
worse than one documented as pending.

## Data location

| Platform | Path |
| --- | --- |
| macOS | `~/Library/Application Support/Cliptide` |
| Windows | `%APPDATA%\Cliptide` |
| Linux | `$XDG_DATA_HOME/cliptide` (default `~/.local/share/cliptide`) |

`CLIPTIDE_DATA_DIR` overrides all of them.

## Next milestone

**M6 — the desktop shell.** Global summon shortcut, compact overlay, synthetic
paste, tray, and native clipboard sources with real change counters, image
support, and concealed-type detection on macOS and Windows.

Everything M6 needs already exists as an interface. It is the one part that
cannot be verified without a real desktop session, which is why it is last.
