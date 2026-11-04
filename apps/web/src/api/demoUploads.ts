/**
 * Uploads in the demo: staged files stay in the page's memory and are
 * "placed" when the demo task's script next takes a step, as a server's run
 * places them at its next model call. The rules mirror the server's
 * (services/uploads.ts): the same name and path checks, limits and refusals,
 * and the same announcement in the task log. Nothing is written anywhere.
 */
import {
  type Artifact,
  defaultUploadPath,
  formatUploadSize,
  type StagedUpload,
  sameUploadPath,
  type TaskMessage,
  UPLOAD_COMMAND_MAX_BYTES,
  type UploadEntry,
  type UploadLimits,
  uploadAnnouncement,
  uploadNameProblem,
  uploadPathProblem,
} from "@jj/contracts";
import { ApiError, type StageUploadOptions } from "./client";
import { Ops, type ScriptHost } from "./demoScript";

const STAGED_TTL_MS = 60 * 60_000;

const TYPES: Record<string, string> = {
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  zip: "application/zip",
};

const contentTypeOf = (name: string) =>
  TYPES[name.split(".").pop()?.toLowerCase() ?? ""] ??
  "application/octet-stream";

/** SHA-256 where the page has Web Crypto; else a stable placeholder digest. */
async function digest(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const hash = await subtle.digest("SHA-256", bytes as BufferSource);
    return [...new Uint8Array(hash)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }
  let value = 0x811c9dc5;
  for (const byte of bytes) value = Math.imul(value ^ byte, 0x01000193);
  return (value >>> 0).toString(16).padStart(8, "0").repeat(8);
}

const refuse = (
  code: ConstructorParameters<typeof ApiError>[0],
  status: number,
  message: string,
) => new ApiError(code, message, undefined, status);

export class DemoUploads {
  private readonly staged = new Map<
    string,
    { upload: StagedUpload; bytes: Uint8Array }
  >();
  private readonly attached = new Set<string>();
  private readonly urls = new Map<string, string>();
  private counter = 0;

  constructor(
    private readonly limits: UploadLimits,
    private readonly now: () => string,
  ) {}

  async stage(
    file: Blob,
    rawName: string,
    options: StageUploadOptions = {},
  ): Promise<StagedUpload> {
    const name = rawName.normalize("NFC");
    const problem = uploadNameProblem(name);
    if (problem) throw refuse("VALIDATION_FAILED", 400, `name: ${problem}`);
    if (file.size > this.limits.maxFileBytes)
      throw refuse(
        "UPLOAD_TOO_LARGE",
        413,
        `${name} is ${formatUploadSize(file.size)}; a file can be at most ${formatUploadSize(this.limits.maxFileBytes)}.`,
      );
    if (options.signal?.aborted)
      throw new ApiError("ABORTED", "The upload was cancelled.");
    const bytes = new Uint8Array(await file.arrayBuffer());
    options.onProgress?.(bytes.byteLength, bytes.byteLength);
    const upload: StagedUpload = {
      id: `upl-${++this.counter}`,
      name,
      sizeBytes: bytes.byteLength,
      sha256: await digest(bytes),
      contentType: contentTypeOf(name),
      expiresAt: new Date(Date.parse(this.now()) + STAGED_TTL_MS).toISOString(),
    };
    this.staged.set(upload.id, { upload, bytes });
    return { ...upload };
  }

  delete(uploadId: string) {
    if (!this.staged.delete(uploadId))
      throw refuse(
        "NOT_FOUND",
        404,
        `Staged upload ${uploadId} was not found.`,
      );
  }

  /** Where an uploaded artifact downloads from, while the page lives. */
  url(artifactId: string): string | undefined {
    return this.urls.get(artifactId);
  }

  /** As the server's `attachUploadsTx`: checks, the announcement, pending artifacts. */
  attach(
    host: ScriptHost,
    entries: readonly UploadEntry[],
  ): { artifacts: Artifact[]; message: TaskMessage } | undefined {
    if (entries.length === 0) return undefined;
    if (entries.length > this.limits.maxFiles)
      throw refuse(
        "UPLOAD_TOO_LARGE",
        413,
        `A command attaches at most ${this.limits.maxFiles} files; this one has ${entries.length}.`,
      );
    const now = Date.parse(this.now());
    const files = entries.map((entry) => {
      const staged = this.staged.get(entry.uploadId);
      if (!staged || Date.parse(staged.upload.expiresAt) <= now)
        throw this.attached.has(entry.uploadId)
          ? refuse(
              "CONFLICT",
              409,
              `Already attached: ${entry.uploadId}. Stage the file again to attach it once more.`,
            )
          : refuse(
              "NOT_FOUND",
              404,
              `Staged upload not found (unknown, expired or removed): ${entry.uploadId}.`,
            );
      const path = entry.path ?? defaultUploadPath(staged.upload.name);
      const problem = uploadPathProblem(path);
      if (problem)
        throw refuse("VALIDATION_FAILED", 400, `${path}: ${problem}`);
      return { ...staged, path };
    });
    for (const [index, file] of files.entries())
      if (
        files
          .slice(0, index)
          .some((other) => sameUploadPath(other.path, file.path))
      )
        throw refuse(
          "VALIDATION_FAILED",
          400,
          `Two uploads go to ${file.path} (ignoring case); give one another path.`,
        );
    const bytes = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
    if (bytes > UPLOAD_COMMAND_MAX_BYTES)
      throw refuse(
        "UPLOAD_TOO_LARGE",
        413,
        `These files are ${formatUploadSize(bytes)} in all; one command attaches at most ${formatUploadSize(UPLOAD_COMMAND_MAX_BYTES)}.`,
      );
    const uploads = host.view().artifacts.filter((artifact) => artifact.upload);
    const before = uploads.reduce(
      (sum, artifact) => sum + artifact.sizeBytes,
      0,
    );
    if (before + bytes > this.limits.maxTaskBytes)
      throw refuse(
        "UPLOAD_TOO_LARGE",
        413,
        `The task holds ${formatUploadSize(before)} of uploads; with these ${formatUploadSize(bytes)} it would pass its limit of ${formatUploadSize(this.limits.maxTaskBytes)}.`,
      );
    const taken = uploads.filter(
      (artifact) =>
        artifact.upload?.state === "pending" &&
        files.some((file) => sameUploadPath(file.path, artifact.path)),
    );
    if (taken.length > 0)
      throw refuse(
        "CONFLICT",
        409,
        `An upload waiting to be placed already goes to ${taken.map((artifact) => artifact.path).join(", ")}; give this one another path, or upload it once that one is in the workspace.`,
      );

    const message = new Ops(host).post({
      authorKind: "user",
      authorBotId: null,
      sessionId: null,
      intent: "notification",
      text: uploadAnnouncement(
        files.map((file) => ({
          path: file.path,
          sizeBytes: file.bytes.byteLength,
        })),
      ),
      recipientBotIds: [],
    });
    const createdAt = this.now();
    const artifacts = files.map((file): Artifact => {
      const artifact: Artifact = {
        id: file.upload.id,
        taskId: host.taskId,
        sessionId: null,
        runId: null,
        kind: "file",
        path: file.path,
        name: file.path.split("/").pop() ?? file.path,
        contentType: file.upload.contentType,
        sizeBytes: file.bytes.byteLength,
        sha256: file.upload.sha256,
        upload: {
          messageId: message.id,
          state: "pending",
          placedAt: null,
          error: null,
        },
        createdAt,
      };
      this.staged.delete(file.upload.id);
      this.attached.add(file.upload.id);
      this.urls.set(artifact.id, dataUrl(file.upload.contentType, file.bytes));
      host.emit("artifact.created", { artifact });
      return artifact;
    });
    return { artifacts, message };
  }

  /** The demo's stand-in for a run's placement: every pending upload is placed. */
  place(host: ScriptHost) {
    for (const artifact of host.view().artifacts) {
      if (artifact.upload?.state !== "pending") continue;
      host.emit("artifact.updated", {
        artifact: {
          ...artifact,
          upload: { ...artifact.upload, state: "placed", placedAt: this.now() },
        },
        previousState: "pending",
      });
    }
  }
}

function dataUrl(type: string, bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return `data:${type.split(";")[0]};base64,${btoa(binary)}`;
}
