// Uploads: bytes the user stages (`POST /api/uploads`), then attaches to a
// task with a command. The host never parses, unpacks or runs them: it
// counts, hashes and stores them, derives their content type from the name
// and the first bytes, and copies them, inside the database, into the task's
// artifacts. The worker places them in the workspace (worker/uploads.ts).
import { extname } from "node:path";
import {
  type Artifact,
  defaultUploadPath,
  formatUploadSize,
  type StagedUpload,
  sameUploadPath,
  type TaskMessage,
  type UploadEntry,
  type UploadLimits,
  type UploadToTaskCommand,
  uploadAnnouncement,
  uploadNameProblem,
  uploadPathProblem,
  uploadToTaskCommandSchema,
} from "@jj/contracts";
import {
  artifacts,
  type StagedUploadRow,
  stagedUploads,
  type TaskRow,
  type Tx,
} from "@jj/db";
import { and, eq, gt, inArray, isNotNull, lte, sql, sum } from "drizzle-orm";
import type { UploadSettings } from "../config";
import type { EngineContext } from "../context";
import {
  DomainError,
  isUniqueViolation,
  notFound,
  parseCommand,
} from "../errors";
import { emit } from "../events";
import { toArtifact, toMessage } from "../records";
import type { Redactor } from "../redact";
import { contentTypeOf, sha256 } from "./artifacts";
import { assertOpen, postMessage } from "./messages";
import { lockTask } from "./sessions";
import { artifactColumns } from "./views";

/** `capabilities.uploads`: what bootstrap reports; null when uploads are off. */
export function uploadLimits(ctx: EngineContext): UploadLimits | null {
  const settings = ctx.config.uploads;
  return settings
    ? {
        maxFileBytes: settings.maxFileBytes,
        maxFiles: settings.maxFiles,
        maxTaskBytes: settings.maxTaskBytes,
      }
    : null;
}

/** The settings, or NOT_FOUND as for any route a server does not serve. */
export function uploadSettings(ctx: EngineContext): UploadSettings {
  const settings = ctx.config.uploads;
  if (!settings)
    throw new DomainError(
      "NOT_FOUND",
      "This server takes no uploads (JJ_UPLOADS is off).",
    );
  return settings;
}

const tooLarge = (message: string, details?: unknown) =>
  new DomainError("UPLOAD_TOO_LARGE", message, details);

const size = (bytes: number) => formatUploadSize(bytes);

/** Uploads each process is receiving now, and the bytes they declared. */
const receiving = new WeakMap<
  EngineContext,
  { count: number; bytes: number }
>();

const toStaged = (
  row: Pick<
    StagedUploadRow,
    "id" | "name" | "sizeBytes" | "sha256" | "contentType" | "expiresAt"
  >,
): StagedUpload => ({
  id: row.id,
  name: row.name,
  sizeBytes: row.sizeBytes,
  sha256: row.sha256,
  contentType: row.contentType,
  expiresAt: row.expiresAt.toISOString(),
});

const stagedColumns = {
  id: stagedUploads.id,
  name: stagedUploads.name,
  sizeBytes: stagedUploads.sizeBytes,
  sha256: stagedUploads.sha256,
  contentType: stagedUploads.contentType,
  expiresAt: stagedUploads.expiresAt,
};

export interface StageUploadInput {
  /** `?name=`: the file's name, normalized to NFC here. */
  name: string | undefined;
  /** The request's `Content-Length`, which the body must match. */
  sizeBytes: number;
  /** The raw body, read only once every check before it passed. */
  body: AsyncIterable<Uint8Array> | null;
  /**
   * Called once every check passed, just before the body is read: where the
   * client sent `Expect: 100-continue`, the transport invites the body then,
   * so a refused upload is never sent at all.
   */
  beforeRead?: () => void;
}

/**
 * `POST /api/uploads`: stages one file. Every limit is checked before a
 * byte of the body is read: the name, the extension, the declared size
 * against the file limit, uploads in flight (RATE_LIMITED) and the server's
 * staging space. The body must then be exactly the declared size. The name
 * is stored redacted.
 */
export async function stageUpload(
  ctx: EngineContext,
  input: StageUploadInput,
): Promise<{ upload: StagedUpload }> {
  const settings = uploadSettings(ctx);
  const name = (input.name ?? "").normalize("NFC");
  const problem = uploadNameProblem(name);
  if (problem)
    throw new DomainError("VALIDATION_FAILED", `name: ${problem}`, {
      field: "name",
    });
  if (
    settings.extensions &&
    !settings.extensions.includes(extname(name).toLowerCase())
  )
    throw new DomainError(
      "VALIDATION_FAILED",
      `This server takes only files ending in ${settings.extensions.join(", ")}.`,
      { extensions: settings.extensions },
    );
  if (input.sizeBytes > settings.maxFileBytes)
    throw tooLarge(
      `${name} is ${size(input.sizeBytes)}; a file can be at most ${size(settings.maxFileBytes)}.`,
      { limit: "file", maxBytes: settings.maxFileBytes },
    );
  const now = receiving.get(ctx) ?? { count: 0, bytes: 0 };
  receiving.set(ctx, now);
  if (now.count >= settings.maxInFlight)
    throw new DomainError(
      "RATE_LIMITED",
      `At most ${settings.maxInFlight} uploads are received at once; try again when one finishes.`,
    );
  now.count += 1;
  now.bytes += input.sizeBytes;
  try {
    const staged = await stagedBytes(ctx);
    if (staged + now.bytes > settings.maxStagedBytes)
      throw tooLarge(
        `The server's staging space is full (${size(settings.maxStagedBytes)}): attach or remove staged uploads, or try again once they expire.`,
        { limit: "staged", maxBytes: settings.maxStagedBytes },
      );
    // Stored redacted, like a file artifact's name: a name holding a server
    // secret never sits in the staging table (nor a backup of it), and the
    // file lands in the workspace under the redacted name. The content type
    // still comes from the real one.
    const redact = await ctx.redactor();
    input.beforeRead?.();
    const content = await readExactly(input.body, input.sizeBytes, {
      bytesPerSecond: settings.minBytesPerSecond,
      windowMs: settings.slowWindowMs,
    });
    const created = ctx.clock();
    const [row] = await ctx.db
      .insert(stagedUploads)
      .values({
        id: ctx.ids("stagedUpload"),
        name: redact(name),
        contentType: contentTypeOf(name, content),
        sizeBytes: content.byteLength,
        sha256: sha256(content),
        content,
        createdAt: created,
        expiresAt: new Date(created.getTime() + settings.stagedTtlMs),
      })
      .returning(stagedColumns);
    if (!row) throw new Error("The staged upload insert returned no row.");
    return { upload: toStaged(row) };
  } finally {
    now.count -= 1;
    now.bytes -= input.sizeBytes;
  }
}

/** Bytes staged and not expired, across the server. */
async function stagedBytes(ctx: EngineContext): Promise<number> {
  const [row] = await ctx.db
    .select({ value: sum(stagedUploads.sizeBytes) })
    .from(stagedUploads)
    .where(gt(stagedUploads.expiresAt, ctx.clock()));
  return Number(row?.value ?? 0);
}

/** How fast a body must come: at least `bytesPerSecond` over every window. */
interface Pace {
  bytesPerSecond: number;
  windowMs: number;
}

const tooSlow = (pace: Pace) =>
  new DomainError(
    "VALIDATION_FAILED",
    `The upload came too slowly: under ${size(pace.bytesPerSecond)} a second over ${pace.windowMs / 1000} s. Try again on a faster connection.`,
    { minBytesPerSecond: pace.bytesPerSecond, windowMs: pace.windowMs },
    408,
  );

/**
 * The body, which must hold exactly `expected` bytes and come at `pace`:
 * in every window, at least its bytes a second times the window, or the
 * rest of the file. A body that falls behind is abandoned with 408, so a
 * stalled sender does not hold an upload slot until the server's own
 * request timeout.
 */
async function readExactly(
  body: AsyncIterable<Uint8Array> | null,
  expected: number,
  pace: Pace,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let received = 0;
  if (body) {
    const iterator = body[Symbol.asyncIterator]();
    let windowStart = Date.now();
    let atWindowStart = 0;
    let next: Promise<IteratorResult<Uint8Array>> | undefined;
    try {
      for (;;) {
        next ??= iterator.next();
        let timer: NodeJS.Timeout | undefined;
        const elapsed = new Promise<"elapsed">((resolve) => {
          timer = setTimeout(
            () => resolve("elapsed"),
            Math.max(0, windowStart + pace.windowMs - Date.now()),
          );
        });
        const result = await Promise.race([next, elapsed]).finally(() =>
          clearTimeout(timer),
        );
        if (result === "elapsed") {
          const owed = Math.min(
            (pace.bytesPerSecond * pace.windowMs) / 1000,
            expected - atWindowStart,
          );
          if (received - atWindowStart < owed) {
            void iterator.return?.()?.catch(() => {});
            throw tooSlow(pace);
          }
          windowStart = Date.now();
          atWindowStart = received;
          continue;
        }
        next = undefined;
        if (result.done) break;
        const chunk = result.value;
        received += chunk.byteLength;
        if (received > expected)
          throw new DomainError(
            "VALIDATION_FAILED",
            "The body is longer than its Content-Length.",
          );
        chunks.push(chunk);
      }
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        "VALIDATION_FAILED",
        "The upload was cut off before its end.",
      );
    }
  }
  if (received !== expected)
    throw new DomainError(
      "VALIDATION_FAILED",
      `The body holds ${received} bytes; its Content-Length says ${expected}.`,
    );
  return Buffer.concat(chunks, received);
}

/** `DELETE /api/uploads/:id`: removes a staged upload that is not attached. */
export async function deleteStagedUpload(
  ctx: EngineContext,
  uploadId: string,
): Promise<void> {
  uploadSettings(ctx);
  const removed = await ctx.db
    .delete(stagedUploads)
    .where(
      and(
        eq(stagedUploads.id, uploadId),
        gt(stagedUploads.expiresAt, ctx.clock()),
      ),
    )
    .returning({ id: stagedUploads.id });
  if (removed.length === 0) throw notFound("Staged upload", uploadId);
}

/** Deletes the staged uploads past their time; returns how many. */
export async function sweepStagedUploads(ctx: EngineContext): Promise<number> {
  const removed = await ctx.db
    .delete(stagedUploads)
    .where(lte(stagedUploads.expiresAt, ctx.clock()))
    .returning({ id: stagedUploads.id });
  return removed.length;
}

export interface Attached {
  artifacts: Artifact[];
  message: TaskMessage;
}

/**
 * Attaches staged uploads to a task the caller has locked, in its
 * transaction: checks the entries against the server's limits and the task's
 * pending uploads, posts the announcement (the user's, a notification to no
 * one, so it wakes and reopens nothing), copies each staged row into
 * `artifacts` under its own id, pending, and deletes it. Paths and names are
 * stored redacted. Undefined for no entries.
 */
export async function attachUploadsTx(
  tx: Tx,
  ctx: EngineContext,
  task: Pick<TaskRow, "id">,
  entries: readonly UploadEntry[],
  redact: Redactor,
): Promise<Attached | undefined> {
  if (entries.length === 0) return undefined;
  const settings = uploadSettings(ctx);
  if (entries.length > settings.maxFiles)
    throw tooLarge(
      `A command attaches at most ${settings.maxFiles} files; this one has ${entries.length}.`,
      { limit: "files", maxFiles: settings.maxFiles },
    );
  const ids = entries.map((entry) => entry.uploadId);
  // Locked, so two commands cannot both attach one upload.
  const rows = await tx
    .select(stagedColumns)
    .from(stagedUploads)
    .where(
      and(
        inArray(stagedUploads.id, ids),
        gt(stagedUploads.expiresAt, ctx.clock()),
      ),
    )
    .for("update");
  const missing = ids.filter((id) => !rows.some((row) => row.id === id));
  if (missing.length > 0) {
    const attached = await tx
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(inArray(artifacts.id, missing));
    if (attached.length > 0)
      throw new DomainError(
        "CONFLICT",
        `Already attached: ${attached.map((row) => row.id).join(", ")}. Stage the file again to attach it once more.`,
        { uploadIds: attached.map((row) => row.id) },
      );
    throw new DomainError(
      "NOT_FOUND",
      `Staged upload not found (unknown, expired or removed): ${missing.join(", ")}.`,
      { uploadIds: missing },
    );
  }
  const files = entries.map((entry) => {
    const row = rows.find((staged) => staged.id === entry.uploadId);
    if (!row) throw new Error(`Staged upload ${entry.uploadId} vanished.`);
    const path = entry.path ?? defaultUploadPath(row.name);
    const problem = uploadPathProblem(path);
    if (problem)
      throw new DomainError("VALIDATION_FAILED", `${path}: ${problem}`);
    return { row, path: redact(path) };
  });
  // Paths are compared as the database folds case, which the pending-path
  // index uses: JavaScript folds some letters otherwise (İ, final Σ).
  const keys = await foldedPaths(
    tx,
    files.map((file) => file.path),
  );
  for (const [index, file] of files.entries())
    if (
      files
        .slice(0, index)
        .some(
          (other, earlier) =>
            sameUploadPath(other.path, file.path) ||
            keys[earlier] === keys[index],
        )
    )
      throw new DomainError(
        "VALIDATION_FAILED",
        `Two uploads go to ${file.path} (ignoring case); give one another path.`,
      );
  const bytes = files.reduce((total, file) => total + file.row.sizeBytes, 0);
  if (bytes > settings.maxCommandBytes)
    throw tooLarge(
      `These files are ${size(bytes)} in all; one command attaches at most ${size(settings.maxCommandBytes)}.`,
      { limit: "command", maxBytes: settings.maxCommandBytes },
    );
  const [held] = await tx
    .select({ value: sum(artifacts.sizeBytes) })
    .from(artifacts)
    .where(
      and(eq(artifacts.taskId, task.id), isNotNull(artifacts.uploadMessageId)),
    );
  const before = Number(held?.value ?? 0);
  if (before + bytes > settings.maxTaskBytes)
    throw tooLarge(
      `The task holds ${size(before)} of uploads; with these ${size(bytes)} it would pass its limit of ${size(settings.maxTaskBytes)}.`,
      { limit: "task", maxBytes: settings.maxTaskBytes },
    );
  const pending = await tx
    .select({ path: artifacts.path })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.taskId, task.id),
        eq(artifacts.uploadState, "pending"),
        inArray(sql`lower(${artifacts.path})`, keys),
      ),
    );
  if (pending.length > 0)
    throw new DomainError(
      "CONFLICT",
      `An upload waiting to be placed already goes to ${pending.map((row) => row.path).join(", ")}; give this one another path, or upload it once that one is in the workspace.`,
      { paths: pending.map((row) => row.path) },
    );

  const message = await postMessage(tx, ctx, {
    taskId: task.id,
    authorKind: "user",
    intent: "notification",
    text: uploadAnnouncement(
      files.map((file) => ({ path: file.path, sizeBytes: file.row.sizeBytes })),
    ),
    recipientBotIds: [],
  });
  const created = ctx.clock();
  const stored: Artifact[] = [];
  for (const file of files) {
    const name = file.path.split("/").pop() || file.path;
    // Copied inside the database: the bytes never pass through the server again.
    try {
      await tx.execute(sql`
      insert into ${artifacts} (id, owner_id, task_id, session_id, run_id, kind, path, name,
        content_type, size_bytes, sha256, content, upload_message_id, upload_state, created_at)
      select id, owner_id, ${task.id}, null, null, 'file', ${file.path}, ${name},
        content_type, size_bytes, sha256, content, ${message.id}, 'pending', ${created}
      from ${stagedUploads} where id = ${file.row.id}`);
    } catch (error) {
      // The pending-path index is the last word: a clash the checks above
      // did not see is still a CONFLICT, never a failed query.
      if (isUniqueViolation(error, "artifacts_pending_upload_path_unique"))
        throw new DomainError(
          "CONFLICT",
          `An upload waiting to be placed already goes to ${file.path}; give this one another path, or upload it once that one is in the workspace.`,
          { paths: [file.path] },
        );
      throw error;
    }
    const [row] = await tx
      .select(artifactColumns)
      .from(artifacts)
      .where(eq(artifacts.id, file.row.id));
    if (!row) throw new Error(`The upload ${file.row.id} was not copied.`);
    const artifact = toArtifact(row);
    stored.push(artifact);
    await emit(tx, ctx, task.id, {
      type: "artifact.created",
      payload: { artifact },
    });
  }
  await tx.delete(stagedUploads).where(inArray(stagedUploads.id, ids));
  return { artifacts: stored, message: toMessage(message) };
}

/** Each path as the database folds its case (`lower`), in order. */
async function foldedPaths(
  tx: Tx,
  paths: readonly string[],
): Promise<string[]> {
  if (paths.length === 0) return [];
  // Both drivers answer `execute` with `{ rows }`.
  const result = (await tx.execute(
    sql`select ${sql.join(
      paths.map(
        (path, index) => sql`lower(${path}) as ${sql.identifier(`k${index}`)}`,
      ),
      sql`, `,
    )}`,
  )) as unknown as { rows: Record<string, unknown>[] };
  const [row] = result.rows;
  return paths.map((_, index) => String(row?.[`k${index}`] ?? ""));
}

/**
 * `POST /api/tasks/:id/uploads`: attaches staged uploads to a task. Nothing
 * wakes and nothing reopens: a run of the task places them at its next turn
 * boundary, or the run a user message starts. TASK_TERMINAL once the task is
 * cancelled or stopping.
 */
export async function uploadToTask(
  ctx: EngineContext,
  taskId: string,
  input: UploadToTaskCommand,
): Promise<Attached> {
  uploadSettings(ctx);
  const command = parseCommand(uploadToTaskCommandSchema, input);
  // Built before the transaction: reading the stored secrets queries the database.
  const redact = await ctx.redactor();
  return ctx.db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    if (!task) throw notFound("Task", taskId);
    assertOpen(task);
    const attached = await attachUploadsTx(
      tx,
      ctx,
      task,
      command.files,
      redact,
    );
    if (!attached) throw new Error("No uploads to attach.");
    return attached;
  });
}
