// Scenarios for the harness. Each drives the engine through its public API and
// waits for the task to settle. Goals follow scripts/smoke-e2e.ts so the
// scripted model can play them; real models get the same text.
import type { Engine } from "@jj/backend";

export interface ScenarioContext {
  engine: Engine;
  model: string;
}
export interface Scenario {
  run(context: ScenarioContext): Promise<unknown>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function settle(engine: Engine, taskId: string, timeoutMs = 15 * 60_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const view = await engine.tasks.get(taskId);
    const busy = view.sessions.some((s) =>
      ["queued", "running"].includes(s.status),
    );
    if (
      !busy &&
      ["completed", "failed", "cancelled", "waiting"].includes(view.task.status)
    )
      return view;
    if (Date.now() > end) throw new Error(`task ${taskId} did not settle`);
    await sleep(250);
  }
}

async function settleChat(
  engine: Engine,
  botId: string,
  timeoutMs = 5 * 60_000,
) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const view = await engine.bots.conversation(botId);
    if (!view.replying && view.messages.at(-1)?.role === "assistant")
      return view;
    if (view.lastReplyError && !view.replying) return view;
    if (Date.now() > end) throw new Error("chat did not settle");
    await sleep(250);
  }
}

async function team(
  engine: Engine,
  model: string,
  names = ["Ada", "Grace", "Linus"],
) {
  const ids: Record<string, string> = {};
  for (const name of names) {
    const { bot } = await engine.bots.create({ name, model } as never);
    ids[name] = bot.id;
  }
  return ids;
}

const PENGUINS =
  "Write two short notes about penguins. Delegate one part to Grace and one part to Linus at the same time; each writes their notes to a markdown file in the workspace. Then complete the task with a one-paragraph summary.";

const summary = (view: Awaited<ReturnType<typeof settle>>) => ({
  status: view.task.status,
  result: view.task.result,
  sessions: view.sessions.length,
  messages: view.messages.length,
});

export const scenarios: Record<string, Scenario> = {
  /** The smoke's task: a coordinator and two parallel workers. */
  baseline: {
    async run({ engine, model }) {
      const bots = await team(engine, model);
      const { task } = await engine.tasks.create({
        goal: PENGUINS,
        title: "Penguin notes",
        coordinatorBotId: bots.Ada,
        participantBotIds: [bots.Grace, bots.Linus],
      } as never);
      return summary(await settle(engine, task.id));
    },
  },
  /**
   * Baseline, then the user follows up twice on the finished task. Measures
   * how the coordinator's transcript (and cost per call) grows across
   * continuations, and whether follow-up delegations start cold.
   */
  followups: {
    async run({ engine, model }) {
      const bots = await team(engine, model);
      const { task } = await engine.tasks.create({
        goal: PENGUINS,
        title: "Penguin notes",
        coordinatorBotId: bots.Ada,
        participantBotIds: [bots.Grace, bots.Linus],
      } as never);
      const rounds = [summary(await settle(engine, task.id))];
      for (const text of [
        "Thanks. Ask Grace to add a third fact to her notes file, keeping the existing facts.",
        "Now ask Linus to add a one-line source for each of his facts, keeping the existing text.",
      ]) {
        await engine.tasks.postMessage(task.id, { text } as never);
        await sleep(300);
        rounds.push(summary(await settle(engine, task.id)));
      }
      return rounds;
    },
  },
  /**
   * Direct chat: ask for work, let the task finish, then ask how it went.
   * Shows the known gap: a finished task drops out of the chat prompt.
   */
  chat: {
    async run({ engine, model }) {
      const bots = await team(engine, model);
      await engine.bots.sendMessage(bots.Ada, {
        text: `Please start a task with Grace and Linus: ${PENGUINS}`,
      } as never);
      const first = await settleChat(engine, bots.Ada);
      const taskId = first.messages.at(-1)?.taskId;
      const view = taskId ? await settle(engine, taskId) : undefined;
      await engine.bots.sendMessage(bots.Ada, {
        text: "How did the penguin task go? What did Grace write?",
      } as never);
      const second = await settleChat(engine, bots.Ada);
      return {
        task: view ? summary(view) : null,
        replies: second.messages
          .filter((m) => m.role === "assistant")
          .map((m) => m.text.slice(0, 400)),
      };
    },
  },
};
