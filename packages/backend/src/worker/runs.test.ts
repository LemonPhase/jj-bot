// How a transcript's last turn ended, on the shapes a pi transcript takes.
import { describe, expect, it } from "vitest";
import { parkedText } from "./parking";
import { turnEnd } from "./runs";

const user = (text: string) => ({ role: "user", content: text });
const answer = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  stopReason: "stop",
});
const calling = (...names: string[]) => ({
  role: "assistant",
  content: [
    { type: "text", text: "Checking." },
    ...names.map((name, index) => ({
      type: "toolCall",
      id: `call_${index}`,
      name,
      arguments: {},
    })),
  ],
  stopReason: "toolUse",
});
const result = (name: string, text: string, isError = false, index = 0) => ({
  role: "toolResult",
  toolCallId: `call_${index}`,
  toolName: name,
  content: [{ type: "text", text }],
  isError,
});
const compaction = { role: "compaction", summary: "Earlier work." };

describe("turnEnd", () => {
  it("is open on an empty transcript, and on input the model has not answered", () => {
    expect(turnEnd([])).toBeUndefined();
    expect(turnEnd([user("Do the work.")])).toBeUndefined();
    expect(turnEnd([user("Do it."), answer("Done."), user("More.")])).toBe(
      undefined,
    );
  });

  it("is the model's answer when an assistant message that calls no tools is last", () => {
    expect(turnEnd([user("Do it."), answer("Done.")])).toBe("answer");
    // pi may store content as a plain string.
    expect(
      turnEnd([user("Do it."), { role: "assistant", content: "Done." }]),
    ).toBe("answer");
  });

  it("skips a compaction entry after the answer", () => {
    expect(turnEnd([user("Do it."), answer("Done."), compaction])).toBe(
      "answer",
    );
    expect(turnEnd([user("Do it."), compaction])).toBeUndefined();
  });

  it("is open while a call's result is missing or the model has not seen it", () => {
    expect(turnEnd([user("Do it."), calling("bash")])).toBeUndefined();
    expect(
      turnEnd([user("Do it."), calling("bash"), result("bash", "ok")]),
    ).toBeUndefined();
    // A refused completion leaves the turn to the model.
    expect(
      turnEnd([
        calling("complete_task"),
        result("complete_task", "2 delegation(s) have not reported yet.", true),
      ]),
    ).toBeUndefined();
    // Input after the results is the model's to read.
    expect(
      turnEnd([
        calling("complete_task"),
        result("complete_task", "The result is recorded."),
        user("Message from the user:\nWait."),
      ]),
    ).toBeUndefined();
  });

  it("is the engine's when it parked the turn", () => {
    expect(
      turnEnd([
        user("Do it."),
        calling("task_state", "task_log"),
        result("task_state", parkedText(2), true, 0),
        result("task_log", parkedText(2), true, 1),
      ]),
    ).toBe("engine");
    // A call pi refused for its arguments gets pi's error instead.
    expect(
      turnEnd([
        calling("task_state", "read_report"),
        result("task_state", parkedText(1), true, 0),
        result("read_report", "Validation failed.", true, 1),
      ]),
    ).toBe("engine");
    // Only the engine's own text, and only as an error result.
    expect(
      turnEnd([calling("read"), result("read", parkedText(1), false)]),
    ).toBeUndefined();
    expect(
      turnEnd([calling("read"), result("read", `${parkedText(1)}!`, true)]),
    ).toBeUndefined();
  });

  it("is the engine's when a completion ended the run", () => {
    expect(
      turnEnd([
        user("Do it."),
        calling("complete_task"),
        result(
          "complete_task",
          "The result is recorded; the task completes when this turn ends.",
        ),
        compaction,
      ]),
    ).toBe("engine");
  });
});
