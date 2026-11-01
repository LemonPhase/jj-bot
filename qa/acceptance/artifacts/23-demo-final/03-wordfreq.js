#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

/**
 * Count Unicode letter/number tokens in text and return the N most common.
 * Tokens are case-insensitive; punctuation (including apostrophes) separates
 * tokens. `n` must be a positive integer.
 *
 * @param {string} text
 * @param {number} n
 * @returns {Array<{word: string, count: number}>}
 */
function topWords(text, n) {
  if (typeof text !== 'string') {
    throw new TypeError('text must be a string');
  }
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new RangeError('n must be a positive integer');
  }

  const counts = new Map();
  // Apostrophes are intentionally not part of tokens: they're separators just
  // like other punctuation (e.g. "don't" contributes "don" and "t").
  const tokens = text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  for (const word of tokens) {
    counts.set(word, (counts.get(word) || 0) + 1);
  }

  return [...counts.entries()]
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0))
    .slice(0, n);
}

function usage() {
  return 'Usage: node wordfreq.js <file> [N]';
}

function main(argv) {
  if (argv.length < 1 || argv.length > 2) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }

  const file = argv[0];
  let n = 10;
  if (argv.length === 2) {
    // Reject partial parses, decimals, signs, empty strings, and zero.
    if (!/^[1-9]\d*$/.test(argv[1])) {
      process.stderr.write(`Invalid N: ${argv[1]} (expected a positive integer)\n${usage()}\n`);
      return 2;
    }
    n = Number(argv[1]);
    if (!Number.isSafeInteger(n)) {
      process.stderr.write(`Invalid N: ${argv[1]} (expected a safe positive integer)\n${usage()}\n`);
      return 2;
    }
  }

  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    process.stderr.write(`Cannot read file "${file}": ${error.message}\n`);
    return 1;
  }

  for (const { word, count } of topWords(text, n)) {
    process.stdout.write(`${word}\t${count}\n`);
  }
  return 0;
}

module.exports = { topWords };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
