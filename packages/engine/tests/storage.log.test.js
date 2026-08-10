import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AppendLog } from '../src/storage/log.js';
import { tempDir } from './helpers/tempdir.js';

async function openLog(t) {
  const dir = await tempDir(t);
  const log = new AppendLog(path.join(dir, 'history.jsonl'));
  await log.open();
  t.after(() => log.close());
  return { dir, log };
}

test('appends round-trip through a reopen', async (t) => {
  const { log } = await openLog(t);

  await log.append({ op: 'put', n: 1 });
  await log.append({ op: 'put', n: 2 });

  const reopened = new AppendLog(log.filePath);
  await reopened.open();
  t.after(() => reopened.close());

  const { records, corruptLines } = await reopened.readAll();
  assert.deepEqual(records, [
    { op: 'put', n: 1 },
    { op: 'put', n: 2 },
  ]);
  assert.deepEqual(corruptLines, []);
});

test('reading a log that does not exist yet yields nothing, not an error', async (t) => {
  const dir = await tempDir(t);
  const log = new AppendLog(path.join(dir, 'missing.jsonl'));

  const { records } = await log.readAll();
  assert.deepEqual(records, []);
});

test('a torn trailing record is truncated on open so later appends stay clean', async (t) => {
  const { log } = await openLog(t);
  await log.append({ op: 'put', n: 1 });
  await log.close();

  // Simulate power loss mid-append: a record with no terminating newline.
  await fs.appendFile(log.filePath, '{"op":"put","n":2,"item":{"tex');

  const recovered = new AppendLog(log.filePath);
  await recovered.open();
  t.after(() => recovered.close());

  assert.ok(recovered.repairedBytes > 0, 'the partial record was measured and discarded');

  // The critical property: the next append must not weld onto the torn line.
  await recovered.append({ op: 'put', n: 3 });

  const { records, corruptLines } = await recovered.readAll();
  assert.deepEqual(corruptLines, [], 'no line is corrupt after repair');
  assert.deepEqual(records, [
    { op: 'put', n: 1 },
    { op: 'put', n: 3 },
  ]);
});

test('a file consisting only of a torn record is emptied', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'history.jsonl');
  await fs.writeFile(file, '{"op":"put","incomplete":tr');

  const log = new AppendLog(file);
  await log.open();
  t.after(() => log.close());

  const { records } = await log.readAll();
  assert.deepEqual(records, []);
  assert.equal(await log.size(), 0);
});

test('one corrupt line in the middle does not cost the surrounding records', async (t) => {
  const { log } = await openLog(t);
  await log.append({ op: 'put', n: 1 });
  await log.close();

  await fs.appendFile(log.filePath, 'this is not json\n');

  const reopened = new AppendLog(log.filePath);
  await reopened.open();
  t.after(() => reopened.close());
  await reopened.append({ op: 'put', n: 3 });

  const { records, corruptLines } = await reopened.readAll();
  assert.deepEqual(corruptLines, [2], 'the damaged line is reported by number');
  assert.deepEqual(records, [
    { op: 'put', n: 1 },
    { op: 'put', n: 3 },
  ]);
});

test('blank lines are skipped without being called corrupt', async (t) => {
  const { log } = await openLog(t);
  await log.append({ op: 'put', n: 1 });
  await log.close();
  await fs.appendFile(log.filePath, '\n\n');

  const reopened = new AppendLog(log.filePath);
  await reopened.open();
  t.after(() => reopened.close());

  const { records, corruptLines } = await reopened.readAll();
  assert.equal(records.length, 1);
  assert.deepEqual(corruptLines, []);
});

test('replaceAll swaps the log atomically and keeps it appendable', async (t) => {
  const { log } = await openLog(t);
  for (let n = 0; n < 10; n++) await log.append({ op: 'put', n });

  await log.replaceAll([{ op: 'put', n: 'compacted' }]);
  await log.append({ op: 'put', n: 'after' });

  const { records } = await log.readAll();
  assert.deepEqual(records, [
    { op: 'put', n: 'compacted' },
    { op: 'put', n: 'after' },
  ]);
  await assert.doesNotReject(() => fs.access(log.filePath));
});

test('a leftover temp file from an interrupted compaction is discarded on open', async (t) => {
  const { log } = await openLog(t);
  await log.append({ op: 'put', n: 'original' });
  await log.close();

  // A crash during replaceAll leaves a partial temp file behind.
  await fs.writeFile(`${log.filePath}.tmp`, '{"op":"put","n":"hal');

  const reopened = new AppendLog(log.filePath);
  await reopened.open();
  t.after(() => reopened.close());

  const { records } = await reopened.readAll();
  assert.deepEqual(records, [{ op: 'put', n: 'original' }], 'the original log won');
  await assert.rejects(() => fs.access(`${log.filePath}.tmp`), 'the temp file is gone');
});

test('appending before open fails loudly instead of losing the record', async (t) => {
  const dir = await tempDir(t);
  const log = new AppendLog(path.join(dir, 'history.jsonl'));

  await assert.rejects(() => log.append({ op: 'put' }), { kind: 'storage' });
});

test('the log file and its directory are created owner-only', async (t) => {
  const { dir, log } = await openLog(t);
  await log.append({ op: 'put', n: 1 });

  if (process.platform === 'win32') {
    t.skip('POSIX modes do not apply on Windows; ACLs are inherited from %APPDATA%');
    return;
  }

  const fileStat = await fs.stat(log.filePath);
  const dirStat = await fs.stat(dir);
  assert.equal(fileStat.mode & 0o777, 0o600);
  assert.equal(dirStat.mode & 0o077, 0, 'no group or other access');
});

test('unicode payloads survive the round trip byte-for-byte', async (t) => {
  const { log } = await openLog(t);
  const tricky = { text: 'emoji 🎉 · CJK 漢字 · rtl عربى · "quotes" \\ backslash \n newline' };

  await log.append({ op: 'put', item: tricky });
  const { records } = await log.readAll();

  assert.deepEqual(records[0].item, tricky);
});
