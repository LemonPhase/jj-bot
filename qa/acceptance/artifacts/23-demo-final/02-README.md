# wordfreq

`wordfreq` is a small Node.js command-line tool that reports the most frequent words in a text file. It uses only the Node.js standard library; no package installation is required.

## Usage

```sh
node wordfreq.js <file> [n]
```

`<file>` is the path to a UTF-8 text file. `n` is the maximum number of words to print; when omitted it defaults to 10. It must be a positive integer, and extra command-line arguments are invalid. For example:

```sh
node wordfreq.js article.txt 5
```

The module also exports `topWords(text, n)` from `wordfreq.js` for use from other Node.js code. It returns the top entries as word/count pairs, ordered as described below.

## Output

The CLI prints one result per line, with the word and its frequency separated by a tab, for example:

```text
apple 3
banana 2
```

If the input contains fewer than `n` distinct words, all distinct words are printed. An empty input produces no result lines. Errors such as an unreadable file are reported to standard error and produce a non-zero exit status.

## Tokenization and ordering

Text is lowercased before tokenization. Tokens are runs of Unicode letters and numbers; other characters are separators. In particular, apostrophes split contractions into separate words (for example, `don't` becomes `don` and `t`). Results are sorted by descending frequency; words with equal frequency are sorted alphabetically, so output is deterministic.

## Tests

Run the test suite with Node.js, without installing dependencies:

```sh
node --test
```
