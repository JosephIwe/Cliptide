/**
 * Structured error types for Cliptide.
 *
 * Every error carries a machine-readable `kind` so callers branch without
 * string-matching a message. Errors never embed clipboard payloads: a
 * clipboard manager that leaks content into logs or crash traces defeats its
 * own purpose. Details carry sizes, counts, hashes, and reasons — never text.
 */

/** Base class for every Cliptide error. */
export class CliptideError extends Error {
  constructor(kind, message, details = {}) {
    super(message);
    this.name = 'CliptideError';
    this.kind = kind;
    this.details = details;
  }
}

/** A value failed model validation (bad shape, bad enum, out of range). */
export class ValidationError extends CliptideError {
  constructor(message, details = {}) {
    super('validation', message, details);
    this.name = 'ValidationError';
  }
}

/** The storage layer failed (I/O, permissions, unwritable data directory). */
export class StorageError extends CliptideError {
  constructor(message, details = {}) {
    super('storage', message, details);
    this.name = 'StorageError';
  }
}

/** A persisted record could not be parsed. Recoverable: the reader skips it. */
export class CorruptRecordError extends CliptideError {
  constructor(message, details = {}) {
    super('corrupt_record', message, details);
    this.name = 'CorruptRecordError';
  }
}

/** Reading from or writing to the platform clipboard failed. */
export class CaptureError extends CliptideError {
  constructor(message, details = {}) {
    super('capture', message, details);
    this.name = 'CaptureError';
  }
}

/** The current platform has no supported clipboard implementation. */
export class UnsupportedPlatformError extends CliptideError {
  constructor(message, details = {}) {
    super('unsupported_platform', message, details);
    this.name = 'UnsupportedPlatformError';
  }
}
