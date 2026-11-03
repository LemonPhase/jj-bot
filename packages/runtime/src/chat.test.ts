import {
  fauxAssistantMessage,
  fauxProvider,
  Type,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { ChatReplyError, ChatResponder } from "./chat";
import { ModelRegistry } from "./models";
import { SCRIPTED_MODEL_REF } from "./scripted";
import { callTool, say } from "./test-support";
import type { CollabTool } from "./types";

interface Listed {
  id: string;
  title: string;
  status: string;
  result?: string;
}

/**
 * Chat tools shaped as the engine declares them: bot names are a schema enum,
 * task ids plain strings. `list_tasks` and `get_task` answer in the engine's
 * line formats, which the scripted model reads.
 */
function chatTools(listed: Listed[] = []) {
  const created: { goal: string; participants: string[] }[] = [];
  const forwarded: { id: string; text: string }[] = [];
  const opened: string[] = [];
  const stopped: string[] = [];
  const find = (args: Record<string, unknown>) =>
    listed.find((task) => task.id === String(args.id));
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
    {
      name: "list_tasks",
      description: "Your tasks, newest first.",
      parameters: Type.Object({ status: Type.Optional(Type.String()) }),
      readOnly: true,
      execute: async () => ({
        text:
          listed.length === 0
            ? "You take part in no tasks yet."
            : [
                `Your tasks, newest first (${listed.length} of ${listed.length}):`,
                ...listed.map(
                  (task) =>
                    `- ${task.id} ${JSON.stringify(task.title)}: ${task.status} · you coordinate · updated 2026-11-02T10:00Z${task.result ? ` · Result: ${task.result}` : ""}`,
                ),
              ].join("\n"),
      }),
    },
    {
      name: "get_task",
      description: "One task in detail.",
      parameters: Type.Object({ id: Type.String() }),
      readOnly: true,
      execute: async (args) => {
        const task = find(args);
        if (!task) return { text: "No such task.", isError: true };
        opened.push(task.id);
        return {
          text: [
            `Task ${task.id} ${JSON.stringify(task.title)}: ${task.status}`,
            "Goal (version 1):",
            task.title,
            ...(task.result ? [`Result: ${task.result}`] : []),
          ].join("\n"),
        };
      },
    },
    {
      name: "send_to_task",
      description: "Pass a message on to a task.",
      parameters: Type.Object({ id: Type.String(), text: Type.String() }),
      execute: async (args) => {
        forwarded.push({ id: String(args.id), text: String(args.text) });
        return { text: `Sent to ${String(args.id)}.` };
      },
    },
    {
      name: "stop_task",
      description: "Stop a task you coordinate.",
      parameters: Type.Object({ id: Type.String() }),
      execute: async (args) => {
        stopped.push(String(args.id));
        return { text: `Stopped the task ${String(args.id)}.` };
      },
    },
  ];
  return { tools, created, forwarded, opened, stopped };
}

describe("ChatResponder with the scripted model", () => {
  const responder = new ChatResponder({
    models: new ModelRegistry({ env: {}, enableScripted: true }),
  });
  const reply = (text: string, tools: CollabTool[]) =>
    responder.reply({
      // Free-form: the scripted model reads bots and tasks from tools.
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
    // list_tasks, create_task, then the answer.
    expect(answer.usage.modelCalls).toBe(3);
  });

  it("forwards a follow-up about a task, finished or not, instead of creating another", async () => {
    const { tools, created, forwarded } = chatTools([
      { id: "task_9", title: "Landing page", status: "running" },
      {
        id: "task_7",
        title: "Penguin report",
        status: "completed",
        result: "Wrote penguins.md.",
      },
    ]);
    expect((await reply("Any progress?", tools)).text).toBe(
      "I'm working on: Landing page.",
    );
    const answer = await reply(
      "For the penguin report, please add a section on diet.",
      tools,
    );
    expect(created).toEqual([]);
    expect(forwarded).toEqual([
      {
        id: "task_7",
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

  it("answers how a task went from its result: list, get, then reply", async () => {
    const { tools, opened, created } = chatTools([
      {
        id: "task_7",
        title: "Penguin report",
        status: "completed",
        result: "Wrote penguins.md with three sections.",
      },
    ]);
    const answer = await reply("How did it go?", tools);
    expect(opened).toEqual(["task_7"]);
    expect(created).toEqual([]);
    expect(answer.text).toBe(
      '"Penguin report" is completed. Result: Wrote penguins.md with three sections.',
    );
    expect(answer.usage.modelCalls).toBe(3);
  });

  it("stops the task the user asks it to stop", async () => {
    const { tools, stopped } = chatTools([
      { id: "task_9", title: "Landing page", status: "running" },
    ]);
    const answer = await reply("Please stop that task.", tools);
    expect(stopped).toEqual(["task_9"]);
    expect(answer.text).toBe("Stopped the task task_9.");
  });

  it("tells a task update in its own words, with only the read tools", async () => {
    const { tools } = chatTools();
    const readOnly = tools.filter((tool) => tool.readOnly);
    const answer = await reply(
      [
        "[Task update] This comes from JJ Bot, not from the user: a task you coordinate completed.",
        'Task: task_7 "Penguin report"',
        "Status now: completed.",
        "Result, as the task recorded it:",
        "Wrote penguins.md with three sections.",
        "",
        "Tell the user how it went.",
      ].join("\n"),
      readOnly,
    );
    expect(answer.text).toBe(
      'Update on "Penguin report": it completed. Wrote penguins.md with three sections.',
    );
    expect(answer.usage.modelCalls).toBe(1);
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
      Array.from({ length: 10 }, () => callTool("list_tasks", {})),
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

  it("never answers with a lookup's output when the budget ends the reply", async () => {
    const faux = fauxProvider();
    const responder = new ChatResponder({
      models: new ModelRegistry({ env: {}, extraProviders: [faux.provider] }),
    });
    const { tools } = chatTools([
      { id: "task_7", title: "Penguin report", status: "running" },
    ]);
    faux.setResponses([callTool("list_tasks", {}), say("never reached")]);
    await expect(
      responder.reply({
        systemPrompt: "x",
        history: [{ role: "user", text: "How is it going?" }],
        model: "faux/faux-1",
        tools,
        budgets: { maxTurns: 1 },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "budget" });
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

  it("answers with a created task's text when the budget ends the reply first", async () => {
    const faux = fauxProvider();
    const responder = new ChatResponder({
      models: new ModelRegistry({ env: {}, extraProviders: [faux.provider] }),
    });
    const { tools, created } = chatTools();
    faux.setResponses([
      callTool("create_task", { goal: "Build it", participants: [] }),
      say("never reached"),
    ]);
    const answer = await responder.reply({
      systemPrompt: "x",
      history: [{ role: "user", text: "Build it" }],
      model: "faux/faux-1",
      tools,
      budgets: { maxTurns: 1 },
      signal: new AbortController().signal,
    });
    // A retry of this reply must not create a second task: it succeeded.
    expect(answer.text).toBe("Created task task_1.");
    expect(created).toHaveLength(1);
  });

  it("refuses invalid budgets", async () => {
    const responder = new ChatResponder({
      models: new ModelRegistry({ env: {}, enableScripted: true }),
    });
    for (const budgets of [
      { maxTurns: Number.NaN },
      { maxTurns: 0 },
      { maxTurns: 2, deadline: new Date(Number.NaN) },
    ])
      await expect(
        responder.reply({
          systemPrompt: "x",
          history: [{ role: "user", text: "hi" }],
          model: SCRIPTED_MODEL_REF,
          tools: [],
          budgets,
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("classifies and redacts a provider failure", async () => {
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "401 invalid x-api-key sk-ant-api03-SECRETSECRETSECRET",
      }),
    ]);
    const responder = new ChatResponder({
      models: new ModelRegistry({ env: {}, extraProviders: [faux.provider] }),
      retry: { maxRetries: 0 },
    });
    const failure = await responder
      .reply({
        systemPrompt: "x",
        history: [{ role: "user", text: "hi" }],
        model: "faux/faux-1",
        tools: [],
        signal: new AbortController().signal,
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ChatReplyError);
    expect(failure).toMatchObject({ code: "auth" });
    expect((failure as Error).message).not.toContain("SECRETSECRET");
  });
});
