/**
 * Structural privacy tests.
 *
 * SECURITY.md claims that clipboard content cannot leave the machine because
 * no module has a network client, and that `core/` depends on nothing outside
 * the standard library. Those are architectural claims, and an architectural
 * claim that nothing checks is a comment that will quietly stop being true.
 *
 * These tests read the source itself. If someone adds an HTTP client to the
 * engine, this suite fails and they have to make that a deliberate, visible
 * decision — which is exactly the point.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');
const packageFile = path.join(here, '..', 'package.json');

async function sourceFiles(dir = srcDir) {
  const found = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(full)));
    else if (entry.name.endsWith('.js')) found.push(full);
  }
  return found;
}

async function readAll() {
  const files = await sourceFiles();
  return Promise.all(
    files.map(async (file) => ({
      file: path.relative(srcDir, file),
      source: await fs.readFile(file, 'utf8'),
    })),
  );
}

/** Strip comments so documentation *about* network access is not a false hit. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const NETWORK_MODULES = [
  'node:http',
  'node:https',
  'node:http2',
  'node:net',
  'node:tls',
  'node:dgram',
  'http',
  'https',
  'net',
  'tls',
  'dgram',
];

test('the engine has at least one source file to check', async () => {
  const files = await sourceFiles();
  assert.ok(files.length > 10, `found ${files.length} source files`);
});

test('no module imports a network transport', async () => {
  const offenders = [];

  for (const { file, source } of await readAll()) {
    const code = stripComments(source);
    for (const moduleName of NETWORK_MODULES) {
      const importPattern = new RegExp(
        `(?:from|import|require)\\s*\\(?\\s*['"\`]${moduleName}['"\`]`,
      );
      if (importPattern.test(code)) offenders.push(`${file} imports ${moduleName}`);
    }
  }

  assert.deepEqual(offenders, [], 'clipboard content must have no way off the machine');
});

test('no module calls a network API', async () => {
  const offenders = [];
  const patterns = [
    { name: 'fetch()', pattern: /(?<![\w.])fetch\s*\(/ },
    { name: 'XMLHttpRequest', pattern: /\bXMLHttpRequest\b/ },
    { name: 'WebSocket', pattern: /\bnew\s+WebSocket\b/ },
    { name: 'navigator.sendBeacon', pattern: /\bsendBeacon\s*\(/ },
  ];

  for (const { file, source } of await readAll()) {
    const code = stripComments(source);
    for (const { name, pattern } of patterns) {
      if (pattern.test(code)) offenders.push(`${file} calls ${name}`);
    }
  }

  assert.deepEqual(offenders, [], 'no code path transmits anything');
});

test('the core domain layer depends only on the standard library', async () => {
  const coreDir = path.join(srcDir, 'core');
  const offenders = [];

  for (const file of await sourceFiles(coreDir)) {
    const code = stripComments(await fs.readFile(file, 'utf8'));
    for (const match of code.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      const allowed = specifier.startsWith('node:') || specifier.startsWith('.');
      if (!allowed) offenders.push(`${path.relative(srcDir, file)} imports ${specifier}`);
    }
  }

  assert.deepEqual(offenders, [], 'core must stay pure and portable');
});

test('the dependency direction never points back up', async () => {
  // storage must not import capture/history/agent/ui; core must not import anything above it.
  const forbidden = {
    core: ['storage', 'capture', 'search', 'history', 'agent', 'settings'],
    storage: ['capture', 'history', 'agent'],
    search: ['storage', 'capture', 'history', 'agent'],
  };
  const offenders = [];

  for (const { file, source } of await readAll()) {
    const layer = file.split(path.sep)[0];
    const banned = forbidden[layer];
    if (!banned) continue;

    const code = stripComments(source);
    for (const match of code.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      for (const target of banned) {
        if (specifier.includes(`/${target}/`)) {
          offenders.push(`${file} imports from ${target}`);
        }
      }
    }
  }

  assert.deepEqual(offenders, [], 'layering violations break the replaceability of every layer');
});

test('the agent layer contains no AI provider dependency', async () => {
  const agentDir = path.join(srcDir, 'agent');
  const banned = /@anthropic-ai|openai|langchain|@google\/gener|api\.anthropic\.com|api\.openai\.com/i;
  const offenders = [];

  for (const file of await sourceFiles(agentDir)) {
    const code = stripComments(await fs.readFile(file, 'utf8'));
    if (banned.test(code)) offenders.push(path.relative(srcDir, file));
  }

  assert.deepEqual(offenders, [], 'the agent boundary stays provider-agnostic until the MVP is stable');
});

test('the package declares no runtime dependencies', async () => {
  const manifest = JSON.parse(await fs.readFile(packageFile, 'utf8'));

  assert.equal(manifest.dependencies, undefined, 'a supply-chain surface is a privacy surface');
  assert.equal(manifest.devDependencies, undefined);
  assert.equal(manifest.private, true, 'never publishable by accident');
});

test('no module writes clipboard payloads into a log call', async () => {
  // Structured errors carry sizes, hashes, and reasons — never content. A
  // console call taking an item or a payload would defeat that by hand.
  const offenders = [];
  const pattern = /console\.\w+\([^)]*\b(?:item\.text|snapshot\.text|payload|\.preview)\b/;

  for (const { file, source } of await readAll()) {
    if (pattern.test(stripComments(source))) offenders.push(file);
  }

  assert.deepEqual(offenders, [], 'clipboard content must never reach a log');
});
