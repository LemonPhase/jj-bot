// One `session.run` job: the launch guard and run start, the executor call
// (continued in the same job while results or steering keep arriving), the
// artifact snapshot and the outcome.
import { isFinishedStatus } from "@jj/contracts";
import {
  type BotRow,
  bots,
  type ClaimedJob,
  complete,
  enqueue,
  heartbeat,
  type RunReason,
  runs,
  type SessionRow,
  type TaskRow,
  type Tx,
  taskParticipants,
} from "@jj/db";
import type { SandboxSpec } from "@jj/sandbox/contract";
import { asc, count, eq } from "drizzle-orm";
import { errorMessage } from "../errors";
import { emit } from "../events";
import type { RunExecutor, RunOutcome } from "../ports";
import { profileSettings } from "../records";
import { memoryText } from "../services/bots";
import { profileFor } from "../services/profiles";
import {
  getSession,
  lockTask,
  updateSession,
  updateTask,
} from "../services/sessions";
import { settleCancellation } from "../services/tasks";
import { snapshotArtifacts } from "./artifacts";
import { sessionTools, type Teammate } from "./collab-tools";
import { claimHolder, heldByAnotherWorker } from "./holders";
import { finishRun } from "./outcomes";
import { sessionPrompt } from "./prompts";
import {
  type JobControl,
  LeaseLostError,
  loadTranscript,
  nextEntrySeq,
  type RunContext,
  runHooks,
  takeInbox,
  type WorkerDeps,
} from "./run-context";
import {
  CONTINUING_KINDS,
  closeStaleRun,
  hasContinuingInput,
  runningRun,
} from "./runs";
import { type SandboxHold, SandboxUnavailableError } from "./sandboxes";

/** Executor calls one job may make while new input keeps arriving. */
const MAX_CONTINUATIONS = 20;
/** How long a session waits before retrying when another worker holds its task's ephemeral workspace. */
const EPHEMERAL_RETRY_MS = 1_000;

type Start =
  | { kind: "skip"; taskId?: string; taskFinished: boolean }
  | {
      kind: "run";
      rc: RunContext;
      reason: RunReason;
      /** The task sandbox's spec (the coordinator's profile). */
      spec?: SandboxSpec;
      /** Why the session cannot run here; the run fails visibly with it. */
      unavailable?: string;
    };

/** The coordinator's runtime profile (else the default) decides the task sandbox. */
async function taskSandboxSpec(
  tx: Tx,
  task: TaskRow,
): Promise<SandboxSpec | undefined> {
  const [coordinator] = await tx
    .select({ profileId: bots.runtimeProfileId })
    .from(bots)
    .where(eq(bots.id, task.coordinatorBotId));
  const profile = await profileFor(tx, coordinator?.profileId ?? null);
  return profile ? profileSettings(profile).sandbox : undefined;
}

/** The start transaction: launch guard, stale-run cleanup, run row and `run.started`. */
async function startRun(
  deps: WorkerDeps,
  job: ClaimedJob,
  control: JobControl,
): Promise<Start> {
  const { ctx } = deps;
  const sessionId = job.sessionId as string;
  // Built before the transaction: reading the secrets may query the database.
  const redact = await ctx.redactor();
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

    // Only briefs, results and steering start a run. A plain message waiting
    // in the inbox rides along with a run that happens anyway; it never makes
    // a coalesced wake launch one (notification semantics).
    const hasInput = await hasContinuingInput(tx, sessionId);
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
    // An ephemeral workspace exists only in the sandbox that created it. If an
    // earlier run of the task had one and this worker does not hold it, hand
    // the session back while the holder's lease is live, or fail truthfully.
    const spec = await taskSandboxSpec(tx, task);
    let unavailable: string | undefined;
    if (!spec)
      unavailable =
        "There is no runtime profile for this task: the coordinator has none and no default profile exists.";
    else if (
      spec.workspace === "ephemeral" &&
      (prior?.value ?? 0) > 0 &&
      !deps.sandboxes.holds(task.id)
    ) {
      if (await heldByAnotherWorker(tx, task.id, ctx.config.workerId)) {
        await complete(tx, job.lease);
        await enqueue(tx, {
          kind: "session.run",
          taskId: task.id,
          sessionId,
          payload: job.payload,
          runAfter: new Date(Date.now() + EPHEMERAL_RETRY_MS),
        });
        return { kind: "skip", taskFinished: false };
      }
      unavailable = deps.sandboxes.wasDiscarded(task.id)
        ? "The task's ephemeral workspace was discarded when its sandbox was released (the task finished or stopped, it sat idle past the ephemeral time limit, or the worker needed room), so this session cannot continue its work."
        : "The task's ephemeral workspace is not on this worker: a worker restart discarded it, or the worker that held it stopped. Ephemeral workspaces cannot move between workers.";
    }
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
        snapshotPending: true,
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
      redact,
    };
    return { kind: "run", rc, reason, spec, unavailable };
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
        ...(rc.session.parentSessionId === null
          ? {}
          : { brief: rc.session.brief }),
        canDelegate: tools.some((tool) => tool.name === "delegate"),
        resumed: rc.reason === "recovery",
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
      redact: (text: string) => rc.redact(text),
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
      if (start.unavailable || !start.spec)
        throw new SandboxUnavailableError(
          start.unavailable ?? "The task has no sandbox spec.",
        );
      hold = await sandboxes.acquire(
        rc.task.id,
        rc.session.id,
        start.spec,
        rc.control.controller.signal,
      );
      if (start.spec.workspace === "ephemeral")
        await claimHolder(ctx, rc.task.id);
      call = await prepare(rc, executor, hold);
    } catch (error) {
      if (error instanceof LeaseLostError) return;
      // Nothing ran, so there is nothing to snapshot.
      await finishRun(
        rc,
        { kind: "error", error: errorMessage(error) },
        false,
        true,
      );
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
        outcome = await call(inputs);
        while (outcome.kind === "ended" && calls < MAX_CONTINUATIONS) {
          rc.claimed.clear();
          inputs = await takeInbox(rc, CONTINUING_KINDS);
          if (inputs.length === 0) break;
          calls += 1;
          outcome = await call(inputs);
        }
      } catch (error) {
        if (error instanceof LeaseLostError) return;
        outcome = rc.control.reason
          ? { kind: "aborted", reason: "signal" }
          : { kind: "error", error: errorMessage(error) };
      }
      // A stop hands the run back with its snapshot pending (a crash cannot
      // snapshot): the session's next snapshot, or the task's final one,
      // covers it.
      let snapshotted = false;
      if (!rc.control.fenced && rc.control.reason !== "shutdown")
        snapshotted = await snapshotArtifacts(rc, hold).then(
          () => true,
          (error: unknown) => {
            if (error instanceof LeaseLostError) throw error;
            ctx.logger.warn(
              `Snapshotting artifacts of run ${rc.run.id} failed`,
              { error: errorMessage(error) },
            );
            return false;
          },
        );
      const next = await finishRun(
        rc,
        outcome,
        calls < MAX_CONTINUATIONS,
        snapshotted,
      );
      if (next !== "continue") return;
    }
  } catch (error) {
    if (!(error instanceof LeaseLostError)) throw error;
  } finally {
    hold?.done();
    if (rc.taskFinished) sandboxes.finish(rc.task.id);
  }
}
