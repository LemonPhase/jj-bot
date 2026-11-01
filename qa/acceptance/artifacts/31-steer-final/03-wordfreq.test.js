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

function run(args, options = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    ...options,
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

test('counts words, normalizes case, and orders by descending frequency', () => {
  const result = run([FIXTURE, '10']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^apple\s+3\b/m);
  assert.match(result.stdout, /^banana\s+2\b/m);
  assert.match(result.stdout, /^pear\s+1\b/m);
  const counts = [...result.stdout.matchAll(/\s(\d+)\s*$/gm)].map((m) => Number(m[1]));
  assert.deepEqual(counts, [...counts].sort((a, b) => b - a));
});

test('breaks frequency ties alphabetically', () => {
  withTextFile('zebra apple banana apple banana zebra\n', (file) => {
    const result = run([file, '3']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split(/\r?\n/), [
      'apple 2',
      'banana 2',
      'zebra 2',
    ]);
  });
});

test('tokenizes punctuation-delimited words and lowercases them', () => {
  withTextFile("Hello, HELLO! can't; café 42_world.\n", (file) => {
    const result = run([file, '20']);
    assert.equal(result.status, 0, result.stderr);
    const rows = result.stdout.trim().split(/\r?\n/);
    assert.deepEqual(rows, ['hello 2', '42 1', 'café 1', "can't 1", 'world 1']);
  });
});

test('limits output to the requested number of words', () => {
  const result = run([FIXTURE, '2']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim().split(/\r?\n/).length, 2);
});

test('--min-length defaults to 1 and excludes shorter words when configured', () => {
  withTextFile('a an ant bee be\n', (file) => {
    const defaults = run([file, '10']);
    assert.equal(defaults.status, 0, defaults.stderr);
    assert.deepEqual(defaults.stdout.trim().split(/\r?\n/), [
      'a 1', 'an 1', 'ant 1', 'be 1', 'bee 1',
    ]);

    const filtered = run([file, '10', '--min-length', '3']);
    assert.equal(filtered.status, 0, filtered.stderr);
    assert.deepEqual(filtered.stdout.trim().split(/\r?\n/), ['ant 1', 'bee 1']);
  });
});

test('accepts --min-length before positional arguments', () => {
  withTextFile('x yak ox yak\n', (file) => {
    const result = run(['--min-length', '3', file, '10']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'yak 2');
  });
});

test('reports missing input files as a nonzero CLI error', () => {
  const result = run([path.join(os.tmpdir(), 'wordfreq-file-that-does-not-exist'), '3']);
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.length > 0, 'expected an error message on stderr');
});

test('rejects invalid count arguments', () => {
  const result = run([FIXTURE, 'not-a-number']);
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.length > 0, 'expected an error message on stderr');
});
