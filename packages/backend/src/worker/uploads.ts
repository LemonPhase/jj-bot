// Placement of uploads: every run of a task puts the task's pending uploads
// in the workspace, oldest first, once it holds the sandbox and before its
// first model call, and again before each turn boundary takes the inbox.
// Only the sandbox's fs API touches the workspace, so `local` and `docker`
// place alike. A file is written beside its target as
// `.jj-upload-<id>-<attempt>.part`, then moved onto the target: a symlink at the target
// is replaced, never followed, and a reader never sees half a file. One
// fenced write under the task lock then records the outcome once (`placed`,
// or `failed` when the workspace refuses it for good) and emits
// `artifact.updated`; the write that settles the last upload of an
// announcement also gives the root session one notice, which wakes no one.
// A transient failure leaves the upload pending for a later run. A crash
// between the move and the record places the same bytes again, and the
// notice is still written once.
import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import { formatUploadSize } from "@jj/contracts";
import { artifacts, type Tx } from "@jj/db";
import { type Sandbox, SandboxPathError } from "@jj/sandbox/contract";
import { and, asc, count, eq } from "drizzle-orm";
import type { EngineContext } from "../context";
import { errorMessage } from "../errors";
import { type Attribution, emit } from "../events";
import { toArtifact } from "../records";
import { uploadPartName, uploadPartPrefix } from "../services/artifacts";
import { deliver, rootSession } from "../services/messages";
import { lockTask } from "../services/sessions";
import { artifactColumns } from "../services/views";
import { attributionOf, type RunContext, writeRun } from "./run-context";

export type Outcome =
  | { kind: "placed" }
  | { kind: "failed"; error: string }
  | { kind: "transient"; error: string };

/** Errors that will not go away by trying again, with what to tell the user. */
const LASTING: Record<string, string> = {
  EISDIR: "a directory is in the way",
  ENOTDIR: "a file is in the way of its folder",
  EEXIST: "a file is in the way of its folder",
  ENOTEMPTY: "a directory is in the way",
  ELOOP: "its folder is a loop of symbolic links",
  ENAMETOOLONG: "the path is too long for the workspace",
  EINVAL: "something other than a file is in the way",
  EACCES: "the workspace refused the write (permission denied)",
  EPERM: "the workspace refused the write (permission denied)",
  EROFS: "the workspace is read-only",
};

function classify(error: unknown): Outcome {
  if (error instanceof SandboxPathError)
    return {
      kind: "failed",
      error: "its folder leads out of the workspace (a symbolic link)",
    };
  const code = (error as { code?: unknown }).code;
  const lasting = typeof code === "string" ? LASTING[code] : undefined;
  return lasting
    ? { kind: "failed", error: lasting }
    : { kind: "transient", error: errorMessage(error) };
}

/**
 * Writes the bytes beside the target, under a part name of this attempt's
 * own, then moves them onto it. Another attempt at the same upload (a run on
 * another worker) writes and moves its own part, so a move never carries
 * another attempt's half-written file. Parts of this upload left by attempts
 * that died are removed afterwards.
 */
export async function writeInto(
  sandbox: Sandbox,
  uploadId: string,
  path: string,
  content: Uint8Array,
): Promise<Outcome> {
  const dir = posix.dirname(path);
  const inDir = (name: string) => (dir === "." ? name : `${dir}/${name}`);
  const part = inDir(uploadPartName(uploadId, randomBytes(6).toString("hex")));
  try {
    // Whatever sits at the part's name goes first, so a symlink an agent
    // left there is removed, never written through.
    await sandbox.fs.remove(part);
    await sandbox.fs.write(part, Buffer.from(content));
    await sandbox.fs.move(part, path);
    return { kind: "placed" };
  } catch (error) {
    await sandbox.fs.remove(part).catch(() => {});
    return classify(error);
  } finally {
    await removeStaleParts(sandbox, dir, uploadId);
  }
}

/** Removes the part files of an upload that attempts which died left in `dir`. */
async function removeStaleParts(
  sandbox: Sandbox,
  dir: string,
  uploadId: string,
) {
  const prefix = uploadPartPrefix(uploadId);
  const entries = await sandbox.fs.list(dir).catch(() => []);
  for (const entry of entries) {
    const name = posix.basename(entry.path);
    if (name.startsWith(prefix) && name.endsWith(".part"))
      await sandbox.fs
        .remove(dir === "." ? name : `${dir}/${name}`)
        .catch(() => {});
  }
}

/** Calls of `fn` under one key run one at a time, in order, in this process. */
const queues = new Map<string, Promise<unknown>>();
async function oneAtATime<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const before = queues.get(key) ?? Promise.resolve();
  const run = before.then(fn, fn);
  const settled = run.catch(() => {});
  queues.set(key, settled);
  try {
    return await run;
  } finally {
    if (queues.get(key) === settled) queues.delete(key);
  }
}

/**
 * Places the task's pending uploads in the run's sandbox. Two runs of one
 * task on this worker place one at a time, and each upload is read afresh
 * before it is written, so one placed meanwhile is not written again.
 */
export async function placeUploads(
  rc: RunContext,
  sandbox: Sandbox,
): Promise<void> {
  const { ctx } = rc.deps;
  if (!ctx.config.uploads) return;
  const [any] = await ctx.db
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.taskId, rc.task.id),
        eq(artifacts.uploadState, "pending"),
      ),
    )
    .limit(1);
  if (!any) return;
  await oneAtATime(`uploads:${rc.task.id}`, async () => {
    const pending = await ctx.db
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(
        and(
          eq(artifacts.taskId, rc.task.id),
          eq(artifacts.uploadState, "pending"),
        ),
      )
      .orderBy(asc(artifacts.createdAt), asc(artifacts.id));
    for (const { id } of pending) {
      if (rc.deferredUploads?.has(id)) continue;
      // One file in memory at a time, read just before it is written.
      const [upload] = await ctx.db
        .select({
          path: artifacts.path,
          state: artifacts.uploadState,
          content: artifacts.content,
        })
        .from(artifacts)
        .where(eq(artifacts.id, id));
      if (!upload || upload.state !== "pending") continue;
      const outcome = await writeInto(sandbox, id, upload.path, upload.content);
      if (outcome.kind === "transient") {
        // Tried again by the task's next run, not at every turn of this one.
        (rc.deferredUploads ??= new Set()).add(id);
        ctx.logger.warn("Placing an upload failed; it stays pending", {
          uploadId: id,
          error: outcome.error,
        });
        continue;
      }
      await writeRun(rc, (tx) =>
        settleUpload(tx, ctx, rc.task.id, id, outcome, attributionOf(rc)),
      );
    }
  });
}

/**
 * Records one upload's outcome under the task lock, once: an upload another
 * attempt settled first is left as it is, with no event and no notice.
 * Settling an announcement's last upload gives the root session its notice.
 * True when this call settled it.
 */
export async function settleUpload(
  tx: Tx,
  ctx: EngineContext,
  taskId: string,
  uploadId: string,
  outcome: Exclude<Outcome, { kind: "transient" }>,
  attribution: Attribution,
): Promise<boolean> {
  await lockTask(tx, taskId);
  const [row] = await tx
    .update(artifacts)
    .set(
      outcome.kind === "placed"
        ? { uploadState: "placed", placedAt: ctx.clock() }
        : { uploadState: "failed", uploadError: outcome.error },
    )
    .where(
      and(eq(artifacts.id, uploadId), eq(artifacts.uploadState, "pending")),
    )
    .returning(artifactColumns);
  // Another attempt recorded it first.
  if (!row?.uploadMessageId) return false;
  await emit(tx, taskId, {
    type: "artifact.updated",
    payload: { artifact: toArtifact(row), previousState: "pending" },
    ...attribution,
  });
  const [left] = await tx
    .select({ value: count() })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.uploadMessageId, row.uploadMessageId),
        eq(artifacts.uploadState, "pending"),
      ),
    );
  if ((left?.value ?? 0) > 0) return true;
  const batch = await tx
    .select(artifactColumns)
    .from(artifacts)
    .where(eq(artifacts.uploadMessageId, row.uploadMessageId))
    .orderBy(asc(artifacts.createdAt), asc(artifacts.id));
  const root = await rootSession(tx, taskId);
  if (!root) return true;
  await deliver(
    tx,
    root,
    {
      kind: "message",
      text: placementNotice(row.uploadMessageId, batch),
      sourceMessageId: row.uploadMessageId,
    },
    { wake: false, ctx },
  );
  return true;
}

/**
 * The root session's notice once an announcement's uploads are settled:
 * which files are in the workspace and which could not be placed, and why.
 * Paths are one line of plain text (`uploadPathProblem`), so none can
 * forge a line of its own.
 */
export function placementNotice(
  messageId: string,
  batch: readonly {
    path: string;
    sizeBytes: number;
    uploadState: string | null;
    uploadError: string | null;
  }[],
): string {
  const placed = batch.filter((file) => file.uploadState === "placed");
  const failed = batch.filter((file) => file.uploadState === "failed");
  const parts: string[] = [];
  if (placed.length > 0)
    parts.push(
      `Now in the workspace: ${placed
        .map((file) => `${file.path} (${formatUploadSize(file.sizeBytes)})`)
        .join(", ")}`,
    );
  if (failed.length > 0)
    parts.push(
      `${placed.length > 0 ? "not placed" : "Not placed"}: ${failed
        .map((file) => `${file.path} (${file.uploadError ?? "refused"})`)
        .join(", ")}`,
    );
  return `[Uploads] ${parts.join("; ")}. The user uploaded these files (task log entry ${messageId}).`;
}
