import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  appendedRepairs,
  INTERRUPTED_BY_RESTART,
  parseTranscript,
  repairTranscript,
  serializeEntry,
  TranscriptFormatError,
} from "./transcript";
import type { PiMessage } from "./types";

const user = (text: string): PiMessage => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp: 1,
});
const result = (toolCallId: string, text: string): PiMessage => ({
  role: "toolResult",
  toolCallId,
  toolName: "bash",
  content: [{ type: "text", text }],
  isError: false,
  timestamp: 3,
});

describe("repairTranscript", () => {
  it("answers a dangling tool call as interrupted with an unknown outcome", () => {
    const calls = fauxAssistantMessage(
      [
        fauxToolCall("bash", { command: "npm test" }, { id: "call-1" }),
        fauxToolCall("bash", { command: "npm run build" }, { id: "call-2" }),
      ],
      { stopReason: "toolUse", timestamp: 2 },
    );
    const transcript: PiMessage[] = [
      user("Build it"),
      calls,
      result("call-1", "ok"),
    ];
    const repaired = repairTranscript(transcript);

    expect(repaired.slice(0, 3)).toEqual(transcript);
    expect(repaired[3]).toMatchObject({
      role: "toolResult",
      toolCallId: "call-2",
      toolName: "bash",
      isError: true,
      content: [{ type: "text", text: INTERRUPTED_BY_RESTART }],
      details: { interrupted: "unknown" },
    });
    expect(repaired).toHaveLength(4);
    expect(appendedRepairs(transcript, repaired)).toEqual([repaired[3]]);
    // Repairing again changes nothing.
    expect(repairTranscript(repaired)).toEqual(repaired);
  });

  it("places a repair after the call's own results, before later messages", () => {
    const calls = fauxAssistantMessage(
      fauxToolCall("bash", { command: "sleep 1" }, { id: "lost" }),
      {
        stopReason: "toolUse",
      },
    );
    const transcript: PiMessage[] = [user("a"), calls, user("b")];
    const repaired = repairTranscript(transcript);
    expect(repaired.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "user",
    ]);
    expect(appendedRepairs(transcript, repaired)).toEqual([]);
  });

  it("leaves an intact transcript unchanged", () => {
    const transcript: PiMessage[] = [
      user("hi"),
      fauxAssistantMessage(fauxText("hello")),
    ];
    expect(repairTranscript(transcript)).toEqual(transcript);
    expect(appendedRepairs(transcript, repairTranscript(transcript))).toEqual(
      [],
    );
  });
});

describe("transcript serialization", () => {
  it("round-trips entries through JSON", () => {
    const transcript: PiMessage[] = [
      user("hi"),
      fauxAssistantMessage(
        [
          fauxText("running"),
          fauxToolCall("bash", { command: "ls" }, { id: "c" }),
        ],
        {
          stopReason: "toolUse",
        },
      ),
      result("c", "file.txt"),
    ];
    const stored = JSON.parse(
      JSON.stringify(transcript.map(serializeEntry)),
    ) as unknown[];
    expect(parseTranscript(stored)).toEqual(transcript);
  });

  it("refuses entries it does not recognise", () => {
    expect(() =>
      parseTranscript([
        { role: "user", content: "x", timestamp: 1 },
        { role: "system", content: "x" },
      ]),
    ).toThrow(TranscriptFormatError);
    expect(() => parseTranscript([{ role: "assistant", content: [] }])).toThrow(
      /entry 0/,
    );
  });
});
