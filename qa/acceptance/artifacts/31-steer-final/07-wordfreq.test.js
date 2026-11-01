'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'wordfreq.js');
const FIXTURE = path.join(__dirname, 'sample.txt');

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 5000,
  });
}

function withTextFile(contents, callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordfreq-test-'));
  const file = path.join(dir, 'input.txt');
  fs.writeFileSync(file, contents, 'utf8');
  try {
    callback(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('counts fixture words case-insensitively and orders by frequency then alphabetically', () => {
  const result = run([FIXTURE, '10']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, 'apple 3\nbanana 2\npear 1\n');
});

test('tokenizes Unicode letter/number sequences and retains internal apostrophes', () => {
  withTextFile("Hello, HELLO! can't; café 42_world. don’t DON'T\n", (file) => {
    const result = run([file, '20']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "hello 2\n42 1\ncafé 1\ncan't 1\ndon't 1\ndon’t 1\nworld 1\n");
  });
});

test('prints no more than N results', () => {
  const result = run([FIXTURE, '2']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'apple 3\nbanana 2\n');
});

test('--min-length defaults to 1 and filters shorter words when explicit', () => {
  withTextFile('a an ant bee be\n', (file) => {
    const defaults = run([file, '10']);
    assert.equal(defaults.status, 0, defaults.stderr);
    assert.equal(defaults.stdout, 'a 1\nan 1\nant 1\nbe 1\nbee 1\n');

    const filtered = run([file, '10', '--min-length', '3']);
    assert.equal(filtered.status, 0, filtered.stderr);
    assert.equal(filtered.stdout, 'ant 1\nbee 1\n');
  });
});

test('accepts --min-length before positional arguments', () => {
  withTextFile('x yak ox yak\n', (file) => {
    const result = run(['--min-length', '3', file, '10']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'yak 2\n');
  });
});

test('reports missing input files as a nonzero CLI error', () => {
  const missing = path.join(os.tmpdir(), `wordfreq-missing-${process.pid}.txt`);
  const result = run([missing, '3']);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Error:/);
});

test('rejects invalid N and invalid --min-length values', () => {
  const invalidN = run([FIXTURE, 'not-a-number']);
  assert.notEqual(invalidN.status, 0);
  assert.equal(invalidN.stdout, '');
  assert.match(invalidN.stderr, /n must be a non-negative integer/);

  const invalidLength = run([FIXTURE, '3', '--min-length', '0']);
  assert.notEqual(invalidLength.status, 0);
  assert.equal(invalidLength.stdout, '');
  assert.match(invalidLength.stderr, /--min-length must be a positive integer/);
});
