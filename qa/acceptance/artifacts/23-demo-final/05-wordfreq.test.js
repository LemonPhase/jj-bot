'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cli = path.join(__dirname, 'wordfreq.js');

function withTextFile(text, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordfreq-test-'));
  const file = path.join(dir, 'input.txt');
  fs.writeFileSync(file, text, 'utf8');
  try {
    return run(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function invoke(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}

test('counts lowercase Unicode letter/number tokens, sorts by count then alphabetically, and limits to N', () => {
  // The tied pairs verify lexical ordering; punctuation, apostrophes, and case
  // verify normalization and that apostrophes separate tokens.
  const text = "echo echo ECHO! beta BETA alpha Alpha 42 42; can't can't 中文 中文。x9 X9";
  withTextFile(text, file => {
    const result = invoke([file, '8']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, [
      'echo\t3',
      '42\t2',
      'alpha\t2',
      'beta\t2',
      "can\t2",
      't\t2',
      'x9\t2',
      '中文\t2',
      ''
    ].join('\n'));
  });
});

test('uses a default limit of 10', () => {
  const text = Array.from({ length: 12 }, (_, i) => `word${String(i).padStart(2, '0')}`).join(' ');
  withTextFile(text, file => {
    const result = invoke([file]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, Array.from({ length: 10 }, (_, i) => `word${String(i).padStart(2, '0')}\t1`).join('\n') + '\n');
  });
});

test('accepts a positive safe decimal integer and returns all words when N exceeds the count', () => {
  withTextFile('pear apple pear', file => {
    const result = invoke([file, '3']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'pear\t2\napple\t1\n');
  });
});

test('rejects invalid N values', () => {
  withTextFile('hello world', file => {
    for (const n of ['0', '-1', '1.5', 'abc', '1e2', '9007199254740992', '']) {
      const result = invoke([file, n]);
      assert.notEqual(result.status, 0, `expected N=${JSON.stringify(n)} to fail`);
      assert.equal(result.stdout, '', `expected no output for N=${JSON.stringify(n)}`);
    }
  });
});

test('reports a missing file as an error', () => {
  const missing = path.join(os.tmpdir(), `wordfreq-no-such-file-${process.pid}-${Date.now()}`);
  const result = invoke([missing]);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
});
