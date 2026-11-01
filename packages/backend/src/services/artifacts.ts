// Artifacts: files a run changed in the task workspace, and tool output
// spilled because it exceeded the event preview. Content is stored in the
// database, so downloads never depend on a live sandbox.
import { createHash } from "node:crypto";
import { extname, isAbsolute, posix, relative } from "node:path";
import type { Artifact } from "@jj/contracts";
import { artifacts, type Tx } from "@jj/db";
import type { Sandbox } from "@jj/sandbox/contract";
import { and, eq } from "drizzle-orm";
import type { ArtifactLimits } from "../config";
import type { EngineContext } from "../context";
import { notFound } from "../errors";
import { type Attribution, emit } from "../events";
import { toArtifact } from "../records";
import { artifactColumns } from "./views";

const CONTENT_TYPES: Record<string, string> = {
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".json": "application/json",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
};

/** A content type from the extension, else text or binary by sniffing. */
export function contentTypeOf(path: string, content: Uint8Array): string {
  const known = CONTENT_TYPES[extname(path).toLowerCase()];
  if (known) return known;
  const sample = content.subarray(0, 4096);
  if (sample.includes(0)) return "application/octet-stream";
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return "text/plain; charset=utf-8";
  } catch {
    return "application/octet-stream";
  }
}

export const sha256 = (content: Uint8Array) =>
  createHash("sha256").update(content).digest("hex");

export interface NewArtifact {
  taskId: string;
  kind: "file" | "output";
  path: string;
  name: string;
  content: Uint8Array;
  contentType?: string;
}

/** Inserts an artifact and emits `artifact.created`. */
export async function storeArtifact(
  tx: Tx,
  ctx: EngineContext,
  input: NewArtifact,
  attribution: Attribution,
): Promise<Artifact> {
  const [row] = await tx
    .insert(artifacts)
    .values({
      id: ctx.ids("artifact"),
      taskId: input.taskId,
      sessionId: attribution.sessionId ?? null,
      runId: attribution.runId ?? null,
      kind: input.kind,
      path: input.path,
      name: input.name,
      contentType:
        input.contentType ?? contentTypeOf(input.path, input.content),
      sizeBytes: input.content.byteLength,
      sha256: sha256(input.content),
      content: input.content,
      createdAt: ctx.clock(),
    })
    .returning(artifactColumns);
  if (!row) throw new Error("The artifact insert returned no row.");
  const artifact = toArtifact(row);
  await emit(tx, input.taskId, {
    type: "artifact.created",
    payload: { artifact },
    ...attribution,
  });
  return artifact;
}

/** Whether the task already has this exact file (same path and content). */
export async function hasArtifact(
  tx: Tx,
  taskId: string,
  path: string,
  digest: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.taskId, taskId),
        eq(artifacts.path, path),
        eq(artifacts.sha256, digest),
      ),
    )
    .limit(1);
  return row !== undefined;
}

export interface ChangedFile {
  path: string;
  content: Uint8Array;
}

/** A workspace-relative POSIX path for an entry a driver listed. */
function workspacePath(sandbox: Sandbox, listed: string, dir: string): string {
  const path = isAbsolute(listed)
    ? relative(sandbox.workspaceDir, listed)
    : listed.startsWith(`${dir}/`) || dir === "."
      ? listed
      : posix.join(dir, listed);
  return path.split("\\").join("/").replace(/^\.\//, "");
}

/**
 * Files in the workspace modified at or after `since`: breadth-first, skipping
 * ignored directories, at most `maxListEntries` entries listed and
 * `maxFilesPerRun` files returned, each at most `maxFileBytes`.
 */
export async function changedFiles(
  sandbox: Sandbox,
  since: Date,
  limits: ArtifactLimits,
): Promise<ChangedFile[]> {
  const ignored = new Set(limits.ignoreDirectories);
  const found: ChangedFile[] = [];
  const queue = ["."];
  let listed = 0;
  while (queue.length > 0 && listed < limits.maxListEntries) {
    const dir = queue.shift() as string;
    let entries: Awaited<ReturnType<Sandbox["fs"]["list"]>>;
    try {
      entries = await sandbox.fs.list(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (listed >= limits.maxListEntries) break;
      listed += 1;
      const path = workspacePath(sandbox, entry.path, dir);
      if (!path || path.startsWith("..")) continue;
      const name = posix.basename(path);
      if (entry.kind === "directory") {
        if (!ignored.has(name)) queue.push(path);
        continue;
      }
      if (entry.kind !== "file" || found.length >= limits.maxFilesPerRun)
        continue;
      const info = await sandbox.fs.stat(path).catch(() => undefined);
      if (!info || info.kind !== "file") continue;
      if (info.size > limits.maxFileBytes) continue;
      if (new Date(info.modifiedAt).getTime() < since.getTime()) continue;
      const content = await sandbox.fs.read(path).catch(() => undefined);
      if (content) found.push({ path, content: new Uint8Array(content) });
    }
  }
  return found;
}

/** `GET /api/tasks/:id/artifacts/:artifactId/content`. */
export async function artifactContent(
  ctx: EngineContext,
  taskId: string,
  artifactId: string,
): Promise<{ artifact: Artifact; content: Uint8Array }> {
  const [row] = await ctx.db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.id, artifactId), eq(artifacts.taskId, taskId)));
  if (!row) throw notFound("Artifact", artifactId);
  return { artifact: toArtifact(row), content: row.content };
}
