import { describe, expect, it } from "vitest";
import {
  appendEntry,
  cardNote,
  HISTORY_START,
  modelHistory,
  stripCardNotes,
} from "./chat-history";

const same = (text: string) => text;

describe("chat history for the model", () => {
  it("alternates sides, joining consecutive turns of one side", () => {
    expect(
      modelHistory(
        [
          { role: "user", text: "Build it", taskId: null },
          { role: "assistant", text: "Started.", taskId: "task_1" },
          { role: "assistant", text: "It is done.", taskId: "task_1" },
          { role: "user", text: "Thanks", taskId: null },
          { role: "user", text: "And now?", taskId: null },
        ],
        new Map([["task_1", "Build"]]),
        same,
      ),
    ).toEqual([
      { role: "user", text: "Build it" },
      {
        role: "assistant",
        text: 'Started.\n\n[Task card: task_1 "Build"]\n\nIt is done.\n\n[Task card: task_1 "Build"]',
      },
      { role: "user", text: "Thanks\n\nAnd now?" },
    ]);
  });

  it("starts with the user when the bot spoke first", () => {
    const history = modelHistory(
      [{ role: "assistant", text: "Your task is done.", taskId: null }],
      new Map(),
      same,
    );
    expect(history).toEqual([
      { role: "user", text: HISTORY_START },
      { role: "assistant", text: "Your task is done." },
    ]);
    // An update input after it joins nothing and keeps the order valid.
    expect(
      appendEntry(history, { role: "user", text: "[Task update] …" }),
    ).toHaveLength(3);
    expect(
      appendEntry([{ role: "user", text: "hello?" }], {
        role: "user",
        text: "[Task update] …",
      }),
    ).toEqual([{ role: "user", text: "hello?\n\n[Task update] …" }]);
  });

  it("shows each card once, as a note the engine adds and a reply never keeps", () => {
    const stored = `All done.\n\n${cardNote("task_1", "Build")}`;
    expect(stripCardNotes(stored)).toBe("All done.");
    expect(stripCardNotes("Line one\n[Task card: task_2]\nLine two")).toBe(
      "Line one\n\nLine two",
    );
    // A note in the middle of a sentence is the bot's own text.
    expect(stripCardNotes("See [Task card: x] above.")).toBe(
      "See [Task card: x] above.",
    );
    // An old reply stored with a note gets one note, not two.
    const [, reply] = modelHistory(
      [
        { role: "user", text: "Build it", taskId: null },
        { role: "assistant", text: stored, taskId: "task_1" },
      ],
      new Map([["task_1", "Build"]]),
      same,
    );
    expect(reply?.text.match(/\[Task card:/g)).toHaveLength(1);
  });
});
