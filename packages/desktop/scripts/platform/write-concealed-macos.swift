// Cross-process concealed-marker writer for macOS (M1 CI verification).
//
// Writes a synthetic concealed marker to the REAL system pasteboard using the
// genuine AppKit API, from a process that is NOT Electron. This is what makes
// the CI test meaningful: Cliptide's Linux result only ever proved that one
// Electron process could read back a type it had written itself.
//
// This is deliberately NOT a simulation. It calls NSPasteboard exactly as any
// native macOS application does.
//
// IMPORTANT SCOPE LIMIT: proving Electron can see a marker written this way
// does NOT prove that 1Password, Bitwarden, Keeper, or Apple Passwords set this
// same marker. That remains a manual test on a real desktop.
//
// Privacy: the payload is a fixed synthetic string, never printed.
//
//   swiftc -O -o writer write-concealed-macos.swift && ./writer

import AppKit
import Foundation

let CONCEALED_TYPE = "org.nspasteboard.ConcealedType"
let SYNTHETIC_VALUE = "cliptide-ci-synthetic-not-a-real-secret"

let pasteboard = NSPasteboard.general
pasteboard.clearContents()

// Text first, then the marker alongside it — the same shape a password manager
// produces: readable content plus a "do not record me" type.
let wroteText = pasteboard.setString(SYNTHETIC_VALUE, forType: .string)
let wroteMarker = pasteboard.setData(
    Data([1]),
    forType: NSPasteboard.PasteboardType(CONCEALED_TYPE)
)

// Report only booleans, names, and identifiers. Never the value.
let types = pasteboard.types?.map { $0.rawValue } ?? []
print("writer_pid=\(ProcessInfo.processInfo.processIdentifier)")
print("wrote_text=\(wroteText)")
print("wrote_marker=\(wroteMarker)")
print("payload_length=\(SYNTHETIC_VALUE.count)")
print("pasteboard_types=\(types.joined(separator: ","))")
print("marker_present_after_write=\(types.contains(CONCEALED_TYPE))")

exit(wroteText && wroteMarker ? 0 : 1)
