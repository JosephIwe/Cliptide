/**
 * Bounded child-process execution for CLI-backed clipboard sources.
 *
 * Two properties matter for a process that runs all day:
 *
 *  - **Output is capped.** A 200 MB image on the clipboard must not become a
 *    200 MB buffer in the agent. Reading stops at the cap, the child is killed,
 *    and the caller is told the output was truncated.
 *  - **Every call has a timeout.** A hung `xclip` waiting on a dead X server
 *    would otherwise stall the poll loop forever.
 *
 * Arguments are passed as an array and never through a shell, so clipboard
 * content and file paths cannot be interpreted as shell syntax.
 */

import { spawn } from 'node:child_process';
import { CaptureError } from '../core/errors.js';

export const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Run a command and capture stdout, stopping at `maxBytes`.
 *
 * @returns {Promise<{stdout: Buffer, stderr: string, code: number|null, truncated: boolean}>}
 */
export function runCapture(command, args = [], options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = 8 * 1024 * 1024, env } = options;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    } catch (err) {
      reject(new CaptureError(`could not run ${command}`, { reason: err.code ?? err.message }));
      return;
    }

    /** @type {Buffer[]} */
    const chunks = [];
    let total = 0;
    let truncated = false;
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new CaptureError(`${command} timed out`, { command, timeoutMs }));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    child.stdout.on('data', (chunk) => {
      if (truncated) return;
      const remaining = maxBytes - total;
      if (chunk.length >= remaining) {
        chunks.push(chunk.subarray(0, Math.max(0, remaining)));
        total = maxBytes;
        truncated = true;
        // Stop the producer rather than buffering the rest and discarding it.
        child.kill('SIGKILL');
        return;
      }
      chunks.push(chunk);
      total += chunk.length;
    });

    // stderr is bounded separately; it only ever carries short diagnostics.
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 4096) stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new CaptureError(`could not run ${command}`, { reason: err.code ?? err.message }));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(chunks), stderr: stderr.trim(), code, truncated });
    });
  });
}

/** Run a command, writing `input` to its stdin. This is the paste path. */
export function runWithInput(command, args = [], input = '', options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, env } = options;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['pipe', 'ignore', 'pipe'], env });
    } catch (err) {
      reject(new CaptureError(`could not run ${command}`, { reason: err.code ?? err.message }));
      return;
    }

    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new CaptureError(`${command} timed out`, { command, timeoutMs }));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    child.stderr.on('data', (chunk) => {
      if (stderr.length < 4096) stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new CaptureError(`could not run ${command}`, { reason: err.code ?? err.message }));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new CaptureError(`${command} exited ${code}`, { command, code, stderr: stderr.trim() }));
        return;
      }
      resolve({ code });
    });

    child.stdin.on('error', () => {
      // The child can exit before consuming stdin; `close` reports the truth.
    });
    child.stdin.end(Buffer.isBuffer(input) ? input : String(input));
  });
}
