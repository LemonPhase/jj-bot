// Scenarios for the harness. Each drives the engine through its public API and
// waits for the task to settle. Goals follow scripts/smoke-e2e.ts so the
// scripted model can play them; real models get the same text.
import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Engine } from "@jj/backend";

export interface ScenarioContext {
  engine: Engine;
  model: string;
  /** The local sandbox driver's root: task workspaces live below it. */
  root: string;
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

/** Finds a file by name anywhere under the sandbox root. */
async function find(root: string, name: string): Promise<string | undefined> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory() && entry.name !== "node_modules") {
      const hit = await find(path, name);
      if (hit) return hit;
    }
  }
  return undefined;
}
const read = async (root: string, name: string) => {
  const path = await find(root, name);
  return path ? readFile(path, "utf8") : undefined;
};
const entries = (text = "") =>
  text.split("\n").filter((line) => /^\s*[-*]\s+\*\*[^*]+\*\*/.test(line));
const termOf = (line: string) =>
  (/\*\*([^*]+)\*\*/.exec(line)?.[1] ?? "").trim().toLowerCase();

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10 * 60_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return true;
    await sleep(200);
  }
  return false;
}

const GLOSSARY =
  "Build a two-part penguin glossary in the workspace. First delegate part 1 to Grace: glossary-a.md with exactly 3 penguin terms. Only after Grace has reported, delegate part 2 to Linus: glossary-b.md with exactly 3 other penguin terms that must not repeat any of Grace's terms. Every entry is one line in the form `- **Term**: definition`. Then complete the task with a short summary.";
const TAG = "[kiwi-7]";

const INTERFACE = (variant: string) =>
  `Two pieces, delegated to Grace and Linus at the same time (both delegate calls in the same turn). Grace writes lib.ts, which exports one function that formats a penguin record (name, species, heightCm) as one line of text. Linus writes main.ts, which imports that function from './lib.ts' and prints the formatted line for one sample penguin. The check is that \`node --experimental-strip-types main.ts\` runs in the workspace and prints the line. ${
    variant === "hub"
      ? "Choose the function's name and exact signature yourself and put them in both briefs."
      : variant === "notes"
        ? "Do not choose the function's name or signature yourself and do not put them in the briefs: Grace and Linus agree between themselves through a NOTES.md file in the workspace. Whoever decides something writes it there, and each reads NOTES.md before deciding and again before finishing."
        : "Do not choose the function's name or signature yourself and do not put them in the briefs: Grace and Linus agree between themselves using the message tool."
  } Do not edit lib.ts or main.ts yourself; if they do not fit together, delegate a fix. Then complete the task.`;

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
  /**
   * E1: a rule the user gives after Grace has started, and a fact (Grace's
   * terms) that Linus needs. Checks that the rule reached both workers'
   * files and that Linus avoided Grace's terms.
   */
  glossary: {
    async run({ engine, model, root }) {
      const bots = await team(engine, model);
      const { task } = await engine.tasks.create({
        goal: GLOSSARY,
        title: "Penguin glossary",
        coordinatorBotId: bots.Ada,
        participantBotIds: [bots.Grace, bots.Linus],
      } as never);
      // The rule arrives once Grace's session exists, so the coordinator
      // can no longer put it in her brief.
      await waitFor(async () => (await engine.tasks.get(task.id)).sessions.length > 1);
      await engine.tasks.postMessage(task.id, {
        text: `New rule for every glossary entry, including any already being written: end each definition line with the tag ${TAG}.`,
      } as never);
      await sleep(500);
      const view = await settle(engine, task.id);
      const a = entries(await read(root, "glossary-a.md"));
      const b = entries(await read(root, "glossary-b.md"));
      const tagged = (lines: string[]) =>
        lines.length > 0 && lines.every((line) => line.trimEnd().endsWith(TAG));
      const overlap = a.map(termOf).filter((t) => b.map(termOf).includes(t));
      const checks = {
        aCount: a.length === 3,
        bCount: b.length === 3,
        aTagged: tagged(a),
        bTagged: tagged(b),
        noOverlap: a.length > 0 && b.length > 0 && overlap.length === 0,
      };
      return {
        ...summary(view),
        checks,
        pass: Object.values(checks).every(Boolean),
        workers: view.sessions.filter((s) => s.parentSessionId).length,
      };
    },
  },
  /**
   * E2: Grace picks a codeword that only her report carries. A follow-up asks
   * her (by re-delegation) to add a term and the codeword to her file.
   */
  redelegate: {
    async run({ engine, model, root }) {
      const bots = await team(engine, model);
      const { task } = await engine.tasks.create({
        goal: "Delegate to Grace: write glossary-a.md with exactly 3 penguin terms, one line each in the form `- **Term**: definition`. Also ask her to invent a random codeword of 6 to 10 letters and to state it in her report only (it is not secret; it just should not be written to a file yet). Then complete the task with a short summary that does not mention the codeword.",
        title: "Glossary with follow-up",
        coordinatorBotId: bots.Ada,
        participantBotIds: [bots.Grace, bots.Linus],
      } as never);
      const first = await settle(engine, task.id);
      const graceFirst = first.sessions.find((s) => s.botId === bots.Grace);
      const report = graceFirst?.result ?? "";
      const startedRound2 = Date.now();
      await engine.tasks.postMessage(task.id, {
        text: "Follow-up: delegate to Grace again. She adds one more penguin term to glossary-a.md, keeping her existing three, and appends a last line `Codeword: <the codeword she chose earlier>`.",
      } as never);
      await sleep(500);
      const view = await settle(engine, task.id);
      const text = (await read(root, "glossary-a.md")) ?? "";
      // The codeword line's words (6+ letters, not "codeword") must appear in
      // Grace's first report.
      const line = text.split("\n").filter((l) => /codeword/i.test(l)).at(-1) ?? "";
      const words = (line.match(/[A-Za-z]{6,}/g) ?? []).filter((w) => w.toLowerCase() !== "codeword");
      const checks = {
        fourEntries: entries(text).length === 4,
        codewordMatches: words.some((w) => report.toLowerCase().includes(w.toLowerCase())),
      };
      return {
        ...summary(view),
        checks,
        pass: Object.values(checks).every(Boolean),
        round2StartedAt: startedRound2,
        file: text.slice(0, 1200),
        firstReport: report.slice(0, 1200),
        graceSessions: view.sessions.filter((s) => s.botId === bots.Grace).length,
      };
    },
  },
  /** E3: two workers must agree on an interface. */
  interface: {
    async run({ engine, model, root }) {
      const variant = process.env.JJ_EXP_VARIANT ?? "message";
      const bots = await team(engine, model);
      const { task } = await engine.tasks.create({
        goal: INTERFACE(variant),
        title: "Penguin formatter",
        coordinatorBotId: bots.Ada,
        participantBotIds: [bots.Grace, bots.Linus],
      } as never);
      const view = await settle(engine, task.id);
      const main = await find(root, "main.ts");
      let runs = false;
      let output = "";
      if (main) {
        const result = spawnSync(
          process.execPath,
          ["--experimental-strip-types", "--no-warnings", "main.ts"],
          { cwd: dirname(main), encoding: "utf8", timeout: 20_000 },
        );
        runs = result.status === 0 && result.stdout.trim().length > 0;
        output = (result.stdout + result.stderr).slice(0, 300);
      }
      const workerSessions = view.sessions.filter((s) => s.parentSessionId).length;
      return {
        ...summary(view),
        variant,
        checks: { runs },
        pass: runs && view.task.status === "completed",
        output,
        workerSessions,
        fixDelegations: Math.max(0, workerSessions - 2),
        botMessages: view.messages.filter((m) => m.intent === "discussion" && m.authorKind === "bot").length,
        notesFile: Boolean(await find(root, "NOTES.md")),
      };
    },
  },
};
