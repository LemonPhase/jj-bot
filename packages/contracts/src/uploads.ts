import { z } from "zod";
import { hasInvisible } from "./approvals";
import { idSchema, timestampSchema } from "./common";

/**
 * Uploads: files the user gives a task. The bytes are staged first
 * (`POST /api/uploads`, raw `application/octet-stream`), then attached to a
 * task by a command (`POST /api/tasks`, a template start, or
 * `POST /api/tasks/:taskId/uploads`). Attaching stores each file with the
 * task as an artifact (`kind: "file"`, `upload` set), the durable copy and
 * the source of truth, and posts one announcement to the task log. The
 * worker then places each file in the workspace, at its path, before the
 * next model call of a run of the task; until then it is `pending`.
 */

/** The workspace folder an upload lands in when its entry names no path. */
export const DEFAULT_UPLOAD_DIR = "uploads";
/** Most entries one command attaches; a server may allow fewer (`capabilities.uploads.maxFiles`). */
export const MAX_UPLOAD_FILES = 20;
/** Most segments of an upload path. */
export const UPLOAD_PATH_MAX_SEGMENTS = 8;
/** Most UTF-8 bytes of one segment of an upload path. */
export const UPLOAD_SEGMENT_MAX_BYTES = 255;
/** Most characters (UTF-16 code units) of an upload path. */
export const UPLOAD_PATH_MAX_LENGTH = 1024;
/** First segments an upload path never has, in any case: the workspace's version control and JJ Bot's own folder. */
export const RESERVED_UPLOAD_ROOTS = [".git", ".jj", ".jj-bot"] as const;

/**
 * Where an upload is in the workspace: `pending` until a run places it,
 * then `placed`, or `failed` when it cannot be (a directory is in the way,
 * the path leaves the workspace). Set once: a placed or failed upload never
 * changes again.
 */
export const UPLOAD_STATES = ["pending", "placed", "failed"] as const;
export const uploadStateSchema = z.enum(UPLOAD_STATES);

// Controls (NUL, tab and line breaks among them), and the line and
// paragraph separators LS and PS.
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const NUL = String.fromCharCode(0);
const BACKSLASH = String.fromCharCode(92);
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const codePoint = (character: string) =>
  `U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength;

/**
 * Why `path` is not a valid upload path, or undefined when it is: a
 * workspace-relative POSIX path in Unicode NFC, of 1 to
 * UPLOAD_PATH_MAX_SEGMENTS segments of 1 to UPLOAD_SEGMENT_MAX_BYTES UTF-8
 * bytes each and at most UPLOAD_PATH_MAX_LENGTH characters in all. Refused:
 * an absolute path; an empty, `.` or `..` segment; a backslash, NUL, control,
 * invisible character (`hasInvisible`) or lone surrogate; a segment that
 * starts with `-` or ends with a space or a dot; a first segment in
 * RESERVED_UPLOAD_ROOTS, in any case. Pure, so clients check as the server does.
 */
export function uploadPathProblem(path: string): string | undefined {
  if (path.length === 0) return "The path is empty.";
  if (path.length > UPLOAD_PATH_MAX_LENGTH)
    return `The path is longer than ${UPLOAD_PATH_MAX_LENGTH} characters.`;
  const characters = characterProblem(path, "The path");
  if (characters) return characters;
  if (path.startsWith("/"))
    return "The path is absolute; give it relative to the workspace.";
  const segments = path.split("/");
  if (segments.length > UPLOAD_PATH_MAX_SEGMENTS)
    return `The path has more than ${UPLOAD_PATH_MAX_SEGMENTS} parts.`;
  for (const segment of segments) {
    const problem = segmentProblem(
      segment,
      segment === "" ? "A part of the path" : `The part "${segment}"`,
    );
    if (problem) return problem;
  }
  const first = segments[0] ?? "";
  if (
    (RESERVED_UPLOAD_ROOTS as readonly string[]).includes(first.toLowerCase())
  )
    return `Uploads cannot go into ${first}/.`;
  return undefined;
}

/** Why a path or a name holds a character it cannot, or undefined. */
function characterProblem(text: string, noun: string): string | undefined {
  if (text.includes(NUL)) return `${noun} holds a NUL character.`;
  const control = CONTROL.exec(text)?.[0];
  if (control !== undefined)
    return `${noun} holds a control character (${codePoint(control)}).`;
  if (LONE_SURROGATE.test(text)) return `${noun} holds a lone surrogate.`;
  if (hasInvisible(text)) return `${noun} holds an invisible character.`;
  if (text.normalize("NFC") !== text)
    return `${noun} is not in Unicode NFC form.`;
  if (text.includes(BACKSLASH))
    return `${noun} holds a backslash; separate folders with /.`;
  return undefined;
}

/** Why one segment of a path is refused, or undefined. */
function segmentProblem(segment: string, noun: string): string | undefined {
  if (segment === "") return `${noun} is empty (// or a / at an end).`;
  if (segment === "." || segment === "..") return `${noun} is . or ..`;
  if (utf8Bytes(segment) > UPLOAD_SEGMENT_MAX_BYTES)
    return `${noun} is longer than ${UPLOAD_SEGMENT_MAX_BYTES} bytes.`;
  if (segment.startsWith("-")) return `${noun} starts with "-".`;
  if (/[ .]$/.test(segment)) return `${noun} ends with a space or a dot.`;
  return undefined;
}

/** The path an upload takes when its entry names none: `uploads/<name>`. */
export const defaultUploadPath = (name: string) =>
  `${DEFAULT_UPLOAD_DIR}/${name}`;

/**
 * Why `name` is not a valid name for a staged upload, or undefined: one
 * segment of an upload path (no `/`), whose default path
 * (`defaultUploadPath`) is a valid upload path. Clients normalize a file's
 * name to NFC before staging it.
 */
export function uploadNameProblem(name: string): string | undefined {
  if (name.length === 0) return "The name is empty.";
  if (name.includes("/")) return "The name holds a /.";
  const problem =
    characterProblem(name, "The name") ?? segmentProblem(name, "The name");
  if (problem) return problem;
  return uploadPathProblem(defaultUploadPath(name)) === undefined
    ? undefined
    : "The name is too long.";
}

/** A workspace-relative upload path (`uploadPathProblem`). */
export const uploadPathSchema = z.string().superRefine((path, context) => {
  const problem = uploadPathProblem(path);
  if (problem) context.addIssue({ code: "custom", message: problem });
});

/** Whether two upload paths name the same file on a case-insensitive filesystem. */
export const sameUploadPath = (a: string, b: string) =>
  a.toLowerCase() === b.toLowerCase();

/**
 * Bytes staged by `POST /api/uploads`, waiting to be attached. A staged
 * upload is attached once; one not attached by `expiresAt` is deleted.
 * `contentType` is derived by the server from the name and the bytes, never
 * taken from the client.
 */
export const stagedUploadSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  contentType: z.string().min(1),
  expiresAt: timestampSchema,
});

/** `POST /api/uploads?name=…` → 201. */
export const stagedUploadResultSchema = z.object({
  upload: stagedUploadSchema,
});

/** One staged upload to attach, at `path`, else at `uploads/<its name>`. */
export const uploadEntrySchema = z.object({
  uploadId: idSchema,
  path: uploadPathSchema.optional(),
});

const uniqueEntries = (
  entries: { uploadId: string; path?: string | undefined }[],
  context: z.RefinementCtx,
) => {
  const ids = new Set<string>();
  const paths: string[] = [];
  for (const [index, entry] of entries.entries()) {
    if (ids.has(entry.uploadId))
      context.addIssue({
        code: "custom",
        path: [index, "uploadId"],
        message: "Each upload can be attached once.",
      });
    ids.add(entry.uploadId);
    if (entry.path === undefined) continue;
    if (paths.some((path) => sameUploadPath(path, entry.path as string)))
      context.addIssue({
        code: "custom",
        path: [index, "path"],
        message: "Two uploads have the same path (ignoring case).",
      });
    paths.push(entry.path);
  }
};

/**
 * The uploads a command attaches: at most MAX_UPLOAD_FILES, each once, with
 * paths unique ignoring case. The server also refuses two that land on one
 * path through their names.
 */
export const uploadEntryListSchema = z
  .array(uploadEntrySchema)
  .max(MAX_UPLOAD_FILES)
  .superRefine(uniqueEntries);

/**
 * `POST /api/tasks/:taskId/uploads`: attaches 1 to `maxFiles` staged
 * uploads to a task. It posts one announcement to the task log, which wakes
 * and reopens nothing: the files are placed by the task's next run, at a
 * turn boundary of one running now, else when a user message continues it.
 * A cancelled task, or one being stopped, answers 409 TASK_TERMINAL.
 */
export const uploadToTaskCommandSchema = z.object({
  files: z
    .array(uploadEntrySchema)
    .min(1)
    .max(MAX_UPLOAD_FILES)
    .superRefine(uniqueEntries),
});

/**
 * An artifact the user uploaded: the task message that announced it, and
 * where it is in the workspace. `placedAt` is set when it was placed,
 * `error` when it failed.
 */
export const artifactUploadSchema = z.object({
  messageId: idSchema,
  state: uploadStateSchema,
  placedAt: timestampSchema.nullable(),
  error: z.string().nullable(),
});

/**
 * What a server takes, from bootstrap; null when it serves no uploads (the
 * upload routes then answer 404). A command also takes at most
 * UPLOAD_COMMAND_MAX_BYTES in all.
 */
export const uploadLimitsSchema = z.object({
  maxFileBytes: z.number().int().positive(),
  maxFiles: z.number().int().min(1).max(MAX_UPLOAD_FILES),
  maxTaskBytes: z.number().int().positive(),
});

/** Most bytes one command attaches in all. */
export const UPLOAD_COMMAND_MAX_BYTES = 64 * 1024 * 1024;

/** A size as the task log and the web app write it: `812 B`, `3.4 KB`, `1.2 MB`. */
export function formatUploadSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : Number(value.toFixed(1))} ${units[unit]}`;
}

/** The task log's announcement of attached uploads: "Uploaded 2 files: uploads/a.csv (1.2 MB), …". */
export function uploadAnnouncement(
  files: readonly { path: string; sizeBytes: number }[],
): string {
  const count = files.length === 1 ? "1 file" : `${files.length} files`;
  return `Uploaded ${count}: ${files
    .map((file) => `${file.path} (${formatUploadSize(file.sizeBytes)})`)
    .join(", ")}`;
}

export type UploadState = z.infer<typeof uploadStateSchema>;
export type StagedUpload = z.infer<typeof stagedUploadSchema>;
export type UploadEntry = z.input<typeof uploadEntrySchema>;
export type UploadToTaskCommand = z.input<typeof uploadToTaskCommandSchema>;
export type ArtifactUpload = z.infer<typeof artifactUploadSchema>;
export type UploadLimits = z.infer<typeof uploadLimitsSchema>;
