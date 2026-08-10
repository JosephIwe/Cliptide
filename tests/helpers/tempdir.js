/**
 * Test helper: an isolated data directory per test.
 *
 * Every storage test runs against its own directory so the suite never touches
 * a developer's real clipboard history, and so tests stay order-independent.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Create a temp directory and register its cleanup with the test context.
 * @param {import('node:test').TestContext} t
 */
export async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cliptide-test-'));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

/** A text clipboard snapshot. */
export function textSnapshot(text, extra = {}) {
  return { kind: 'text', text, ...extra };
}
