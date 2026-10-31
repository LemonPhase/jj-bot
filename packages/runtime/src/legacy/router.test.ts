import { describe, expect, it } from "vitest";
import {
  fallbackBotTurn,
  GeminiBotRouter,
  type InteractionClient,
  parseBotTurnDecision,
} from "./index";

describe("bot turn routing", () => {
  it("accepts a valid reply", () => {
    expect(
      parseBotTurnDecision('{"kind":"reply","reply":"Hi there"}', []),
    ).toEqual({ kind: "reply", reply: "Hi there" });
  });
  it("accepts an existing task id from the supplied list", () => {
    expect(
      parseBotTurnDecision('{"kind":"existing_task","taskId":"t1"}', ["t1"]),
    ).toEqual({ kind: "existing_task", taskId: "t1" });
  });
  it("rejects an unknown task id and starts a task instead", () => {
    expect(
      parseBotTurnDecision('{"kind":"existing_task","taskId":"nope"}', ["t1"]),
    ).toEqual({ kind: "new_task" });
  });
  it("falls back to a task for malformed output", () => {
    expect(parseBotTurnDecision("not json", [])).toEqual({ kind: "new_task" });
    expect(parseBotTurnDecision('{"kind":"reply","reply":""}', [])).toEqual({
      kind: "new_task",
    });
  });
  it("replies to greetings when the router is unavailable", () => {
    expect(fallbackBotTurn("hello!").kind).toBe("reply");
    expect(fallbackBotTurn("please build the report").kind).toBe("new_task");
  });
  it("returns the model decision", async () => {
    const client: InteractionClient = {
      create: async () => ({
        steps: [],
        output_text: '{"kind":"reply","reply":"Hey"}',
        status: "completed",
      }),
    };
    const router = new GeminiBotRouter({ apiKey: "test", model: "m", client });
    const decision = await router.decide({
      bot: { id: "b", name: "Bot", instructions: "Be brief" },
      memory: "",
      messages: [],
      tasks: [],
      text: "hi",
      signal: new AbortController().signal,
    });
    expect(decision).toEqual({ kind: "reply", reply: "Hey" });
  });
});
