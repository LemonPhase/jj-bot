// The artifact snapshot after a run: files changed in the task workspace
// become `file` artifacts, deduplicated by path and content across the task.
// A run is credited only with paths its own write and edit tools touched.
// Anything else the scan finds (bash output files, a teammate's bash writes)
// is stored at task level, with no session or run, because the shared
// workspace cannot say who wrote it.
import { isAbsolute, posix, relative } from "node:path";
import { runs, type Tx, taskEvents } from "@jj/db";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
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

/** Paths written or edited by successful tool calls of these runs. */
async function toolPaths(
  tx: Tx,
  taskId: string,
  runIds: string[],
  workspaceDir: string,
): Promise<Set<string>> {
  if (runIds.length === 0) return new Set();
  const rows = await tx
    .select({ payload: taskEvents.payload })
    .from(taskEvents)
    .where(
      and(
        eq(taskEvents.taskId, taskId),
        eq(taskEvents.type, "tool.finished"),
        inArray(taskEvents.runId, runIds),
        sql`${taskEvents.payload}->>'tool' in ('write', 'edit')`,
        sql`(${taskEvents.payload}->>'ok')::boolean`,
      ),
    );
  const paths = new Set<string>();
  for (const row of rows)
    if (FILE_TOOLS.includes(String(row.payload.tool))) {
      const path = workspaceRelative(workspaceDir, String(row.payload.summary));
      if (path) paths.add(path);
    }
  return paths;
}

/** Records files changed since the run started, one transaction per artifact. */
export async function snapshotArtifacts(rc: RunContext, hold: SandboxHold) {
  const { ctx } = rc.deps;
  const since = new Date(rc.startedAt.getTime() - SNAPSHOT_SKEW_MS);
  const files = await changedFiles(hold.sandbox, since, ctx.config.artifacts);
  if (files.length === 0) return;
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
      own: await toolPaths(tx, rc.task.id, [rc.run.id], workspaceDir),
      othersActive: await toolPaths(
        tx,
        rc.task.id,
        active.map((run) => run.id),
        workspaceDir,
      ),
    };
  });
  for (const file of files) {
    const credited = own.has(file.path);
    // A teammate still running wrote this with its own tools: it is credited when that run ends.
    if (!credited && othersActive.has(file.path)) continue;
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
        credited
          ? attributionOf(rc)
          : { botId: null, sessionId: null, runId: null },
      );
    });
  }
}
