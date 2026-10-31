import { fauxProvider, Type } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { ChatReplyError, ChatResponder } from "./chat";
import { ModelRegistry } from "./models";
import { SCRIPTED_MODEL_REF } from "./scripted";
import { callTool, say } from "./test-support";
import type { CollabTool } from "./types";

/**
 * Chat tools as the engine declares them: bot names and active task ids are
 * schema enums. `send_to_task` is offered only when a task is active.
 */
function chatTools(active: { id: string; title: string }[] = []) {
  const created: { goal: string; participants: string[] }[] = [];
  const forwarded: { taskId: string; text: string }[] = [];
  const tools: CollabTool[] = [
    {
      name: "create_task",
      description: "Start a task.",
      parameters: Type.Object({
        goal: Type.String(),
        title: Type.Optional(Type.String()),
        participants: Type.Array(Type.Enum(["Ada", "Bob", "Cy"]), {
          description:
            "Bots to include: Ada (assistant), Bob (researcher), Cy (writer).",
        }),
      }),
      execute: async (args) => {
        created.push({
          goal: String(args.goal),
          participants: args.participants as string[],
        });
        return { text: `Created task task_${created.length}.` };
      },
    },
  ];
  if (active.length > 0)
    tools.push({
      name: "send_to_task",
      description: "Forward a message to an active task.",
      parameters: Type.Object({
        taskId: Type.Enum(
          active.map((task) => task.id),
          {
            description: `Active task: ${active.map((task) => `${task.id}: ${task.title}`).join("; ")}`,
          },
        ),
        text: Type.String(),
      }),
      execute: async (args) => {
        forwarded.push({
          taskId: String(args.taskId),
          text: String(args.text),
        });
        return { text: `Sent to ${String(args.taskId)}.` };
      },
    });
  return { tools, created, forwarded };
}

describe("ChatResponder with the scripted model", () => {
  const responder = new ChatResponder({
    models: new ModelRegistry({ env: {}, enableScripted: true }),
  });
  const reply = (text: string, tools: CollabTool[]) =>
    responder.reply({
      // Free-form: the scripted model reads bots and tasks from tool schemas.
      systemPrompt: "You are Ada, a friendly assistant.",
      history: [
        { role: "user", text: "Hi" },
        { role: "assistant", text: "Hello!" },
        { role: "user", text },
      ],
      model: SCRIPTED_MODEL_REF,
      tools,
      signal: new AbortController().signal,
    });

  it("answers greetings and thanks without creating a task", async () => {
    const { tools, created, forwarded } = chatTools();
    expect((await reply("Hello there!", tools)).text).toMatch(/^Hello!/);
    expect((await reply("Thanks a lot!", tools)).text).toBe("You're welcome!");
    expect((await reply("What's your status?", tools)).text).toBe(
      "I have no active tasks right now.",
    );
    expect(created).toEqual([]);
    expect(forwarded).toEqual([]);
  });

  it("creates exactly one task for a work request, with the participants it names", async () => {
    const { tools, created } = chatTools();
    const answer = await reply(
      "Please research penguins with Bob and write it up.",
      tools,
    );
    expect(created).toEqual([
      {
        goal: "Please research penguins with Bob and write it up.",
        participants: ["Bob"],
      },
    ]);
    expect(answer.text).toBe(
      "I've started a task for that. Created task task_1.",
    );
    expect(answer.model).toBe(SCRIPTED_MODEL_REF);
    expect(answer.usage.modelCalls).toBe(2);
  });

  it("forwards a follow-up about an active task instead of creating another", async () => {
    const { tools, created, forwarded } = chatTools([
      { id: "task_7", title: "Penguin report" },
      { id: "task_9", title: "Landing page" },
    ]);
    expect((await reply("Any progress?", tools)).text).toBe(
      "I'm working on: Penguin report; Landing page.",
    );
    const answer = await reply(
      "For the penguin report, please add a section on diet.",
      tools,
    );
    expect(created).toEqual([]);
    expect(forwarded).toEqual([
      {
        taskId: "task_7",
        text: "For the penguin report, please add a section on diet.",
      },
    ]);
    expect(answer.text).toBe(
      "I've passed that on to the task. Sent to task_7.",
    );
    // A request about neither task starts a new one.
    await reply("Please draft a launch email with Cy.", tools);
    expect(created).toEqual([
      { goal: "Please draft a launch email with Cy.", participants: ["Cy"] },
    ]);
    expect(forwarded).toHaveLength(1);
  });
});

describe("ChatResponder", () => {
  it("stops a reply that keeps calling tools at its turn budget", async () => {
    const faux = fauxProvider();
    const responder = new ChatResponder({
      models: new ModelRegistry({ env: {}, extraProviders: [faux.provider] }),
    });
    const { tools } = chatTools();
    faux.setResponses(
      Array.from({ length: 10 }, () =>
        callTool("send_to_task", { taskId: "t", text: "x" }),
      ),
    );
    await expect(
      responder.reply({
        systemPrompt: "x",
        history: [{ role: "user", text: "loop" }],
        model: "faux/faux-1",
        tools,
        budgets: { maxTurns: 50 },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "budget" });
    // The budget is capped at six model calls whatever is asked.
    expect(faux.getPendingResponseCount()).toBe(4);
  });

  it("refuses a history that does not end with the user", async () => {
    const faux = fauxProvider();
    faux.setResponses([say("x")]);
    const responder = new ChatResponder({
      models: new ModelRegistry({ env: {}, extraProviders: [faux.provider] }),
    });
    await expect(
      responder.reply({
        systemPrompt: "x",
        history: [{ role: "assistant", text: "hi" }],
        model: "faux/faux-1",
        tools: [],
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(ChatReplyError);
  });
});
