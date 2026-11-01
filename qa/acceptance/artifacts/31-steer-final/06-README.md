# wordfreq

A small Node.js command-line tool that prints the most frequent words in a text file. It uses only the Node.js standard library.

## Usage

```sh
node wordfreq.js <file> <N> [--min-length <length>]
```

`N` is the maximum number of results to print. `--min-length` filters out words shorter than the supplied character count and defaults to `1`.

Words are counted case-insensitively. Tokens are sequences of letters or numbers; an internal apostrophe is included as part of a word when it is surrounded by letters/numbers. Results are ordered by descending frequency, with alphabetical order for ties. Output is one `word count` pair per line.

Examples:

```sh
node wordfreq.js notes.txt 10
node wordfreq.js notes.txt 10 --min-length 4
```

## Tests

Run the test suite with:

```sh
npm test
```
