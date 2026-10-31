import type { Bot, ExecutionSession } from "@jj/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  GeminiSessionExecutor,
  type InteractionClient,
  type ModelResponse,
  type RuntimeEvent,
  verifyDeterministic,
} from "./index";

const bot: Bot = {
  id: "bot-a",
  name: "Researcher",
  instructions: "Use only session context",
};
const session: ExecutionSession = {
  id: "session-a",
  taskId: "task-a",
  botId: bot.id,
  goalVersion: 1,
  brief: "Return 42",
  status: "running",
  verificationPlan: [
    {
      id: "answer",
      description: "Includes the answer",
      method: "literal",
      expectedEvidence: "42 in output",
    },
  ],
};
function setup(
  responses: ModelResponse[],
  options: { maxSteps?: number; maxRevisions?: number } = {},
) {
  const requests: Parameters<InteractionClient["create"]>[0][] = [];
  const client: InteractionClient = {
    create: async (request) => {
      requests.push(structuredClone(request));
      const response = responses.shift();
      if (!response) throw new Error("Unexpected model call");
      return response;
    },
  };
  const executor = new GeminiSessionExecutor({
    apiKey: "test",
    model: "test-model",
    client,
    ...options,
  });
  const events: RuntimeEvent[] = [];
  const input = {
    session,
    bot,
    context: "Selected evidence: answer is 42",
    signal: new AbortController().signal,
    emit: async (event: RuntimeEvent) => {
      events.push(event);
    },
    checks: [{ id: "answer", kind: "contains" as const, value: "42" }],
  };
  return { executor, input, requests, events };
}
const answer = (text: string): ModelResponse => ({
  steps: [],
  output_text: text,
});

describe("Gemini session execution", () => {
  it("executes a backend tool and preserves full stateless steps/results", async () => {
    const call = {
      type: "function_call" as const,
      id: "call-1",
      name: "add_numbers",
      arguments: { a: 19, b: 23 },
    };
    const { executor, input, requests, events } = setup([
      { steps: [call] },
      answer("42"),
    ]);
    const result = await executor.execute(input);
    expect(result.checks[0]?.outcome).toBe("passed");
    expect(requests).toHaveLength(2);
    expect(requests[1]?.input).toEqual(
      expect.arrayContaining([
        call,
        expect.objectContaining({
          type: "function_result",
          name: "add_numbers",
          call_id: "call-1",
          result: [{ type: "text", text: '{"sum":42}' }],
        }),
      ]),
    );
    expect(requests.every((request) => request.store === false)).toBe(true);
    expect(events.some((event) => event.type === "tool.finished")).toBe(true);
  });
  it("feeds failed checks into a revision and verifies again", async () => {
    const { executor, input, requests, events } = setup([
      answer("wrong"),
      answer("42"),
    ]);
    const result = await executor.execute(input);
    expect(result.summary).toBe("42");
    expect(result.checks[0]?.outcome).toBe("passed");
    expect(JSON.stringify(requests[1]?.input)).toContain(
      "did not pass verification",
    );
    const checks = events.filter(
      (event) => event.type === "verification.recorded",
    );
    expect(checks.map((event) => event.payload.outcome)).toEqual([
      "failed",
      "passed",
    ]);
  });
  it("preserves failed verification after the revision budget", async () => {
    const { executor, input } = setup([answer("wrong")], { maxRevisions: 0 });
    expect((await executor.execute(input)).checks[0]?.outcome).toBe("failed");
  });
  it("does not execute a model-invented tool", async () => {
    const tool = vi.fn(async () => "secret");
    const { executor, input, requests } = setup([
      {
        steps: [
          {
            type: "function_call",
            id: "denied",
            name: "shell",
            arguments: { command: "anything" },
          },
        ],
      },
      answer("42"),
    ]);
    await executor.execute({
      ...input,
      tools: [
        {
          name: "allowed",
          description: "Allowed",
          parameters: { type: "object" },
          execute: tool,
        },
      ],
    });
    expect(tool).not.toHaveBeenCalled();
    expect(JSON.stringify(requests[1]?.input)).toContain("Tool is not allowed");
  });
  it("rejects invalid tool arguments before executing", async () => {
    const { executor, input, requests } = setup([
      {
        steps: [
          {
            type: "function_call",
            id: "invalid",
            name: "add_numbers",
            arguments: { a: "19", b: 23 },
          },
        ],
      },
      answer("42"),
    ]);
    await executor.execute(input);
    expect(JSON.stringify(requests[1]?.input)).toContain(
      "arguments.a must be finite",
    );
  });
  it("bounds repeated tool calls with a global model-call budget", async () => {
    const { executor, input } = setup(
      [
        {
          steps: [
            {
              type: "function_call",
              id: "repeat",
              name: "read_context",
              arguments: {},
            },
          ],
        },
      ],
      { maxSteps: 1 },
    );
    await expect(executor.execute(input)).rejects.toThrow(
      "step budget exhausted",
    );
  });
  it("runs a separate reviewer and treats malformed review as inconclusive", async () => {
    const { executor, input, requests } = setup(
      [answer("42"), answer("I think it passed")],
      { maxRevisions: 0 },
    );
    const result = await executor.execute({
      ...input,
      checks: [{ id: "answer", kind: "model" }],
    });
    expect(result.checks[0]?.outcome).toBe("inconclusive");
    expect(requests).toHaveLength(2);
    expect(String(requests[1]?.input)).toContain("separate verifier");
  });
  it("requires reviewer evidence even when reviewer claims passed", async () => {
    const { executor, input } = setup(
      [answer("42"), answer('{"outcome":"passed","evidence":[]}')],
      { maxRevisions: 0 },
    );
    const result = await executor.execute({ ...input, checks: undefined });
    expect(result.checks[0]?.outcome).toBe("inconclusive");
  });
  it("cancels an in-flight model call without waiting for a cooperative client", async () => {
    const controller = new AbortController();
    const executor = new GeminiSessionExecutor({
      apiKey: "test",
      model: "test",
      client: { create: () => new Promise(() => {}) },
    });
    const { input } = setup([]);
    const pending = executor.execute({ ...input, signal: controller.signal });
    controller.abort(new Error("User stopped task"));
    await expect(pending).rejects.toThrow("User stopped task");
  });
  it("enforces a session-wide deadline", async () => {
    const executor = new GeminiSessionExecutor({
      apiKey: "test",
      model: "test",
      timeoutMs: 10,
      client: { create: () => new Promise(() => {}) },
    });
    const { input } = setup([]);
    await expect(executor.execute(input)).rejects.toThrow();
  });
});
describe("deterministic verification", () => {
  it("distinguishes invalid JSON, invalid regex and successful checks", () => {
    expect(
      verifyDeterministic("not-json", { id: "json", kind: "json" }).outcome,
    ).toBe("failed");
    expect(
      verifyDeterministic('{"a":1}', { id: "json", kind: "json" }).outcome,
    ).toBe("passed");
    expect(
      verifyDeterministic("42", { id: "regex", kind: "regex", value: "[" })
        .outcome,
    ).toBe("inconclusive");
    expect(
      verifyDeterministic("42", { id: "regex", kind: "regex", value: "^42$" })
        .outcome,
    ).toBe("passed");
  });
  it("separates verification calls from the work step budget", async () => {
    const criteria = Array.from({ length: 10 }, (_, index) => ({
      id: `criterion-${index}`,
      description: "A criterion",
      method: "review",
      expectedEvidence: "Evidence",
    }));
    const executor = new GeminiSessionExecutor({
      apiKey: "test",
      model: "test-model",
      client: {
        create: async () => ({
          status: "completed",
          output_text: "candidate",
          steps: [],
        }),
      },
    });
    const result = await executor.execute({
      session: { ...session, verificationPlan: criteria },
      bot,
      context: "",
      signal: new AbortController().signal,
      emit: async () => {},
      checks: [],
    });
    expect(result.checks).toHaveLength(10);
    expect(
      result.checks.every((check) => check.outcome === "inconclusive"),
    ).toBe(true);
  }, 20_000);
  it("retries transient provider failures", async () => {
    let calls = 0;
    const executor = new GeminiSessionExecutor({
      apiKey: "test",
      model: "test-model",
      client: {
        create: async () => {
          calls += 1;
          if (calls === 1) throw new Error("503 Service Unavailable");
          return { status: "completed", output_text: "done", steps: [] };
        },
      },
    });
    const result = await executor.execute({
      session,
      bot,
      context: "",
      signal: new AbortController().signal,
      emit: async () => {},
      checks: [{ id: "answer", kind: "contains", value: "done" }],
    });
    expect(calls).toBe(2);
    expect(result.summary).toBe("done");
  }, 20_000);
});
