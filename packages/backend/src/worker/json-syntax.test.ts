import { describe, expect, it } from "vitest";
import { jsonErrorOffset } from "./json-syntax";

/** Where `JSON.parse` says `text` fails, from its message, or "valid". */
function parseError(text: string): number | string | "valid" {
  try {
    JSON.parse(text);
    return "valid";
  } catch (error) {
    const message = (error as Error).message;
    const position = /at position (\d+)/.exec(message);
    if (position) return Number(position[1]);
    if (message.startsWith("Unexpected end of JSON input")) return text.length;
    // V8 names a few whole texts ("undefined", "NaN") instead.
    if (message === `"${text}" is not valid JSON`) return 0;
    // "Unexpected token 'x', …": the character, not where it is.
    const token = /^Unexpected token '(.)'/su.exec(message);
    if (token) return token[1] as string;
    throw new Error(`Unrecognized message: ${message}`);
  }
}

/** `jsonErrorOffset` agrees with `JSON.parse` on `text`. */
function agrees(text: string) {
  const expected = parseError(text);
  const offset = jsonErrorOffset(text);
  if (expected === "valid") expect(offset, text).toBeUndefined();
  else if (typeof expected === "number") expect(offset, text).toBe(expected);
  else expect(text[offset ?? -1], text).toBe(expected);
}

describe("jsonErrorOffset", () => {
  it("finds where JSON.parse fails, and nothing in JSON", () => {
    for (const text of [
      "",
      " ",
      "{}",
      "[]",
      ' { "a" : [ 1 , -2.5e+3 , true , false , null , "x\\u00e9\\n" ] } ',
      "0",
      "-0.0E-0",
      '" \uD800"',
      "{",
      "[",
      "[1,]",
      '{"a":1,}',
      '{"a":}',
      '{"a"',
      '{"a":',
      '{"a" 1}',
      '{"a":1 "b":2}',
      "[1 2]",
      '["a" ,',
      "01",
      "-",
      "-a",
      "1.",
      "1.x",
      "1e",
      "1e+",
      ".5",
      "+1",
      "1 2",
      "tru",
      "truex",
      "nul",
      "nulx",
      "undefined",
      "NaN",
      '"abc',
      '"a\nb"',
      '"\\x"',
      '"\\',
      '"\\u',
      '"\\u12"',
      '"\\u12G4"',
      "'single'",
      "﻿{}",
      '{"key": sk-proj-0123456789ABCDEF}',
      '{"key": "x",\n "k2": sk-proj-0123456789ABCDEF}',
      "[[[[[[[[[[",
      "]",
      "}",
      '{"a":[1,{"b":null}]}x',
    ])
      agrees(text);
  });

  it("agrees with JSON.parse on random near-JSON", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pieces = [
      "{",
      "}",
      "[",
      "]",
      ",",
      ":",
      '"a"',
      '"',
      "\\",
      "u",
      "0",
      "1",
      "-",
      ".",
      "e",
      "+",
      " ",
      "\n",
      "true",
      "nul",
      "x",
      "\t",
      "\u0001",
    ];
    for (let round = 0; round < 20_000; round += 1) {
      const count = 1 + Math.floor(random() * 10);
      let text = "";
      for (let index = 0; index < count; index += 1)
        text += pieces[Math.floor(random() * pieces.length)];
      agrees(text);
    }
  });

  it("takes no stack for deep nesting", () => {
    const deep = "[".repeat(1_000_000);
    expect(jsonErrorOffset(deep)).toBe(deep.length);
    expect(jsonErrorOffset(`${deep}${"]".repeat(1_000_000)}`)).toBeUndefined();
  });
});
