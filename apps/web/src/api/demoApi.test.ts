import { describe, expect, it } from "vitest";
import { createDemoApi } from "./demoApi";

describe("demo API placeholder", () => {
  it("never fabricates a bot reply to a direct message", async () => {
    const api = createDemoApi();
    const thread = await api.sendDirectMessage("bot-kite", "Hello");
    const added = thread.slice(-2);
    expect(added.map((m) => m.role)).toEqual(["user", "system"]);
    expect(
      thread.some((m) => m.role === "assistant" && m.text === "Hello"),
    ).toBe(false);
  });

  it("creates queued tasks with the first participant as coordinator", async () => {
    const api = createDemoApi();
    const task = await api.createTask({
      goal: "Ship the workspace UI",
      participantBotIds: ["bot-moss", "bot-vesper"],
      verificationCriterion: "Browser check passes",
    });
    expect(task.coordinatorBotId).toBe("bot-moss");
    expect(task.status).toBe("queued");
    expect(task.sessions.every((s) => s.status === "queued")).toBe(true);
    expect(task.checks[0]?.outcome).toBe("inconclusive");
    expect((await api.listTasks())[0]?.id).toBe(task.id);
  });

  it("steering bumps the goal version and marks checks stale", async () => {
    const api = createDemoApi();
    const task = await api.postTaskMessage("task-101", {
      text: "Keep the schema",
      steering: true,
      observedGoalVersion: 2,
    });
    expect(task.goalVersion).toBe(3);
    expect(task.checks.every((c) => c.outcome === "inconclusive")).toBe(true);
  });

  it("stopping cancels unfinished sessions and notifies subscribers", async () => {
    const api = createDemoApi();
    const seen: string[] = [];
    const unsubscribe = api.subscribeToTask("task-101", (t) =>
      seen.push(t.status),
    );
    const task = await api.stopTask("task-101");
    unsubscribe();
    expect(task.status).toBe("cancelled");
    expect(task.sessions.map((s) => s.status)).toEqual([
      "completed",
      "cancelled",
      "cancelled",
    ]);
    expect(seen).toEqual(["cancelled"]);
  });

  it("returns copies so callers cannot mutate stored state", async () => {
    const api = createDemoApi();
    const [bot] = await api.listBots();
    if (bot) bot.name = "Mutated";
    expect((await api.listBots())[0]?.name).toBe("Juno");
  });
});
