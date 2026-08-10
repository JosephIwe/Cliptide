# Cliptide Security & Privacy Model

A clipboard manager sees everything you copy: passwords, tokens, private messages,
card numbers. That makes it one of the most sensitive processes on a personal
machine. This document states what Cliptide does about that, precisely enough to
be checked against the code.

## The core promise

**Clipboard content never leaves the machine.**

This is enforced structurally, not by policy: no module under `packages/engine/src/` imports a
network client, and `core/` imports nothing outside the Node standard library.
There is no telemetry, no crash reporting with payloads, no analytics, and no
sync. Adding any of those requires new code at a boundary that does not exist
today, which is the point — it cannot happen by accident or by a transitive
dependency update.

## Concealed content is never persisted

Password managers mark clipboard content as transient so managers can skip it.
Cliptide honors those markers before any other rule:

| Platform | Marker |
| --- | --- |
| macOS | `org.nspasteboard.ConcealedType`, `org.nspasteboard.TransientType` |
| Windows | `ExcludeClipboardContentFromMonitorProcessing`, `CanIncludeInClipboardHistory=0` |
| Linux | `x-kde-passwordManagerHint: secret` |

A snapshot carrying any of these is dropped at the capture boundary. It is not
hashed, not previewed, not written, and not counted. See
`isConcealed()` in `packages/engine/src/core/types.js` and the drop path in
`packages/engine/src/capture/monitor.js`.

## Credential-shaped content is flagged and masked

Beyond OS markers, Cliptide classifies content that *looks* like a credential:
private key blocks, cloud provider keys, service tokens (GitHub, Slack, Stripe,
Google, OpenAI/Anthropic), JWTs, `password=`/`secret=` assignments, and
Luhn-valid card numbers. See `packages/engine/src/core/redact.js`.

Classification drives three behaviors:

1. **Previews are masked.** The matched span is replaced with `•` before the
   preview string is built, so a shoulder-surfer reading the overlay sees
   `sk-ant-••••••••`, not the key. The full value is still retrievable — masking
   is a display rule, not data loss.
2. **Retention can be stricter.** `secretRetentionMinutes` expires flagged items
   ahead of ordinary history. Default: 15 minutes.
3. **Storage can be refused.** `secretPolicy: 'skip'` drops flagged content at
   capture instead of storing it.

Detection is a heuristic and is documented as one. It reduces exposure; it is not
a guarantee, and Cliptide does not claim it catches every secret. Scanning is
bounded to the first 64 KiB of a payload so a large paste cannot stall the
monitor.

## Data at rest

History lives under the OS per-user application data directory
(`~/Library/Application Support/Cliptide` on macOS, `%APPDATA%\Cliptide` on
Windows, `$XDG_DATA_HOME/cliptide` on Linux). The directory and every file in it
are created with mode `0700`/`0600` — owner-only. On Windows, ACLs inherited from
the per-user `%APPDATA%` root provide the equivalent restriction.

Contents are **not encrypted at rest** in this milestone, and the README says so
plainly rather than implying protection that does not exist. An attacker with
your logged-in user account can read the history file, exactly as they could read
your documents. Encrypting with an OS keychain-held key is planned; claiming it
before it ships would be the kind of security theater this project is meant to
avoid.

## Deletion is real

`delete` appends a tombstone and, on the next compaction, the record is dropped
from the log and its spilled blob is unlinked once no live item references it.
"Clear history" is the same path applied to every unpinned item. Nothing is
soft-hidden while remaining on disk.

The inverse is also guaranteed: **no automatic path deletes a pinned item.**
Retention, size caps, and compaction all skip pins.

## What an attacker gets from the process

The monitor holds at most one clipboard payload in memory at a time and drops the
reference after writing. Previews are bounded strings. There is no swap-safe
memory handling — a determined local attacker with debugger access to your own
session can read the process, and no user-space clipboard manager can prevent
that.

## Reporting

This is a personal project without a published security contact. Issues should be
filed on the repository.
