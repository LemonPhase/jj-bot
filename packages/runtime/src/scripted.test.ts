import { Type } from "@earendil-works/pi-ai";
import { CODING_TOOLS } from "@jj/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PiSessionExecutor } from "./executor";
import { ModelRegistry } from "./models";
import { formatRoster, type RosterEntry } from "./prompt";
import { SCRIPTED_MODEL_REF, scriptedNotesFile } from "./scripted";
import { budgets, localSandbox, recordingHooks } from "./test-support";
import type { CollabTool, ExecutorEvent, PiMessage, RunOutcome } from "./types";

let workspace: Awaited<ReturnType<typeof localSandbox>>;
beforeEach(async () => {
  workspace = await localSandbox();
});
afterEach(async () => {
  await workspace.cleanup();
});

const team: RosterEntry[] = [
  { name: "Ada", role: "coordinator" },
  { name: "Bob", role: "researcher" },
  { name: "Cy", role: "writer" },
];
const promptFor = (name: string) =>
  `You are ${name}.\n\n${formatRoster(team.map((entry) => ({ ...entry, self: entry.name === name })))}`;

/** A minimal stand-in for the engine: one transcript per session, stubbed collaboration tools. */
function harness() {
  const executor = new PiSessionExecutor({
    models: new ModelRegistry({ env: {}, enableScripted: true }),
  });
  const transcripts = new Map<string, PiMessage[]>();
  const events: ExecutorEvent[] = [];
  const delegations: { bot: string; brief: string }[] = [];
  const completions: string[] = [];

  const coordinatorTools: CollabTool[] = [
    {
      name: "delegate",
      description: "Give a participant a bounded piece of the work.",
      parameters: Type.Object({ bot: Type.String(), brief: Type.String() }),
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
      expect(note).toContain(`# ${bot}`);
    }

    // The coordinator reacts to the first result before the second arrives.
    expect(
      await run("Ada", [`Bob finished: ${reports.Bob}`], coordinatorTools),
    ).toEqual({
      kind: "ended",
      finalText: "Received the result from Bob. Still waiting for Cy.",
    });
    expect(completions).toEqual([]);

    const last = await run(
      "Ada",
      [`Cy finished: ${reports.Cy}`],
      coordinatorTools,
    );
    expect(last).toEqual({ kind: "ended", finalText: "All results are in." });
    expect(completions).toHaveLength(1);
    expect(completions[0]).toContain(goal);
    expect(completions[0]).toContain("- Bob: Bob finished");
    expect(completions[0]).toContain("- Cy: Cy finished");

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
      systemPrompt: formatRoster([
        { name: "Solo", role: "coordinator", self: true },
      ]),
      transcript: [],
      inputs: ["Tidy the workspace."],
      model: SCRIPTED_MODEL_REF,
      sandbox: workspace.sandbox,
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
    expect(completions[0]).toContain("I wrote notes-solo.md");
    expect(await workspace.sandbox.fs.stat("notes-solo.md")).toBeDefined();
  });
});
