// Approvals end to end on the pi runtime: a held call never runs before the
// user approves it, runs exactly once after (across a restart, never again
// after a claim), a denial reaches the model with its reason, and expiry,
// cancellation and queued messages behave as agreed in #87.
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolApproval as Approval, TaskView } from "@jj/contracts";
import { approvals, chatTaskUpdates, jobs, tasks as tasksTable } from "@jj/db";
import {
  INTERRUPTED_BY_RESTART,
  ModelRegistry,
  PiSessionExecutor,
} from "@jj/runtime";
import {
  callTool,
  conversation,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  say,
  textOf,
} from "@jj/runtime/testing";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DomainError } from "./errors";
import { REDACTED } from "./redact";
import { createKeyring } from "./secrets/keyring";
import { SecretStore } from "./secrets/store";
import { isOvertaken } from "./services/task-updates";
import {
  OPEN_TIMEOUT,
  openTestDatabase,
  sleep,
  type TestDatabase,
  type TestEngine,
  testEngine,
  uniqueName,
  until,
  untilTask,
} from "./testing/harness";
import { createTeam } from "./testing/scenarios";
import { ONE_APPROVAL_AT_A_TIME } from "./worker/approvals";

let db: TestDatabase;
const engines: TestEngine[] = [];
const roots: string[] = [];

beforeAll(async () => {
  db = await openTestDatabase();
}, OPEN_TIMEOUT);
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.dispose();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
afterAll(async () => {
  await db?.close();
});

/** Each run of it appends a line, so the line count is how often it ran. */
const PUSH = "echo ran >> pushed.txt; wc -l < pushed.txt # git push";

type Step = Parameters<
  ReturnType<typeof fauxProvider>["setResponses"]
>[0][number];

/** An engine on the pi runtime with a faux model answering `steps`, sharing one workspace root. */
async function start(
  root: string,
  steps: Step[],
  options: {
    start?: boolean;
    scripted?: boolean;
    secretStore?: SecretStore;
  } = {},
) {
  const faux = fauxProvider();
  faux.setResponses(steps);
  const models = options.scripted
    ? new ModelRegistry({ env: {}, enableScripted: true })
    : new ModelRegistry({ env: {}, extraProviders: [faux.provider] });
  const engine = await testEngine(db.database, {
    runExecutor: new PiSessionExecutor({ models }),
    workspaceRoot: root,
    start: options.start,
    ...(options.secretStore ? { secretStore: options.secretStore } : {}),
  });
  engines.push(engine);
  return engine;
}

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "jj-approvals-"));
  roots.push(root);
  return root;
}

/** A bot on a profile that asks before `git push`. */
async function guardedBot(engine: TestEngine["engine"], base = "Ada") {
  const { profile } = await engine.profiles.create({
    name: uniqueName("Guarded"),
    sandbox: { driver: "local", network: { mode: "open" } },
    approvals: [{ tool: "bash", match: "git push" }],
  });
  const { bot } = await engine.bots.create({
    name: uniqueName(base),
    runtimeProfileId: profile.id,
  });
  return bot;
}

const pending = (view: TaskView) =>
  view.approvals.find((approval) => approval.status === "pending") as
    | Approval
    | undefined;

/** Starts a task whose coordinator's first call is held; returns once it waits. */
async function heldTask(engine: TestEngine["engine"], goal = "Push the work") {
  const bot = await guardedBot(engine);
  const { task } = await engine.tasks.create({
    goal,
    coordinatorBotId: bot.id,
  });
  const view = await untilTask(
    engine,
    task.id,
    (v) =>
      pending(v) !== undefined &&
      v.task.status === "waiting" &&
      v.sessions[0]?.waitingFor === "approval",
    "the held call",
  );
  return { bot, task, view, approval: pending(view) as Approval };
}

async function pushes(root: string, taskId: string) {
  try {
    const text = await readFile(
      join(root, "task", taskId, "pushed.txt"),
      "utf8",
    );
    return text.split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

/** The result the model received for one call. */
const resultText = (
  context: Parameters<Extract<Step, (...args: never[]) => unknown>>[0],
  toolCallId: string,
) =>
  textOf(
    conversation(context).find(
      (message) =>
        message.role === "toolResult" && message.toolCallId === toolCallId,
    ),
  );

describe("approvals", () => {
  it("never runs a held call before approval, then runs it exactly once", async () => {
    const root = await workspace();
    let seen = "";
    const { engine } = await start(root, [
      fauxAssistantMessage(
        fauxToolCall("bash", { command: PUSH }, { id: "push" }),
        {
          stopReason: "toolUse",
        },
      ),
      (context) => {
        seen = resultText(context, "push");
        return callTool("complete_task", { result: "Pushed." });
      },
    ]);
    const { task, view, approval } = await heldTask(engine);

    // Recorded and shown, never run.
    expect(approval).toMatchObject({
      tool: "bash",
      summary: PUSH,
      args: { command: PUSH },
      rule: { tool: "bash", match: "git push" },
      goalVersion: 1,
      startedAt: null,
    });
    expect(await pushes(root, task.id)).toBe(0);
    expect(
      view.events.filter(
        (event) =>
          (event.type === "tool.started" || event.type === "tool.finished") &&
          event.payload.toolCallId === "push",
      ),
    ).toEqual([]);
    const { tasks } = await engine.tasks.list();
    expect(tasks.find((t) => t.id === task.id)?.pendingApprovals).toEqual([
      expect.objectContaining({ id: approval.id, summary: PUSH }),
    ]);
    // The session holds no run while it waits.
    await sleep(200);
    expect(await pushes(root, task.id)).toBe(0);

    const { approval: approved } = await engine.tasks.decideApproval(
      task.id,
      approval.id,
      { decision: "approve" },
    );
    expect(approved.status).toBe("approved");
    const done = await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "completed",
    );
    expect(await pushes(root, task.id)).toBe(1);
    expect(seen).toBe("1");
    expect(done.approvals[0]).toMatchObject({
      status: "approved",
      outcome: { ok: true, exitCode: 0, interrupted: "no" },
    });
    expect(
      (done.approvals[0] as Approval | undefined)?.startedAt,
    ).not.toBeNull();
    expect(
      done.events.filter(
        (event) =>
          event.type === "tool.finished" && event.payload.toolCallId === "push",
      ),
    ).toHaveLength(1);

    // Answered once: a second answer is refused.
    await expect(
      engine.tasks.decideApproval(task.id, approval.id, { decision: "deny" }),
    ).rejects.toMatchObject({ code: "APPROVAL_NOT_PENDING" });
  });

  it("survives a restart while pending and still runs the call once", async () => {
    const root = await workspace();
    const first = await start(root, [callTool("bash", { command: PUSH })]);
    const { task, approval } = await heldTask(first.engine);
    await first.dispose();
    engines.splice(engines.indexOf(first), 1);

    let seen = "";
    const second = await start(root, [
      (context) => {
        seen = resultText(context, approval.toolCallId);
        return callTool("complete_task", { result: "Pushed after a restart." });
      },
    ]);
    // The new worker does not run the held session on its own.
    await sleep(200);
    expect(
      (await second.engine.tasks.get(task.id)).sessions[0]?.waitingFor,
    ).toBe("approval");
    await second.engine.tasks.decideApproval(task.id, approval.id, {
      decision: "approve",
    });
    await untilTask(
      second.engine,
      task.id,
      (v) => v.task.status === "completed",
    );
    expect(await pushes(root, task.id)).toBe(1);
    expect(seen).toBe("1");
  });

  it("never re-runs an approved call that an earlier run claimed", async () => {
    const root = await workspace();
    const first = await start(root, [callTool("bash", { command: PUSH })]);
    const { task, approval } = await heldTask(first.engine);
    await first.dispose();
    engines.splice(engines.indexOf(first), 1);

    let seen = "";
    const second = await start(
      root,
      [
        (context) => {
          seen = resultText(context, approval.toolCallId);
          return say("I will check whether it ran.");
        },
      ],
      { start: false },
    );
    await second.engine.tasks.decideApproval(task.id, approval.id, {
      decision: "approve",
    });
    // As if a run claimed it and died before its result was stored.
    await db.database.db
      .update(approvals)
      .set({ startedAt: new Date(), startedRunId: "run_lost" })
      .where(eq(approvals.id, approval.id));
    await second.engine.worker.start();
    const view = await untilTask(
      second.engine,
      task.id,
      (v) =>
        v.task.status === "waiting" && v.sessions[0]?.waitingFor === "user",
    );
    expect(seen).toBe(INTERRUPTED_BY_RESTART);
    expect(await pushes(root, task.id)).toBe(0);
    expect((view.approvals[0] as Approval | undefined)?.outcome).toEqual({
      ok: false,
      interrupted: "unknown",
    });
  });

  /** A call approved and claimed by a run that died before its result was stored. */
  async function startedThenLost(root: string) {
    const first = await start(root, [callTool("bash", { command: PUSH })]);
    const { task, approval } = await heldTask(first.engine);
    await first.dispose();
    engines.splice(engines.indexOf(first), 1);
    const second = await start(root, [], { start: false });
    await second.engine.tasks.decideApproval(task.id, approval.id, {
      decision: "approve",
    });
    await db.database.db
      .update(approvals)
      .set({ startedAt: new Date(), startedRunId: "run_lost" })
      .where(eq(approvals.id, approval.id));
    return { engine: second, task, approval };
  }

  it("gives a started call an unknown outcome when the task is stopped before it reported", async () => {
    const root = await workspace();
    const { engine, task, approval } = await startedThenLost(root);
    await engine.engine.tasks.stop(task.id);
    const view = await engine.engine.tasks.get(task.id);
    expect(view.approvals.find((a) => a.id === approval.id)).toMatchObject({
      status: "approved",
      outcome: { ok: false, interrupted: "unknown" },
    });
  });

  it("gives a started call an unknown outcome when its session is given up", async () => {
    const root = await workspace();
    const { engine, task, approval } = await startedThenLost(root);
    // Its last allowed attempt expired: the next claim gives the session up.
    await db.database.db
      .update(jobs)
      .set({
        status: "running",
        leaseOwner: "worker_gone",
        attempts: sql`${jobs.maxAttempts}`,
        leaseUntil: sql`now() - interval '1 second'`,
      })
      .where(and(eq(jobs.taskId, task.id), inArray(jobs.status, ["queued"])));
    await engine.engine.worker.start();
    const view = await untilTask(
      engine.engine,
      task.id,
      (v) => v.task.status === "failed",
    );
    expect(view.approvals.find((a) => a.id === approval.id)).toMatchObject({
      status: "approved",
      outcome: { ok: false, interrupted: "unknown" },
    });
    expect(await pushes(root, task.id)).toBe(0);
  });

  it("leaves a started call alone when the goal changes: it may have run", async () => {
    const root = await workspace();
    const { engine, task, approval } = await startedThenLost(root);
    await engine.engine.tasks.postMessage(task.id, {
      text: "Tag it instead.",
      goal: "Tag the release",
      observedGoalVersion: 1,
    });
    const view = await engine.engine.tasks.get(task.id);
    const row = view.approvals.find((a) => a.id === approval.id);
    expect(row?.status).toBe("approved");
    expect((row as Approval | undefined)?.startedAt).not.toBeNull();
  });

  it("leaves an approval answered before it started alone on a goal change or a stop", async () => {
    const root = await workspace();
    const first = await start(root, [callTool("bash", { command: PUSH })]);
    const { task, approval } = await heldTask(first.engine);
    await first.dispose();
    engines.splice(engines.indexOf(first), 1);
    const second = await start(root, [], { start: false });
    await second.engine.tasks.decideApproval(task.id, approval.id, {
      decision: "approve",
    });
    // As a run leaves a call refused before it started (a cut-off response).
    const refused = { ok: false, refused: "Not run: cut off." };
    await db.database.db
      .update(approvals)
      .set({ outcome: refused, resolvedAt: new Date() })
      .where(eq(approvals.id, approval.id));
    await second.engine.tasks.postMessage(task.id, {
      text: "Tag it instead.",
      goal: "Tag the release",
      observedGoalVersion: 1,
    });
    await second.engine.tasks.stop(task.id);
    const view = await second.engine.tasks.get(task.id);
    expect(view.approvals.find((a) => a.id === approval.id)).toMatchObject({
      status: "approved",
      outcome: refused,
      startedAt: null,
    });
  });

  it("returns a denial to the model as a tool error carrying the reason", async () => {
    const root = await workspace();
    let seen = "";
    const { engine } = await start(root, [
      callTool("bash", { command: PUSH }),
      (context) => {
        const result = conversation(context).find(
          (message) => message.role === "toolResult",
        );
        seen =
          result?.role === "toolResult" && result.isError ? textOf(result) : "";
        return say("Understood, I will not push.");
      },
    ]);
    const { task, approval } = await heldTask(engine);
    const { approval: denied } = await engine.tasks.decideApproval(
      task.id,
      approval.id,
      { decision: "deny", reason: "push to a branch instead" },
    );
    expect(denied).toMatchObject({
      status: "denied",
      reason: "push to a branch instead",
    });
    const view = await untilTask(
      engine,
      task.id,
      (v) =>
        v.task.status === "waiting" && v.sessions[0]?.waitingFor === "user",
    );
    expect(seen).toBe(
      "Not run: the user denied this call. Their reason: push to a branch instead",
    );
    expect(await pushes(root, task.id)).toBe(0);
    expect((view.approvals[0] as Approval | undefined)?.outcome).toBeNull();
  });

  it("redacts a stored secret's value from the approval, its events and the chat update", async () => {
    const root = await workspace();
    const token = "ghp_storedTokenValue0123456789abcdefXYZ";
    const command = `git push https://bot:${token}@example.com/repo.git main`;
    const secretStore = new SecretStore({
      db: db.database.db,
      keyring: createKeyring(randomBytes(32)),
    });
    const { engine } = await start(
      root,
      [
        fauxAssistantMessage(
          [
            fauxText(`Pushing with ${token}.`),
            fauxToolCall("bash", { command }, { id: "push" }),
          ],
          { stopReason: "toolUse" },
        ),
      ],
      { secretStore },
    );
    await engine.secrets.put("GITHUB_TOKEN", { value: token });
    const { task, view, approval } = await heldTask(engine);
    expect(approval.args).toEqual({
      command: command.replace(token, REDACTED),
    });
    expect(approval.summary).not.toContain(token);
    expect(approval.text).toBe(`Pushing with ${REDACTED}.`);
    expect(JSON.stringify(view)).not.toContain(token);
    const page = await engine.tasks.events(task.id);
    expect(JSON.stringify(page.events)).not.toContain(token);
    const [update] = await db.database.db
      .select()
      .from(chatTaskUpdates)
      .where(eq(chatTaskUpdates.approvalId, approval.id));
    expect(update?.text).toContain(REDACTED);
    expect(update?.text).not.toContain(token);
  });

  it("redacts a secret stored after the call was held from the task list", async () => {
    const root = await workspace();
    const token = "ghp_laterStoredToken0123456789abcdefXYZ";
    const command = `git push https://bot:${token}@example.com/repo.git`;
    const secretStore = new SecretStore({
      db: db.database.db,
      keyring: createKeyring(randomBytes(32)),
    });
    const { engine } = await start(root, [callTool("bash", { command })], {
      secretStore,
    });
    const { task } = await heldTask(engine);
    await engine.secrets.put("LATER_TOKEN", { value: token });
    const { tasks } = await engine.tasks.list();
    const [listed] =
      tasks.find((t) => t.id === task.id)?.pendingApprovals ?? [];
    expect(listed?.summary).toBe(command.replace(token, REDACTED));
    // What chat shows is no longer what runs: approve it in the task.
    expect(listed?.shownInFull).toBe(false);
  });

  it("writes hidden characters out in the chat update", async () => {
    const root = await workspace();
    const command = "echo ok \u202E# hsup tig # git push";
    const { engine } = await start(root, [callTool("bash", { command })]);
    const { approval } = await heldTask(engine);
    const [update] = await db.database.db
      .select()
      .from(chatTaskUpdates)
      .where(eq(chatTaskUpdates.approvalId, approval.id));
    expect(update?.text).toContain("echo ok ⟨U+202E⟩# hsup tig # git push");
    expect(update?.text).not.toContain("\u202E");
  });

  it("answers concurrent decisions once", async () => {
    const root = await workspace();
    const { engine } = await start(root, [
      callTool("bash", { command: PUSH }),
      say("Done."),
    ]);
    const { task, approval } = await heldTask(engine);
    const answers = await Promise.allSettled([
      engine.tasks.decideApproval(task.id, approval.id, {
        decision: "approve",
      }),
      engine.tasks.decideApproval(task.id, approval.id, { decision: "deny" }),
    ]);
    expect(answers.filter((a) => a.status === "fulfilled")).toHaveLength(1);
    const refused = answers.find((a) => a.status === "rejected");
    expect(refused?.status === "rejected" && refused.reason).toBeInstanceOf(
      DomainError,
    );
    expect(
      refused?.status === "rejected" && (refused.reason as DomainError).code,
    ).toBe("APPROVAL_NOT_PENDING");
  });

  it("holds one call per session and refuses a second one in the batch", async () => {
    const root = await workspace();
    let second = "";
    const { engine } = await start(root, [
      fauxAssistantMessage(
        [
          fauxToolCall("bash", { command: PUSH }, { id: "a" }),
          fauxToolCall("bash", { command: "git push --tags" }, { id: "b" }),
        ],
        { stopReason: "toolUse" },
      ),
      (context) => {
        second = resultText(context, "b");
        return callTool("complete_task", { result: "Pushed once." });
      },
    ]);
    const { task, view, approval } = await heldTask(engine);
    expect(view.approvals).toHaveLength(1);
    expect(approval.toolCallId).toBe("a");
    await engine.tasks.decideApproval(task.id, approval.id, {
      decision: "approve",
    });
    await untilTask(engine, task.id, (v) => v.task.status === "completed");
    expect(second).toBe(ONE_APPROVAL_AT_A_TIME);
    expect(await pushes(root, task.id)).toBe(1);
  });

  it("queues a message to a coordinator holding a call, which reads it with the answer", async () => {
    const root = await workspace();
    let last = "";
    const { engine } = await start(root, [
      callTool("bash", { command: PUSH }),
      (context) => {
        last = textOf(conversation(context).at(-1));
        return callTool("complete_task", { result: "Pushed." });
      },
    ]);
    const { task } = await heldTask(engine);
    const before = await engine.tasks.get(task.id);
    await engine.tasks.postMessage(task.id, { text: "Any news?" });
    await sleep(250);
    const after = await engine.tasks.get(task.id);
    // Neither reopened nor run, nor answered by the message.
    expect(after.task.status).toBe("waiting");
    expect(after.sessions[0]).toMatchObject({
      waitingFor: "approval",
      runCount: before.sessions[0]?.runCount,
    });
    expect(after.events.some((event) => event.type === "task.reopened")).toBe(
      false,
    );
    expect(
      after.events.find((event) => event.type === "steering.received")?.payload,
    ).toMatchObject({ delivered: "queued" });
    expect(pending(after)).toBeDefined();

    const approval = pending(after) as Approval;
    await engine.tasks.decideApproval(task.id, approval.id, {
      decision: "approve",
    });
    await untilTask(engine, task.id, (v) => v.task.status === "completed");
    expect(last).toBe("Message from the user:\nAny news?");
    expect(await pushes(root, task.id)).toBe(1);
  });

  it("keeps the verification gate shut while a call waits, then checks the work once it ran", async () => {
    const root = await workspace();
    let resumed = "";
    const { engine } = await start(root, [
      // The push and the completion in one batch: the completion waits too.
      fauxAssistantMessage(
        [
          fauxToolCall("bash", { command: PUSH }, { id: "push" }),
          fauxToolCall(
            "complete_task",
            { result: "Pushed." },
            { id: "done-early" },
          ),
        ],
        { stopReason: "toolUse" },
      ),
      (context) => {
        resumed = textOf(conversation(context).at(-1));
        return callTool("complete_task", { result: "Pushed after approval." });
      },
      say("Done."),
    ]);
    const bot = await guardedBot(engine);
    const { task } = await engine.tasks.create({
      goal: "Push the work",
      coordinatorBotId: bot.id,
      verificationPlan: [
        {
          id: "pushed",
          description: "pushed.txt exists",
          method: "file",
          path: "pushed.txt",
          expect: "exists",
        },
      ],
    });
    const held = await untilTask(
      engine,
      task.id,
      (v) => pending(v) !== undefined && v.task.status === "waiting",
      "the held call",
    );
    await sleep(200);
    const still = await engine.tasks.get(task.id);
    // No check ran and nothing completed while the call waits.
    expect(
      still.events.some((event) => event.type === "verification.started"),
    ).toBe(false);
    expect(still.task.status).toBe("waiting");
    await engine.tasks.decideApproval(task.id, (pending(held) as Approval).id, {
      decision: "approve",
    });
    const done = await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "completed",
    );
    // The early completion was set aside: the model completed again after the call ran.
    expect(resumed).toContain("Your `complete_task` call was set aside");
    expect(done.task.result).toBe("Pushed after approval.");
    expect(done.verificationChecks).toMatchObject([
      { criterionId: "pushed", outcome: "passed" },
    ]);
    expect(await pushes(root, task.id)).toBe(1);
  });

  it("records an approved call its tool no longer allows as refused, never run", async () => {
    const root = await workspace();
    let seen = "";
    const { engine } = await start(root, [
      callTool("bash", { command: PUSH }),
      (context) => {
        const result = conversation(context).find(
          (message) => message.role === "toolResult",
        );
        seen = textOf(result);
        return say("bash is gone, so I stop here.");
      },
    ]);
    const { bot, task, approval } = await heldTask(engine);
    // The profile no longer grants bash when the user approves.
    await engine.profiles.update(bot.runtimeProfileId as string, {
      tools: ["read"],
    });
    await engine.tasks.decideApproval(task.id, approval.id, {
      decision: "approve",
    });
    const view = await untilTask(
      engine,
      task.id,
      (v) =>
        v.task.status === "waiting" && v.sessions[0]?.waitingFor === "user",
    );
    expect(seen).toContain("not found");
    expect(await pushes(root, task.id)).toBe(0);
    expect(view.approvals[0]).toMatchObject({
      status: "approved",
      outcome: { ok: false, refused: expect.stringContaining("not found") },
    });
  });

  it("expires a pending approval when the goal changes", async () => {
    const root = await workspace();
    let seen = "";
    const { engine } = await start(root, [
      callTool("bash", { command: PUSH }),
      (context) => {
        const result = conversation(context).find(
          (message) => message.role === "toolResult",
        );
        seen = textOf(result);
        return say("Working on the new goal.");
      },
    ]);
    const { task, approval } = await heldTask(engine);
    await engine.tasks.postMessage(task.id, {
      text: "Do not push; tag it.",
      goal: "Tag the release",
      observedGoalVersion: 1,
    });
    const view = await untilTask(
      engine,
      task.id,
      (v) =>
        v.task.status === "waiting" && v.sessions[0]?.waitingFor === "user",
    );
    expect(view.approvals[0]).toMatchObject({
      id: approval.id,
      status: "expired",
    });
    expect(seen).toBe(
      "Not run: the task's goal or plan changed (now goal version 2) before the user answered.",
    );
    expect(await pushes(root, task.id)).toBe(0);
    await expect(
      engine.tasks.decideApproval(task.id, approval.id, {
        decision: "approve",
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_NOT_PENDING" });
  });

  it("never holds a call made while the goal changed under the run", async () => {
    const root = await workspace();
    let taskId = "";
    let seen = "";
    const current = await start(root, [
      // The user changes the goal while the model is making the call.
      async () => {
        await current.engine.tasks.postMessage(taskId, {
          text: "Tag it instead.",
          goal: "Tag the release",
          observedGoalVersion: 1,
        });
        return callTool("bash", { command: PUSH });
      },
      (context) => {
        const result = conversation(context).find(
          (message) => message.role === "toolResult",
        );
        seen = textOf(result);
        return say("On the new goal now.");
      },
    ]);
    const { engine } = current;
    const bot = await guardedBot(engine);
    const { task } = await engine.tasks.create({
      goal: "Push the work",
      coordinatorBotId: bot.id,
    });
    taskId = task.id;
    const view = await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "waiting" && v.approvals.length > 0,
    );
    expect(view.task.goalVersion).toBe(2);
    expect(view.approvals[0]).toMatchObject({
      status: "expired",
      goalVersion: 1,
    });
    expect(
      view.events.some(
        (event) =>
          event.type === "approval.updated" ||
          (event.type === "approval.requested" &&
            event.payload.approval.status === "pending"),
      ),
    ).toBe(false);
    expect(seen).toBe(
      "Not run: the task's goal or plan changed (now goal version 2) before the call was made.",
    );
    expect(await pushes(root, task.id)).toBe(0);
    await expect(
      engine.tasks.decideApproval(task.id, view.approvals[0]?.id as string, {
        decision: "approve",
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_NOT_PENDING" });
  });

  it("lets a delegated worker's call made after a goal change wait for approval", async () => {
    const root = await workspace();
    let workerName = "";
    const seen: string[] = [];
    // One faux model for both bots: the worker starts on its assignment.
    const step: Step = (context) => {
      const messages = conversation(context);
      if (textOf(messages[0]).startsWith("Assignment from")) {
        const results = messages.filter((m) => m.role === "toolResult");
        if (results.length > 0) seen.push(textOf(results.at(-1)));
        // It pushes until a push has run (its output is the line count).
        if (results.some((m) => textOf(m) === "1")) return say("Pushed.");
        if (results.length >= 4) return say("Gave up.");
        return callTool("bash", { command: PUSH });
      }
      const delegated = messages.some(
        (m) => m.role === "toolResult" && m.toolName === "delegate",
      );
      return delegated
        ? say("Waiting.")
        : callTool("delegate", { bot: workerName, brief: "Push the work." });
    };
    const { engine } = await start(
      root,
      Array.from({ length: 40 }, () => step),
    );
    const lead = await createTeam(engine, ["Lead"]);
    const worker = await guardedBot(engine, "Rex");
    workerName = worker.name;
    const { task } = await engine.tasks.create({
      goal: "Push the work",
      coordinatorBotId: lead.ids[0] as string,
      participantBotIds: [worker.id],
    });
    const first = await untilTask(
      engine,
      task.id,
      (v) => pending(v) !== undefined,
      "the worker's held call",
    );
    // The user changes the goal while the worker's call waits: it expires,
    // and the worker, woken, calls again after seeing the new goal.
    await engine.tasks.postMessage(task.id, {
      text: "Push to the release branch instead.",
      goal: "Push the work to release",
      observedGoalVersion: 1,
    });
    const retried = await untilTask(
      engine,
      task.id,
      (v) =>
        v.approvals.some(
          (a) => a.id !== pending(first)?.id && a.status === "pending",
        ) || seen.length >= 4,
      "the worker's retried call",
    );
    expect(retried.task.goalVersion).toBe(2);
    expect(retried.approvals[0]).toMatchObject({ status: "expired" });
    const again = pending(retried);
    expect(again).toMatchObject({ botId: worker.id, goalVersion: 2 });
    await engine.tasks.decideApproval(task.id, (again as Approval).id, {
      decision: "approve",
    });
    await untilTask(engine, task.id, () => seen.includes("1"), "the push");
    expect(await pushes(root, task.id)).toBe(1);
  });

  it("expires a call approved for the old goal before it ran", async () => {
    const root = await workspace();
    const first = await start(root, [callTool("bash", { command: PUSH })]);
    const { task, approval } = await heldTask(first.engine);
    await first.dispose();
    engines.splice(engines.indexOf(first), 1);
    let seen = "";
    const second = await start(
      root,
      [
        (context) => {
          seen = resultText(context, approval.toolCallId);
          return say("On the new goal now.");
        },
      ],
      { start: false },
    );
    await second.engine.tasks.decideApproval(task.id, approval.id, {
      decision: "approve",
    });
    // The goal changes before any run started the approved call.
    await second.engine.tasks.postMessage(task.id, {
      text: "Tag it instead.",
      goal: "Tag the release",
      observedGoalVersion: 1,
    });
    await second.engine.worker.start();
    const view = await untilTask(
      second.engine,
      task.id,
      (v) =>
        v.task.status === "waiting" && v.sessions[0]?.waitingFor === "user",
    );
    expect(view.approvals[0]).toMatchObject({
      status: "expired",
      startedAt: null,
    });
    expect(seen).toBe(
      "Not run: the task's goal or plan changed (now goal version 2) before it ran.",
    );
    expect(await pushes(root, task.id)).toBe(0);
  });

  it("takes no answer while the task is stopping", async () => {
    const root = await workspace();
    const { engine } = await start(root, [callTool("bash", { command: PUSH })]);
    const { task, approval } = await heldTask(engine);
    // A stop in progress: requested, and not settled yet.
    await db.database.db
      .update(tasksTable)
      .set({ cancelRequestedAt: new Date() })
      .where(eq(tasksTable.id, task.id));
    await expect(
      engine.tasks.decideApproval(task.id, approval.id, {
        decision: "approve",
      }),
    ).rejects.toMatchObject({ code: "TASK_TERMINAL" });
    const view = await engine.tasks.get(task.id);
    expect(view.approvals[0]?.status).toBe("pending");
    expect(await pushes(root, task.id)).toBe(0);
  });

  it("cancels a pending approval when the task is stopped", async () => {
    const root = await workspace();
    const { engine } = await start(root, [callTool("bash", { command: PUSH })]);
    const { task, approval } = await heldTask(engine);
    await engine.tasks.stop(task.id);
    const view = await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "cancelled",
    );
    expect(view.approvals[0]).toMatchObject({
      id: approval.id,
      status: "cancelled",
      reason: "the task was stopped before it ran.",
    });
    expect(await pushes(root, task.id)).toBe(0);
    const { tasks } = await engine.tasks.list();
    expect(tasks.find((t) => t.id === task.id)?.pendingApprovals).toEqual([]);
  });

  it("tells the coordinator's chat, which cannot answer it", async () => {
    const root = await workspace();
    const current = await start(root, [
      callTool("bash", { command: PUSH }),
      callTool("complete_task", { result: "Pushed." }),
    ]);
    const { engine, chat } = current;
    const bot = await guardedBot(engine);
    chat.brain(bot.name, () => ({
      text: "I need your approval to push; use the buttons on the card.",
    }));
    const { task } = await engine.tasks.create({
      goal: "Push the work",
      coordinatorBotId: bot.id,
    });
    const view = await untilTask(
      engine,
      task.id,
      (v) => pending(v) !== undefined,
    );
    const approval = pending(view) as Approval;
    const [update] = await db.database.db
      .select()
      .from(chatTaskUpdates)
      .where(eq(chatTaskUpdates.approvalId, approval.id));
    expect(update).toMatchObject({ event: "approval", taskId: task.id });
    expect(update?.text).toContain(`wants to run bash: ${PUSH}`);
    expect(update?.text).toContain("bash calls matching `git push`");
    // The reply is told what waits, and that only the user answers it.
    const told = await until(() =>
      chat.inputs.find((input) =>
        input.history.at(-1)?.text.includes("[Task update]"),
      ),
    );
    const input = told.history.at(-1)?.text ?? "";
    expect(input).toContain("has a call waiting for the user's approval");
    expect(input).toContain("Only the user can answer it");
    expect(told.tools.map((tool) => tool.name)).not.toContain("send_to_task");
    const reply = await until(async () =>
      (await engine.bots.conversation(bot.id)).messages.find(
        (message) => message.taskId === task.id,
      ),
    );
    expect(reply.text).toContain("use the buttons on the card");
  });

  it("drops an approval update that was answered before it was told", () => {
    const base = {
      id: "upd_1",
      ownerId: "local",
      botId: "bot_1",
      taskId: "task_1",
      event: "approval" as const,
      taskEventSeq: 3,
      text: "Ada wants to run bash: git push",
      createdAt: new Date(),
      messageId: null,
      answeredAt: null,
      approvalId: "appr_1",
      approvalKind: "tool" as const,
      title: "Push",
      status: "waiting" as const,
      cancelRequestedAt: null,
    };
    expect(isOvertaken({ ...base, approvalStatus: "pending" })).toBe(false);
    for (const approvalStatus of [
      "approved",
      "denied",
      "expired",
      "cancelled",
    ] as const)
      expect(isOvertaken({ ...base, approvalStatus })).toBe(true);
  });

  it("lets a worker wait for approval while the task waits for the user", async () => {
    const root = await workspace();
    const { engine } = await start(root, [], { scripted: true });
    const coordinator = await createTeam(engine, ["Lead"]);
    const worker = await guardedBot(engine, "Rex");
    const { task } = await engine.tasks.create({
      goal: `Ship it: run \`${PUSH}\``,
      coordinatorBotId: coordinator.ids[0] as string,
      participantBotIds: [worker.id],
    });
    const view = await untilTask(
      engine,
      task.id,
      (v) => pending(v) !== undefined && v.task.status === "waiting",
      "the worker's held call",
    );
    const held = pending(view) as Approval;
    expect(held.botId).toBe(worker.id);
    expect(
      view.sessions.map((session) => [session.role, session.waitingFor]),
    ).toEqual([
      ["coordinator", "delegations"],
      ["worker", "approval"],
    ]);
    expect(await pushes(root, task.id)).toBe(0);
    await engine.tasks.decideApproval(task.id, held.id, {
      decision: "approve",
    });
    await untilTask(engine, task.id, (v) => v.task.status === "completed");
    expect(await pushes(root, task.id)).toBe(1);
  });
});
