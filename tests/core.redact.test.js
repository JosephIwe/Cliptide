import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, maskText, redact, SECRET_LABELS, SCAN_LIMIT_BYTES } from '../src/core/redact.js';

function labelsFor(text) {
  return classify(text).labels;
}

test('recognizes common credential shapes', () => {
  assert.deepEqual(labelsFor('AKIAIOSFODNN7EXAMPLE'), [SECRET_LABELS.AWS_ACCESS_KEY]);
  assert.deepEqual(labelsFor(`ghp_${'a'.repeat(36)}`), [SECRET_LABELS.GITHUB_TOKEN]);
  assert.deepEqual(labelsFor('xoxb-1234567890-abcdefghij'), [SECRET_LABELS.SLACK_TOKEN]);
  assert.deepEqual(labelsFor(`AIza${'B'.repeat(35)}`), [SECRET_LABELS.GOOGLE_API_KEY]);
  assert.ok(labelsFor(`sk_live_${'9'.repeat(24)}`).includes(SECRET_LABELS.STRIPE_KEY));
  assert.ok(labelsFor(`sk-ant-api03-${'x'.repeat(40)}`).includes(SECRET_LABELS.AI_PROVIDER_KEY));
});

test('recognizes a private key block spanning many lines', () => {
  const key = [
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB',
    '-----END OPENSSH PRIVATE KEY-----',
  ].join('\n');

  assert.deepEqual(labelsFor(key), [SECRET_LABELS.PRIVATE_KEY]);
});

test('recognizes a JWT', () => {
  const jwt =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  assert.deepEqual(labelsFor(jwt), [SECRET_LABELS.JWT]);
});

test('masks the value of a credential assignment but keeps the label readable', () => {
  const text = 'password=hunter2secretvalue';
  const { sensitive, masked, labels } = redact(text);

  assert.equal(sensitive, true);
  assert.deepEqual(labels, [SECRET_LABELS.CREDENTIAL_ASSIGNMENT]);
  assert.ok(masked.startsWith('password='), 'the field name stays visible');
  assert.ok(!masked.includes('hunter2secretvalue'), 'the value does not survive masking');
  assert.ok(masked.includes('•'));
});

test('card numbers are only flagged when the Luhn checksum passes', () => {
  assert.deepEqual(labelsFor('4111 1111 1111 1111'), [SECRET_LABELS.PAYMENT_CARD]);
  // Same length and shape, invalid checksum: an order number, not a card.
  assert.deepEqual(labelsFor('4111 1111 1111 1112'), []);
  assert.deepEqual(labelsFor('1234567890123456789012'), [], 'long digit runs are not cards');
});

test('ordinary content is not flagged', () => {
  const benign = [
    'https://example.com/docs/getting-started',
    'The quick brown fox jumps over the lazy dog.',
    'git commit -m "fix flaky test"',
    'SELECT id, name FROM users WHERE active = true;',
  ];
  for (const text of benign) {
    assert.deepEqual(labelsFor(text), [], `should not flag: ${text}`);
  }
});

test('masking preserves surrounding text and leaves a short hint on long spans', () => {
  const token = `ghp_${'a'.repeat(36)}`;
  const text = `deploy with ${token} now`;
  const { masked } = redact(text);

  assert.ok(masked.startsWith('deploy with '));
  assert.ok(masked.endsWith(' now'));
  assert.ok(!masked.includes(token));
  assert.ok(masked.includes('ghp_'), 'a 4-character hint distinguishes multiple keys');
});

test('overlapping matches mask exactly once', () => {
  // The assignment pattern and the token pattern both cover the value here.
  const text = `api_key=sk-ant-api03-${'z'.repeat(40)}`;
  const { masked, matches } = redact(text);

  assert.ok(matches.length >= 2, 'more than one pattern matched');
  assert.equal(masked.includes('••••••••••••••••'), false, 'spans were merged, not stacked');
  assert.ok(!masked.includes('z'.repeat(40)));
});

test('multiple distinct secrets are all reported', () => {
  const text = `AKIAIOSFODNN7EXAMPLE and ghp_${'b'.repeat(36)}`;
  assert.deepEqual(labelsFor(text), [SECRET_LABELS.AWS_ACCESS_KEY, SECRET_LABELS.GITHUB_TOKEN]);
});

test('scanning is bounded so a huge payload cannot stall the monitor', () => {
  const filler = 'x'.repeat(SCAN_LIMIT_BYTES + 5000);
  const hidden = `${filler}AKIAIOSFODNN7EXAMPLE`;

  const started = process.hrtime.bigint();
  const result = classify(hidden);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(result.scannedBytes, SCAN_LIMIT_BYTES);
  assert.equal(result.sensitive, false, 'documented tradeoff: past the scan limit is not scanned');
  assert.ok(elapsedMs < 500, `classification stayed bounded (${elapsedMs.toFixed(1)}ms)`);
});

test('classify handles empty and non-string input safely', () => {
  assert.deepEqual(classify('').labels, []);
  assert.deepEqual(classify(null).labels, []);
  assert.equal(classify(undefined).sensitive, false);
});

test('maskText with no matches returns the input unchanged', () => {
  assert.equal(maskText('nothing to hide', []), 'nothing to hide');
});
