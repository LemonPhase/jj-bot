// One `session.run` job: the launch guard and run start, the executor call
// (continued in the same job while results or steering keep arriving), the
// artifact snapshot and the outcome.
import { isFinishedStatus } from "@jj/contracts";
import {
  type BotRow,
  bots,
  type ClaimedJob,
  complete,
  heartbeat,
  type RunReason,
  runs,
  type SessionRow,
  sessionInbox,
  sessions,
  type TaskRow,
  taskParticipants,
  tasks,
} from "@jj/db";
import { and, asc, count, eq, isNull } from "drizzle-orm";
import { errorMessage } from "../errors";
import { emit } from "../events";
import { profileSettings } from "../records";
import {
  changedFiles,
  hasArtifact,
  sha256,
  storeArtifact,
} from "../services/artifacts";
import { memoryText } from "../services/bots";
import { profileFor } from "../services/profiles";
import {
  getSession,
  lockTask,
  updateSession,
  updateTask,
} from "../services/sessions";
import { settleCancellation } from "../services/tasks";
import type { RunExecutor, RunOutcome } from "../ports";
import { sessionTools, type Teammate } from "./collab-tools";
import { finishRun } from "./outcomes";
import { sessionPrompt } from "./prompts";
import {
  attributionOf,
  type JobControl,
  LeaseLostError,
  loadTranscript,
  nextEntrySeq,
  type RunContext,
  runHooks,
  takeInbox,
  type WorkerDeps,
  writeRun,
} from "./run-context";
import { closeStaleRun, runningRun } from "./runs";
import { SandboxUnavailableError, type SandboxHold } from "./sandboxes";

/** Executor calls one job may make while new input keeps arriving. */
const MAX_CONTINUATIONS = 20;
/** Clock skew allowed between the worker and the sandbox when finding changed files. */
const SNAPSHOT_SKEW_MS = 2_000;

type Start =
  | { kind: "skip"; taskId?: string; taskFinished: boolean }
  | {
      kind: "run";
      rc: RunContext;
      reason: RunReason;
      priorRuns: number;
    };

/** The start transaction: launch guard, stale-run cleanup, run row and `run.started`. */
async function startRun(
  deps: WorkerDeps,
  job: ClaimedJob,
  control: JobControl,
): Promise<Start> {
  const { ctx } = deps;
  const sessionId = job.sessionId as string;
  return ctx.db.transaction(async (tx): Promise<Start> => {
    if (!(await heartbeat(tx, job.lease, ctx.config.leaseMs)))
      return { kind: "skip", taskFinished: false };
    const peek = await getSession(tx, sessionId);
    if (!peek) {
      await complete(tx, job.lease);
      return { kind: "skip", taskFinished: false };
    }
    const task = (await lockTask(tx, peek.taskId)) as TaskRow;
    let session = (await getSession(tx, sessionId)) as SessionRow;
    const parent = session.parentSessionId
      ? await getSession(tx, session.parentSessionId)
      : undefined;
    const stale = await runningRun(tx, sessionId);

    // Launch guard: nothing starts once a stop is requested or the work is moot.
    if (
      task.cancelRequestedAt ||
      isFinishedStatus(task.status) ||
      isFinishedStatus(session.status) ||
      (parent && isFinishedStatus(parent.status))
    ) {
      if (stale)
        await closeStaleRun(
          tx,
          ctx,
          session,
          stale,
          "cancelled",
          "Interrupted: the worker stopped and the task was stopped meanwhile.",
        );
      if (!task.cancelRequestedAt && !isFinishedStatus(session.status))
        await updateSession(tx, ctx, session, { status: "cancelled" });
      await complete(tx, job.lease);
      const settled = await settleCancellation(tx, ctx, task);
      return {
        kind: "skip",
        taskId: task.id,
        taskFinished: settled !== undefined || isFinishedStatus(task.status),
      };
    }

    const [pending] = await tx
      .select({ value: count() })
      .from(sessionInbox)
      .where(
        and(
          eq(sessionInbox.sessionId, sessionId),
          isNull(sessionInbox.deliveredAt),
        ),
      );
    const hasInput = (pending?.value ?? 0) > 0;
    const recovering =
      stale !== undefined ||
      session.status === "running" ||
      job.attempts > 1 ||
      job.payload.reason === "recovery" ||
      (session.status === "queued" && session.runCount > 0 && !hasInput);
    const reason: RunReason = recovering
      ? "recovery"
      : session.runCount === 0
        ? "start"
        : "wake";
    if (reason === "wake" && !hasInput) {
      // A coalesced wake whose input an earlier run already took.
      await complete(tx, job.lease);
      return { kind: "skip", taskFinished: false };
    }
    if (stale)
      await closeStaleRun(
        tx,
        ctx,
        session,
        stale,
        "failed",
        "Interrupted by a worker restart; the session resumes from its last completed turn.",
      );
    const [prior] = await tx
      .select({ value: count() })
      .from(runs)
      .where(eq(runs.taskId, task.id));
    const now = ctx.clock();
    const [run] = await tx
      .insert(runs)
      .values({
        id: ctx.ids("run"),
        sessionId,
        taskId: task.id,
        number: session.runCount + 1,
        reason,
        status: "running",
        startedAt: now,
      })
      .returning();
    if (!run) throw new Error("The run insert returned no row.");
    const attribution = { botId: session.botId, sessionId, runId: run.id };
    const previous = { status: session.status, waitingFor: session.waitingFor };
    session = await updateSession(
      tx,
      ctx,
      session,
      {
        status: "running",
        runCount: session.runCount + 1,
        startedAt: session.startedAt ?? now,
      },
      attribution,
    );
    await emit(tx, task.id, {
      type: "run.started",
      payload: { reason },
      ...attribution,
    });
    let current = task;
    if (task.status === "queued" || task.status === "waiting")
      current = await updateTask(
        tx,
        ctx,
        task,
        { status: "running" },
        attribution,
      );
    const [bot] = await tx
      .select()
      .from(bots)
      .where(eq(bots.id, session.botId));
    const rc: RunContext = {
      deps,
      job,
      control,
      task: current,
      session,
      bot: bot as BotRow,
      run,
      reason,
      previous,
      claimed: new Set(),
      nextSeq: await nextEntrySeq(tx, sessionId),
      startedAt: now,
      taskFinished: false,
    };
    return { kind: "run", rc, reason, priorRuns: prior?.value ?? 0 };
  });
}

async function teammates(rc: RunContext): Promise<Teammate[]> {
  const rows = await rc.deps.ctx.db
    .select({ id: bots.id, name: bots.name, role: bots.role })
    .from(taskParticipants)
    .innerJoin(bots, eq(bots.id, taskParticipants.botId))
    .where(eq(taskParticipants.taskId, rc.task.id))
    .orderBy(asc(bots.name));
  return rows.map((row) => ({
    botId: row.id,
    name: row.name,
    role: row.role,
    self: row.id === rc.bot.id,
  }));
}

/** Records files the run changed as `file` artifacts (deduplicated by path and content). */
async function snapshotArtifacts(rc: RunContext, hold: SandboxHold) {
  const { ctx } = rc.deps;
  const since = new Date(rc.startedAt.getTime() - SNAPSHOT_SKEW_MS);
  const files = await changedFiles(hold.sandbox, since, ctx.config.artifacts);
  if (files.length === 0) return;
  await writeRun(rc, async (tx) => {
    for (const file of files) {
      if (await hasArtifact(tx, rc.task.id, file.path, sha256(file.content)))
        continue;
      await storeArtifact(
        tx,
        ctx,
        {
          taskId: rc.task.id,
          kind: "file",
          path: file.path,
          name: file.path.split("/").pop() || file.path,
          content: file.content,
        },
        attributionOf(rc),
      );
    }
  });
}

/** Drops a recorded completion request: new input arrived after it. */
async function clearCompletion(rc: RunContext) {
  if (!rc.session.completionRequested) return;
  await writeRun(rc, (tx) =>
    tx
      .update(sessions)
      .set({ completionRequested: null })
      .where(eq(sessions.id, rc.session.id)),
  );
  rc.session = { ...rc.session, completionRequested: null };
}

/** Input kinds that continue a run that is ending; plain messages wait for the next activation. */
export const CONTINUING_KINDS = ["brief", "result", "steering"] as const;

/** Builds the executor call for this run: prompt, tools, budgets and hooks. */
async function prepare(
  rc: RunContext,
  executor: RunExecutor,
  hold: SandboxHold,
) {
  const { ctx } = rc.deps;
  const [memory, team, own] = await Promise.all([
    memoryText(ctx.db, rc.bot.id),
    teammates(rc),
    profileFor(ctx.db, rc.bot.runtimeProfileId),
  ]);
  const ownSettings = own ? profileSettings(own) : undefined;
  const parent = rc.session.parentSessionId
    ? await getSession(ctx.db, rc.session.parentSessionId)
    : undefined;
  const requester = parent
    ? team.find((member) => member.botId === parent.botId)?.name
    : undefined;
  const tools = sessionTools(
    rc,
    team.filter((member) => !member.self),
  );
  const deadline = new Date(
    rc.startedAt.getTime() +
      (ownSettings?.budgets.maxRunMinutes ?? 30) * 60_000,
  );
  return async (inputs: string[]): Promise<RunOutcome> => {
    const outcome = await executor.run({
      sessionId: rc.session.id,
      runId: rc.run.id,
      systemPrompt: sessionPrompt({
        bot: rc.bot,
        memory: memory?.text ?? "",
        role: rc.session.parentSessionId === null ? "coordinator" : "worker",
        goal: rc.task.goal,
        goalVersion: rc.session.goalVersion,
        roster: team,
        workspaceDir: hold.sandbox.workspaceDir,
        requester,
        canDelegate: tools.some((tool) => tool.name === "delegate"),
      }),
      transcript: await loadTranscript(ctx, rc.session.id),
      inputs,
      model: rc.bot.model,
      sandbox: hold.sandbox,
      sandboxLimits: hold.spec.limits,
      codingTools: ownSettings?.tools ?? [],
      collaborationTools: tools,
      budgets: {
        maxTurns: ownSettings?.budgets.maxTurnsPerRun ?? 60,
        deadline,
      },
      signal: rc.control.controller.signal,
      hooks: runHooks(rc),
    });
    return rc.control.reason ? { kind: "aborted", reason: "signal" } : outcome;
  };
}

/** Runs one claimed `session.run` job to its outcome. */
export async function runSessionJob(
  deps: WorkerDeps,
  executor: RunExecutor,
  job: ClaimedJob,
  control: JobControl,
): Promise<void> {
  const { ctx, sandboxes } = deps;
  const start = await startRun(deps, job, control);
  if (start.kind === "skip") {
    if (start.taskFinished && start.taskId) sandboxes.finish(start.taskId);
    return;
  }
  const { rc } = start;
  let hold: SandboxHold | undefined;
  try {
    let call: ((inputs: string[]) => Promise<RunOutcome>) | undefined;
    try {
      const coordinator = await ctx.db
        .select({ profileId: bots.runtimeProfileId })
        .from(tasks)
        .innerJoin(bots, eq(bots.id, tasks.coordinatorBotId))
        .where(eq(tasks.id, rc.task.id));
      const profile = await profileFor(
        ctx.db,
        coordinator[0]?.profileId ?? null,
      );
      if (!profile)
        throw new SandboxUnavailableError(
          "There is no runtime profile for this task: the coordinator has none and no default profile exists.",
        );
      const spec = profileSettings(profile).sandbox;
      if (
        spec.workspace === "ephemeral" &&
        start.priorRuns > 0 &&
        !sandboxes.holds(rc.task.id)
      )
        throw new SandboxUnavailableError(
          "The task's ephemeral workspace did not survive a worker restart, so this session cannot resume.",
        );
      hold = await sandboxes.acquire(rc.task.id, rc.session.id, spec);
      call = await prepare(rc, executor, hold);
    } catch (error) {
      if (error instanceof LeaseLostError) return;
      await finishRun(rc, { kind: "error", error: errorMessage(error) }, false);
      return;
    }
    // Each executor call takes the inbox; input that arrives as a call ends
    // continues the run, even when it lands just before the write-back.
    for (let calls = 1; ; calls += 1) {
      let outcome: RunOutcome;
      let inputs: string[] = [];
      try {
        rc.claimed.clear();
        inputs = await takeInbox(
          rc,
          calls === 1 ? undefined : CONTINUING_KINDS,
        );
        if (calls > 1) await clearCompletion(rc);
        outcome = await call(inputs);
        while (outcome.kind === "ended" && calls < MAX_CONTINUATIONS) {
          rc.claimed.clear();
          inputs = await takeInbox(rc, CONTINUING_KINDS);
          if (inputs.length === 0) break;
          await clearCompletion(rc);
          calls += 1;
          outcome = await call(inputs);
        }
      } catch (error) {
        if (error instanceof LeaseLostError) return;
        outcome = rc.control.reason
          ? { kind: "aborted", reason: "signal" }
          : { kind: "error", error: errorMessage(error) };
      }
      if (!rc.control.fenced && rc.control.reason !== "shutdown")
        await snapshotArtifacts(rc, hold).catch((error: unknown) => {
          if (error instanceof LeaseLostError) throw error;
          ctx.logger.warn(`Snapshotting artifacts of run ${rc.run.id} failed`, {
            error: errorMessage(error),
          });
        });
      const next = await finishRun(rc, outcome, calls < MAX_CONTINUATIONS);
      if (next !== "continue") return;
    }
  } catch (error) {
    if (!(error instanceof LeaseLostError)) throw error;
  } finally {
    hold?.done();
    if (rc.taskFinished) sandboxes.finish(rc.task.id);
  }
}
