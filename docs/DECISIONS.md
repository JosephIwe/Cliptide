# Cliptide — Binding Decisions

Decisions that constrain future work. Each is settled; reopening one is a
deliberate act, not a drift.

## D1 — Cliptide is a standalone product repository

**Settled: yes.** The engine was originally developed inside an unrelated
project's repository. It carried no code, dependency, configuration, schema, or
environment coupling to that project, and it now lives here on its own, with its
own history preserved.

**Consequence:** nothing unrelated to a clipboard agent belongs in this
repository.

## D2 — The existing engine is the baseline

**Settled: retain.** Not because it exists, but on evidence: zero runtime
dependencies, one-way layering enforced by a test that reads the source, and a
suite that caught real defects during construction rather than confirming
assumptions.

**Consequence:** the engine is extended, not rewritten. Behavior changes need a
reason and a test.

## D3 — Electron is the desktop shell

**Settled: Electron.** It is the only option that runs this Node engine
unchanged in its main process, and it supplies the global shortcut, overlay
window, tray, and a mature signing and notarization path.

The cost is footprint, accepted knowingly. Tauri would be lighter but requires
porting the engine to Rust and re-earning its tests.

**Consequence:** Electron enters as a dependency of the desktop package **only**.
The engine package stays dependency-free, and a test enforces that.

## D4 — Encryption at rest is deferred, and is a release gate

**Settled: defer implementation, block public launch on it.**

History is currently plaintext on disk, protected only by owner-only file modes.
This is documented honestly in `SECURITY.md` and must not be described as
anything stronger.

**Consequence — this is a hard gate, not a backlog item:** Cliptide must not
have a public release until clipboard history is encrypted at rest with a key
held in the OS keychain. Shipping a privacy-first clipboard manager with
plaintext history would make the product's central claim false.

## D5 — Retention defaults

**Settled:** `maxItems` is **2,000**; `maxTotalBytes` remains the **primary**
storage bound.

Byte size is what actually protects the disk — a thousand text snippets cost
less than one screenshot — so the item count is a secondary guard against an
unbounded index, set high enough that users do not silently lose things they
expected to still find.

## D6 — The CLI clipboard sources are scaffolding and must not ship

**Settled: replace, do not extend.**

`capture/platform/win32.js` spawns a PowerShell process on every poll tick — at
the default interval, roughly 216,000 process launches per day. `darwin.js` is
cheaper but shares the same structural flaws: change detection by hashing
content instead of reading a real change counter, no image or file capture, and
no concealed-type detection.

They exist so the engine could be built and tested without a desktop, and they
are honest about their limits in their own headers.

**Consequence:** no feature work goes into these files. They are replaced by a
native source implementing the same `ClipboardSource` contract. Nothing above
`capture/source.js` changes when that happens.

## D7 — No AI provider until the local product is stable

**Settled: not yet.**

The agent boundary exists — a resolver contract plus a deterministic local
implementation — and a test asserts that no AI provider is importable from the
agent layer. That is the intended state.

**Consequence:** no provider SDK, no API key handling, and no network client
enters this repository until the local MVP ships. A resolver that needs
clipboard content would require an explicit, user-consented channel that does
not exist today and must not be added quietly.
