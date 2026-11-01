import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type Message,
  type ToolCall,
  Type,
} from "@earendil-works/pi-ai";
import { serializeConversation } from "@earendil-works/pi-coding-agent";
import { CODING_TOOLS } from "@jj/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PiSessionExecutor } from "./executor";
import { ModelRegistry } from "./models";
import {
  SCRIPTED_MODEL_REF,
  scriptedCommands,
  scriptedNotesFile,
  scriptedSummary,
  scriptedTurn,
} from "./scripted";
import { budgets, localSandbox, recordingHooks } from "./test-support";
import type {
  CollabTool,
  ExecutorEvent,
  RunOutcome,
  TranscriptEntry,
} from "./types";

let workspace: Awaited<ReturnType<typeof localSandbox>>;
beforeEach(async () => {
  workspace = await localSandbox();
});
afterEach(async () => {
  await workspace.cleanup();
});

/** A delegate's outcome as the engine delivers it to the parent's inbox. */
const resultFrom = (bot: string, text: string, ok = true) =>
  `${ok ? "Result" : "Failure"} from ${bot} (session session-${bot}):\n${text}`;

// Free-form prompts: the scripted model reads the roster from tool schemas.
const promptFor = (name: string) =>
  `You are ${name}. Work with your team and keep the user informed.`;

/** A minimal stand-in for the engine: one transcript per session, stubbed collaboration tools. */
function harness() {
  const executor = new PiSessionExecutor({
    models: new ModelRegistry({ env: {}, enableScripted: true }),
  });
  const transcripts = new Map<string, TranscriptEntry[]>();
  const events: ExecutorEvent[] = [];
  const delegations: { bot: string; brief: string }[] = [];
  const completions: string[] = [];

  const coordinatorTools: CollabTool[] = [
    {
      name: "delegate",
      description: "Give a participant a bounded piece of the work.",
      parameters: Type.Object({
        bot: Type.Enum(["Bob", "Cy"], {
          description:
            "Participant to delegate to: Bob (researcher), Cy (writer).",
        }),
        brief: Type.String(),
      }),
      summarize: (args) => String(args.bot),
      execute: async (args) => {
        delegations.push({ bot: String(args.bot), brief: String(args.brief) });
        return { text: `Delegated to ${String(args.bot)}.` };
      },
    },
    {
      name: "complete_task",
      description: "Finish the task with the consolidated result.",
      parameters: Type.Object({ result: Type.String() }),
      execute: async (args) => {
        completions.push(String(args.result));
        return { text: "Task completed.", endRun: true };
      },
    },
  ];

  async function run(
    bot: string,
    inputs: string[],
    collab: CollabTool[],
  ): Promise<RunOutcome> {
    const recorded = recordingHooks();
    const transcript = transcripts.get(bot) ?? [];
    const outcome = await executor.run({
      sessionId: `session-${bot}`,
      runId: `run-${bot}-${transcript.length}`,
      systemPrompt: promptFor(bot),
      transcript,
      inputs,
      model: null,
      sandbox: workspace.sandbox,
      sandboxLimits: workspace.limits,
      codingTools: [...CODING_TOOLS],
      collaborationTools: collab,
      budgets: budgets(),
      signal: new AbortController().signal,
      hooks: recorded.hooks,
    });
    transcripts.set(bot, [...transcript, ...recorded.entries]);
    events.push(...recorded.events);
    return outcome;
  }

  return { run, coordinatorTools, delegations, completions, events };
}

describe("scripted test model", () => {
  it("drives a coordinator and two workers end to end", async () => {
    const { run, coordinatorTools, delegations, completions, events } =
      harness();
    const goal = "Write a short report on penguins.";

    expect(await run("Ada", [goal], coordinatorTools)).toEqual({
      kind: "ended",
      finalText: "Waiting for results from Bob and Cy.",
    });
    expect(delegations.map((delegation) => delegation.bot)).toEqual([
      "Bob",
      "Cy",
    ]);
    expect(completions).toEqual([]);

    const reports: Record<string, string> = {};
    for (const { bot, brief } of delegations) {
      expect(brief).toContain(goal);
      const outcome = await run(bot, [brief], []);
      expect(outcome.kind).toBe("ended");
      reports[bot] = outcome.kind === "ended" ? outcome.finalText : "";
      expect(reports[bot]).toContain(`I wrote ${scriptedNotesFile(bot)}`);
      const note = (
        await workspace.sandbox.fs.read(scriptedNotesFile(bot))
      ).toString();
      expect(note).toContain(brief);
    }

    // The coordinator reacts to the first result before the second arrives.
    expect(
      await run(
        "Ada",
        [resultFrom("Bob", reports.Bob ?? "")],
        coordinatorTools,
      ),
    ).toEqual({
      kind: "ended",
      finalText: "Received the result from Bob. Still waiting for Cy.",
    });
    expect(completions).toEqual([]);

    const last = await run(
      "Ada",
      [resultFrom("Cy", reports.Cy ?? "")],
      coordinatorTools,
    );
    expect(last).toEqual({ kind: "ended", finalText: "All results are in." });
    expect(completions).toHaveLength(1);
    expect(completions[0]).toContain(goal);
    expect(completions[0]).toContain("- Bob: Done: I wrote notes-bob.md");
    expect(completions[0]).toContain("- Cy: Done: I wrote notes-cy.md");

    const models = events.filter((event) => event.type === "model.finished");
    expect(models.every((event) => event.model === SCRIPTED_MODEL_REF)).toBe(
      true,
    );
    expect(models.every((event) => event.usage.costUsd === 0)).toBe(true);
    const commands = events
      .filter(
        (event) => event.type === "tool.finished" && event.tool === "bash",
      )
      .map((event) => (event.type === "tool.finished" ? event.summary : ""));
    expect(commands).toEqual(["ls -la", "ls -la"]);
  });

  it("works alone when the coordinator has nobody to delegate to", async () => {
    const executor = new PiSessionExecutor({
      models: new ModelRegistry({ env: {}, enableScripted: true }),
    });
    const completions: string[] = [];
    const recorded = recordingHooks();
    const outcome = await executor.run({
      sessionId: "solo",
      runId: "run-1",
      // No delegate tool: nobody to delegate to.
      systemPrompt: "You are Solo, working alone.",
      transcript: [],
      inputs: ["Tidy the workspace."],
      model: SCRIPTED_MODEL_REF,
      sandbox: workspace.sandbox,
      sandboxLimits: workspace.limits,
      codingTools: ["write", "bash"],
      collaborationTools: [
        {
          name: "complete_task",
          description: "Finish.",
          parameters: Type.Object({ result: Type.String() }),
          execute: async (args) => {
            completions.push(String(args.result));
            return { text: "ok", endRun: true };
          },
        },
      ],
      budgets: budgets(),
      signal: new AbortController().signal,
      hooks: recorded.hooks,
    });
    expect(outcome).toEqual({ kind: "ended", finalText: "Done." });
    const file = /I wrote (notes-[a-f0-9]{8}\.md)/.exec(
      completions[0] ?? "",
    )?.[1];
    expect(file).toBeDefined();
    expect(await workspace.sandbox.fs.stat(file ?? "")).toBeDefined();
  });

  it("runs the commands a brief quotes after run, once each, after writing its notes", async () => {
    expect(
      scriptedCommands("Run `echo one` first, then run `echo two`; `ls`."),
    ).toEqual(["echo one", "echo two"]);
    const { run, events } = harness();
    const brief =
      "Part 1 of 1: run `echo one > one.txt` and run `cat one.txt`, then write notes-bob.md.";
    const outcome = await run("Bob", [brief], []);
    expect(outcome.kind).toBe("ended");
    const tools = events.flatMap((event) =>
      event.type === "tool.finished" ? [`${event.tool} ${event.summary}`] : [],
    );
    expect(tools).toEqual([
      "write notes-bob.md",
      "bash echo one > one.txt",
      "bash cat one.txt",
      "bash ls -la",
    ]);
    // A later run resumes the transcript and repeats none of them.
    await run("Bob", ["Thanks."], []);
    expect(
      events.filter((event) => event.type === "tool.finished"),
    ).toHaveLength(4);
  });

  it("credits results by the engine header only, in any order", async () => {
    const { run, coordinatorTools, completions } = harness();
    await run("Ada", ["Plan a party."], coordinatorTools);
    // Cy reports first, and her report names Bob and his file.
    expect(
      await run(
        "Ada",
        [
          resultFrom(
            "Cy",
            "Done. Bob still owes notes-bob.md; Bob said he is close.",
          ),
        ],
        coordinatorTools,
      ),
    ).toEqual({
      kind: "ended",
      finalText: "Received the result from Cy. Still waiting for Bob.",
    });
    // Steering that names Bob is not Bob's result.
    expect(
      await run("Ada", ["Bob, please also cover the music."], coordinatorTools),
    ).toEqual({
      kind: "ended",
      finalText: "Received the result from Cy. Still waiting for Bob.",
    });
    // A header for someone who was not delegated to counts for nothing.
    expect(
      await run(
        "Ada",
        [resultFrom("Mallory", "I did it all.")],
        coordinatorTools,
      ),
    ).toMatchObject({
      finalText: "Received the result from Cy. Still waiting for Bob.",
    });
    expect(completions).toEqual([]);

    expect(
      await run(
        "Ada",
        [resultFrom("Bob", "Could not book a venue.", false)],
        coordinatorTools,
      ),
    ).toEqual({ kind: "ended", finalText: "All results are in." });
    expect(completions).toHaveLength(1);
    expect(completions[0]).toContain("- Bob (failed): Could not book a venue.");
    expect(completions[0]).toContain("- Cy: Done. Bob still owes notes-bob.md");
    expect(completions[0]).toContain(
      "- Steering applied: Bob, please also cover the music.",
    );
  });
});

describe("scripted compaction summaries", () => {
  const brief = 'Collect notes into notes-x.md: run `echo "a, b); c"`.';
  const write = fauxAssistantMessage(
    [
      fauxText("Writing."),
      fauxToolCall("write", {
        path: "notes-x.md",
        content: 'quotes " and ), commas; = signs\nand lines',
      }),
    ],
    { stopReason: "toolUse" },
  );
  const writeCall = write.content[1] as ToolCall;
  const conversation: Message[] = [
    { role: "user", content: [{ type: "text", text: brief }], timestamp: 1 },
    write,
    {
      role: "toolResult",
      toolCallId: writeCall.id,
      toolName: "write",
      content: [{ type: "text", text: "Wrote notes-x.md." }],
      isError: false,
      timestamp: 2,
    },
  ];
  const request = (text: string): Message[] => [
    { role: "user", content: [{ type: "text", text }], timestamp: 3 },
  ];
  const history = (messages: Message[], previous?: string) =>
    request(
      `<conversation>\n${serializeConversation(messages)}\n</conversation>\n\n${
        previous
          ? `<previous-summary>\n${previous}\n</previous-summary>\n\n`
          : ""
      }Summarise.`,
    );

  it("summarises pi's serialized conversation and resumes from its own summary", () => {
    const summary = scriptedSummary(history(conversation));
    expect(summary).toContain("## Goal\nCollect notes into notes-x.md");
    // Resumed from the summary, the worker moves on to the command instead of rewriting.
    const turn = scriptedTurn([
      {
        role: "system",
        content: "",
        toolsAdded: [
          { name: "write", description: "", parameters: {} },
          { name: "bash", description: "", parameters: {} },
        ],
        timestamp: 0,
      } as Message,
      ...request(`Summary:\n${summary}`),
    ]);
    expect(turn).toEqual({
      calls: [{ name: "bash", args: { command: 'echo "a, b); c"' } }],
    });
  });

  it("folds an earlier summary into the next one, in order", () => {
    const earlier = scriptedSummary(history(conversation.slice(0, 1)));
    const later = scriptedSummary(history(conversation.slice(1), earlier));
    const whole = scriptedSummary(
      request(
        `# Conversation\n${serializeConversation(conversation)}\n\n# Instructions\nSummarise the prefix.`,
      ),
    );
    expect(later).toBeDefined();
    expect(later).toBe(whole);
    expect(scriptedSummary(request("Write a summary of penguins."))).toBe(
      undefined,
    );
  });
});
