'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cli = path.join(__dirname, 'wordfreq.js');
const fixture = path.join(__dirname, 'sample.txt');

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    timeout: 5000,
  });
}

test('CLI prints the top N case-insensitive words in frequency and tie order', () => {
  const result = run([fixture, '3']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, 'apple 3\nbanana 2\npear 2\n');
});

test('--min-length defaults to one and N limits the output', () => {
  const result = run([fixture, '2']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'apple 3\nbanana 2\n');
});

test('--min-length excludes shorter tokens before ranking', () => {
  const result = run([fixture, '10', '--min-length', '5']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'apple 3\nbanana 2\n');
});

test('--min-length accepts the option before positional N', () => {
  const result = run([fixture, '--min-length', '6', '10']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'banana 2\n');
});

test('invalid --min-length exits unsuccessfully with an error', () => {
  const result = run([fixture, '3', '--min-length', '0']);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /--min-length must be a positive integer/);
});

test('missing input file exits unsuccessfully with an error', () => {
  const missing = path.join(os.tmpdir(), `wordfreq-missing-${process.pid}.txt`);
  const result = run([missing, '3']);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /ENOENT/);
});
