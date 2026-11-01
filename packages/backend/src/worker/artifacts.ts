// Artifact snapshots: files changed in the task workspace become `file`
// artifacts, deduplicated by path and content across the task. Every run
// starts with `snapshot_pending` set, and a snapshot that records its files
// clears it. A run's snapshot covers it and its session's earlier pending runs
// (handed back by a graceful stop, or cut off by a crash), from the earliest
// one's start. When the task finishes, a final snapshot from its sandbox
// covers whatever is still pending (sessions that never ran again). A file is
// credited to the run whose write or edit tool last touched it, among the
// covered runs and the task's other finished runs still pending; anything else
// the scan finds (bash output files, a teammate's bash writes) is stored at
// task level, with no session or run, because the shared workspace cannot say
// who wrote it. A file a teammate's running write or edit call touched, or is
// still touching, is left to that run's snapshot when that scan will reach it
// (it changed since that run started, less the skew); otherwise it is stored
// now, so a call that fails or has not written yet cannot lose it.
import { isAbsolute, posix, relative } from "node:path";
import { runs, type Tx, taskEvents, tasks } from "@jj/db";
import type { Sandbox } from "@jj/sandbox/contract";
import { and, asc, eq, gt, inArray, ne, or, sql } from "drizzle-orm";
import type { EngineContext } from "../context";
import type { Attribution } from "../events";
import {
  type ChangedFile,
  changedFiles,
  hasArtifact,
  sha256,
  storeArtifact,
} from "../services/artifacts";
import { lockTask } from "../services/sessions";
import { type RunContext, writeRun } from "./run-context";
import type { SandboxHold } from "./sandboxes";

/**
 * Clock skew allowed between the sandbox and the workers whose run starts
 * bound the scan (a run may have started on another worker).
 */
const SNAPSHOT_SKEW_MS = 2_000;
const FILE_TOOLS = ["write", "edit"];
const TASK_LEVEL: Attribution = { botId: null, sessionId: null, runId: null };

/** A transaction runner: lease-fenced for a run, worker-fenced for a final snapshot. */
export type Write = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

interface PendingRun {
  id: string;
  startedAt: Date;
}

/** A tool's path argument as a workspace-relative POSIX path, or undefined outside the workspace. */
export function workspaceRelative(
  workspaceDir: string,
  path: string,
): string | undefined {
  const trimmed = path.trim();
  if (!trimmed) return undefined;
  const local = isAbsolute(trimmed) ? relative(workspaceDir, trimmed) : trimmed;
  const normal = posix.normalize(local.split("\\").join("/"));
  if (normal === "." || normal.startsWith("../") || normal === "..")
    return undefined;
  return normal.replace(/^\.\//, "");
}

/**
 * Paths written or edited by successful tool calls of these runs, each with
 * the attribution of the call that touched it last.
 */
async function toolPaths(
  tx: Tx,
  taskId: string,
  runIds: string[],
  workspaceDir: string,
): Promise<Map<string, Attribution>> {
  const paths = new Map<string, Attribution>();
  if (runIds.length === 0) return paths;
  const rows = await tx
    .select({
      botId: taskEvents.botId,
      sessionId: taskEvents.sessionId,
      runId: taskEvents.runId,
      payload: taskEvents.payload,
    })
    .from(taskEvents)
    .where(
      and(
        eq(taskEvents.taskId, taskId),
        eq(taskEvents.type, "tool.finished"),
        inArray(taskEvents.runId, runIds),
        sql`${taskEvents.payload}->>'tool' in ('write', 'edit')`,
        sql`(${taskEvents.payload}->>'ok')::boolean`,
      ),
    )
    .orderBy(asc(taskEvents.sequence));
  for (const row of rows)
    if (FILE_TOOLS.includes(String(row.payload.tool))) {
      const path = workspaceRelative(workspaceDir, String(row.payload.summary));
      if (path)
        paths.set(path, {
          botId: row.botId,
          sessionId: row.sessionId,
          runId: row.runId,
        });
    }
  return paths;
}

/**
 * Paths that write or edit calls of these running runs touched or are
 * touching (finished successfully, or started with no result recorded yet),
 * each with the earliest start among the runs that did. A call's start is
 * recorded before its tool runs, so a file it wrote is found here even while
 * its result is still being recorded.
 */
async function activePaths(
  tx: Tx,
  taskId: string,
  running: PendingRun[],
  workspaceDir: string,
): Promise<Map<string, number>> {
  const active = new Map<string, number>();
  if (running.length === 0) return active;
  const starts = new Map(
    running.map((run) => [run.id, run.startedAt.getTime()]),
  );
  const rows = await tx
    .select({
      type: taskEvents.type,
      runId: taskEvents.runId,
      payload: taskEvents.payload,
    })
    .from(taskEvents)
    .where(
      and(
        eq(taskEvents.taskId, taskId),
        inArray(taskEvents.type, ["tool.started", "tool.finished"]),
        inArray(taskEvents.runId, [...starts.keys()]),
        sql`${taskEvents.payload}->>'tool' in ('write', 'edit')`,
      ),
    )
    .orderBy(asc(taskEvents.sequence));
  // By run and call id: a provider may number calls per conversation, so two
  // teammates' calls can share an id.
  const calls = new Map<
    string,
    { start: number; path?: string; failed: boolean }
  >();
  for (const row of rows) {
    const start = row.runId ? starts.get(row.runId) : undefined;
    if (start === undefined || !FILE_TOOLS.includes(String(row.payload.tool)))
      continue;
    calls.set(`${row.runId}:${String(row.payload.toolCallId)}`, {
      start,
      path: workspaceRelative(workspaceDir, String(row.payload.summary)),
      failed: row.type === "tool.finished" && row.payload.ok !== true,
    });
  }
  for (const call of calls.values())
    if (call.path && !call.failed)
      active.set(
        call.path,
        Math.min(call.start, active.get(call.path) ?? call.start),
      );
  return active;
}

/** Whether a write or edit call started on the task after event `seen`. */
async function fileCallStartedSince(
  tx: Tx,
  taskId: string,
  seen: number,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: taskEvents.id })
    .from(taskEvents)
    .where(
      and(
        eq(taskEvents.taskId, taskId),
        gt(taskEvents.sequence, seen),
        eq(taskEvents.type, "tool.started"),
        sql`${taskEvents.payload}->>'tool' in ('write', 'edit')`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

interface Credits {
  /** The task's event sequence these reflect; events commit in sequence order. */
  seen: number;
  credit: Map<string, Attribution>;
  /** Paths left to running teammates, with the earliest start of one that touched it. */
  active: Map<string, number>;
}

/**
 * Who gets each path: the last toucher among the covered runs and the task's
 * finished runs still pending a snapshot; and the paths of runs still
 * running elsewhere (other than `self`), which credit them when they end.
 */
async function credits(
  tx: Tx,
  taskId: string,
  covered: string[],
  self: string | undefined,
  workspaceDir: string,
): Promise<Credits> {
  // First, so an event that lands during this look counts as after it.
  const [task] = await tx
    .select({ sequence: tasks.eventSeq })
    .from(tasks)
    .where(eq(tasks.id, taskId));
  const open = await tx
    .select({ id: runs.id, status: runs.status, startedAt: runs.startedAt })
    .from(runs)
    .where(
      and(
        eq(runs.taskId, taskId),
        or(eq(runs.status, "running"), eq(runs.snapshotPending, true)),
      ),
    );
  const pending = open.filter((run) => run.status !== "running");
  const running = open.filter(
    (run) => run.status === "running" && run.id !== self,
  );
  return {
    seen: task?.sequence ?? 0,
    credit: await toolPaths(
      tx,
      taskId,
      [...new Set([...covered, ...pending.map((run) => run.id)])],
      workspaceDir,
    ),
    active: await activePaths(tx, taskId, running, workspaceDir),
  };
}

/**
 * Whether a running teammate's own snapshot will store the file: one of its
 * write or edit calls touched it, and it changed no earlier than that run's
 * scan reaches back (its start less the skew, at the latest). An older file
 * that the call failed to write, or has not written yet, is stored now.
 */
function leftToTeammate(who: Credits, file: ChangedFile): boolean {
  const start = who.active.get(file.path);
  return start !== undefined && file.modifiedAt >= start - SNAPSHOT_SKEW_MS;
}

/**
 * Stores the files changed since the earliest covered run started, one
 * transaction each, until `maxFilesPerRun` new artifacts (files already
 * stored or left to a running teammate do not count).
 */
async function recordChanges(
  ctx: EngineContext,
  write: Write,
  taskId: string,
  sandbox: Sandbox,
  covered: PendingRun[],
  self?: string,
): Promise<void> {
  const from = Math.min(...covered.map((run) => run.startedAt.getTime()));
  const since = new Date(from - SNAPSHOT_SKEW_MS);
  const look = (tx: Tx) =>
    credits(
      tx,
      taskId,
      covered.map((run) => run.id),
      self,
      sandbox.workspaceDir,
    );
  let who: Credits | undefined;
  let stored = 0;
  for await (const file of changedFiles(sandbox, since, ctx.config.artifacts)) {
    // Looked up once the first file has been read.
    const known = who ?? (await write(look));
    who = known;
    const digest = sha256(file.content);
    const added = await write(async (tx) => {
      // The task lock first: two snapshots of one file cannot both store it,
      // and no event can land while this decides.
      await lockTask(tx, taskId);
      if (await hasArtifact(tx, taskId, file.path, digest)) return false;
      let current = known;
      // Read after `known` was looked up, a file no one is credited with may
      // come from a write or edit call that started since: look again.
      if (
        !current.credit.has(file.path) &&
        !leftToTeammate(current, file) &&
        (await fileCallStartedSince(tx, taskId, current.seen))
      ) {
        current = await look(tx);
        who = current;
      }
      const credit = current.credit.get(file.path);
      // A running teammate's own snapshot stores and credits it.
      if (!credit && leftToTeammate(current, file)) return false;
      await storeArtifact(
        tx,
        ctx,
        {
          taskId,
          kind: "file",
          path: file.path,
          name: file.path.split("/").pop() || file.path,
          content: file.content,
        },
        credit ?? TASK_LEVEL,
      );
      return true;
    });
    if (added && ++stored >= ctx.config.artifacts.maxFilesPerRun) return;
  }
}

/**
 * A run's snapshot: covers the run and its session's earlier runs still
 * pending, whose flags it clears (`finishRun` clears the run's own).
 */
export async function snapshotArtifacts(rc: RunContext, hold: SandboxHold) {
  const write: Write = (fn) => writeRun(rc, fn);
  const earlier = await write((tx) =>
    tx
      .select({ id: runs.id, startedAt: runs.startedAt })
      .from(runs)
      .where(
        and(
          eq(runs.sessionId, rc.session.id),
          eq(runs.snapshotPending, true),
          ne(runs.id, rc.run.id),
        ),
      ),
  );
  await recordChanges(
    rc.deps.ctx,
    write,
    rc.task.id,
    hold.sandbox,
    [...earlier, { id: rc.run.id, startedAt: rc.startedAt }],
    rc.run.id,
  );
  if (earlier.length > 0) await write((tx) => clearPending(tx, earlier));
}

/**
 * The task finished: records, from the sandbox about to be released, the
 * files of its finished runs still pending (sessions handed back or cut off
 * that never ran again), and clears their flags.
 */
export async function snapshotFinishedTask(
  ctx: EngineContext,
  write: Write,
  taskId: string,
  sandbox: Sandbox,
): Promise<void> {
  const pending = await write((tx) =>
    tx
      .select({ id: runs.id, startedAt: runs.startedAt })
      .from(runs)
      .where(
        and(
          eq(runs.taskId, taskId),
          eq(runs.snapshotPending, true),
          ne(runs.status, "running"),
        ),
      ),
  );
  if (pending.length === 0) return;
  await recordChanges(ctx, write, taskId, sandbox, pending);
  await write((tx) => clearPending(tx, pending));
}

const clearPending = (tx: Tx, done: PendingRun[]) =>
  tx
    .update(runs)
    .set({ snapshotPending: false })
    .where(
      inArray(
        runs.id,
        done.map((run) => run.id),
      ),
    );
