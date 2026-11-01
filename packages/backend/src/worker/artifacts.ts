// The artifact snapshot after a run: files changed in the task workspace
// become `file` artifacts, deduplicated by path and content across the task.
// The scan also covers the session's earlier runs that ended without a
// completed snapshot (handed back by a graceful stop, or cut off by a crash),
// from the earliest one's start, so their files are not lost. A file is
// credited to the covered run whose write or edit tool last touched it.
// Anything else the scan finds (bash output files, a teammate's bash writes)
// is stored at task level, with no session or run, because the shared
// workspace cannot say who wrote it.
import { isAbsolute, posix, relative } from "node:path";
import { runs, type Tx, taskEvents } from "@jj/db";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  lt,
  max,
  ne,
  sql,
} from "drizzle-orm";
import {
  changedFiles,
  hasArtifact,
  sha256,
  storeArtifact,
} from "../services/artifacts";
import { lockTask } from "../services/sessions";
import { attributionOf, type RunContext, writeRun } from "./run-context";
import type { SandboxHold } from "./sandboxes";

/** Clock skew allowed between the worker and the sandbox when finding changed files. */
const SNAPSHOT_SKEW_MS = 2_000;
const FILE_TOOLS = ["write", "edit"];

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
 * the last run that touched it.
 */
async function toolPaths(
  tx: Tx,
  taskId: string,
  runIds: string[],
  workspaceDir: string,
): Promise<Map<string, string>> {
  if (runIds.length === 0) return new Map();
  const rows = await tx
    .select({ runId: taskEvents.runId, payload: taskEvents.payload })
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
  const paths = new Map<string, string>();
  for (const row of rows)
    if (row.runId && FILE_TOOLS.includes(String(row.payload.tool))) {
      const path = workspaceRelative(workspaceDir, String(row.payload.summary));
      if (path) paths.set(path, row.runId);
    }
  return paths;
}

/**
 * The runs whose changes this snapshot covers: this run and, until one of its
 * snapshots completes, the session's earlier runs after the last one that
 * ended with its snapshot complete.
 */
async function coveredRuns(
  rc: RunContext,
): Promise<{ id: string; startedAt: Date }[]> {
  const current = { id: rc.run.id, startedAt: rc.startedAt };
  if (rc.snapshotted) return [current];
  const earlier = await writeRun(rc, async (tx) => {
    const [mark] = await tx
      .select({ number: max(runs.number) })
      .from(runs)
      .where(
        and(
          eq(runs.sessionId, rc.session.id),
          lt(runs.number, rc.run.number),
          isNotNull(runs.snapshottedAt),
        ),
      );
    return tx
      .select({ id: runs.id, startedAt: runs.startedAt })
      .from(runs)
      .where(
        and(
          eq(runs.sessionId, rc.session.id),
          lt(runs.number, rc.run.number),
          gt(runs.number, mark?.number ?? 0),
        ),
      );
  });
  return [...earlier, current];
}

/**
 * Records files changed in the runs it covers, one transaction per artifact,
 * then sets `rc.snapshotted`.
 */
export async function snapshotArtifacts(rc: RunContext, hold: SandboxHold) {
  const { ctx } = rc.deps;
  const covered = await coveredRuns(rc);
  const from = Math.min(...covered.map((run) => run.startedAt.getTime()));
  const since = new Date(from - SNAPSHOT_SKEW_MS);
  const files = await changedFiles(hold.sandbox, since, ctx.config.artifacts);
  if (files.length === 0) {
    rc.snapshotted = true;
    return;
  }
  const workspaceDir = hold.sandbox.workspaceDir;
  const { own, othersActive } = await writeRun(rc, async (tx) => {
    const active = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.taskId, rc.task.id),
          eq(runs.status, "running"),
          ne(runs.id, rc.run.id),
        ),
      );
    return {
      own: await toolPaths(
        tx,
        rc.task.id,
        covered.map((run) => run.id),
        workspaceDir,
      ),
      othersActive: await toolPaths(
        tx,
        rc.task.id,
        active.map((run) => run.id),
        workspaceDir,
      ),
    };
  });
  for (const file of files) {
    const creditedRun = own.get(file.path);
    // A teammate still running wrote this with its own tools: it is credited when that run ends.
    if (!creditedRun && othersActive.has(file.path)) continue;
    const digest = sha256(file.content);
    await writeRun(rc, async (tx) => {
      // The task lock first, so two runs snapshotting one file cannot both store it.
      await lockTask(tx, rc.task.id);
      if (await hasArtifact(tx, rc.task.id, file.path, digest)) return;
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
        creditedRun
          ? { ...attributionOf(rc), runId: creditedRun }
          : { botId: null, sessionId: null, runId: null },
      );
    });
  }
  rc.snapshotted = true;
}
