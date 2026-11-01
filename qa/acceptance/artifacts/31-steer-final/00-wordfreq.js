#!/usr/bin/env node
'use strict';

/**
 * Return the most frequent words in text as [{ word, count }, ...].
 * Tokens consist of Unicode letters or numbers, optionally joined by
 * straight/curly apostrophes when another letter/number follows. Words are
 * case-insensitive (normalized to lowercase); words are ordered by frequency
 * descending, then alphabetically using code-point order.
 *
 * @param {string} text
 * @param {number} n Maximum number of words to return (non-negative integer).
 * @param {object} [options]
 * @param {number} [options.minLength=1] Minimum token length in Unicode code
 *   points; must be a positive integer.
 * @returns {{word: string, count: number}[]}
 */
function topWords(text, n, options = {}) {
  if (typeof text !== 'string') {
    throw new TypeError('text must be a string');
  }
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new RangeError('n must be a non-negative integer');
  }
  const minLength = options.minLength === undefined ? 1 : options.minLength;
  if (!Number.isSafeInteger(minLength) || minLength < 1) {
    throw new RangeError('minLength must be a positive integer');
  }

  const counts = new Map();
  // A token starts and ends in a Unicode letter/number. Internal apostrophes
  // are retained only when followed by another letter/number (e.g. don't).
  const tokens = text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) || [];
  for (const token of tokens) {
    const word = token.toLowerCase();
    if ([...word].length < minLength) continue;
    counts.set(word, (counts.get(word) || 0) + 1);
  }

  return [...counts]
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0))
    .slice(0, n);
}

function usage() {
  return 'Usage: node wordfreq.js <file> [n] [--min-length <positive-integer>]';
}

function parseArgs(args) {
  let file;
  let n = 10;
  let nProvided = false;
  let minLength = 1;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--min-length') {
      if (i + 1 >= args.length || args[i + 1].startsWith('--')) {
        throw new Error('--min-length requires a positive integer');
      }
      const value = args[++i];
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
        throw new Error('--min-length must be a positive integer');
      }
      minLength = Number(value);
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option: ${arg}`);
    } else if (file === undefined) {
      file = arg;
    } else if (!nProvided) {
      if (!/^\d+$/.test(arg) || !Number.isSafeInteger(Number(arg))) {
        throw new Error('n must be a non-negative integer');
      }
      n = Number(arg);
      nProvided = true;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  if (file === undefined) throw new Error('a text file is required');
  return { file, n, minLength };
}

if (require.main === module) {
  const fs = require('node:fs');
  try {
    const { file, n, minLength } = parseArgs(process.argv.slice(2));
    const text = fs.readFileSync(file, 'utf8');
    for (const { word, count } of topWords(text, n, { minLength })) {
      process.stdout.write(`${word} ${count}\n`);
    }
  } catch (error) {
    process.stderr.write(`${usage()}\nError: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { topWords };
