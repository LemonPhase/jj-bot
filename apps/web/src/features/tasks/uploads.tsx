import {
  formatUploadSize,
  type StagedUpload,
  sameUploadPath,
  type TaskMessage,
  UPLOAD_COMMAND_MAX_BYTES,
  type UploadEntry,
  type UploadLimits,
  uploadNameProblem,
} from "@jj/contracts";
import {
  type DragEvent,
  type Ref,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useApi } from "../../api/ApiContext";
import { isApiError } from "../../api/client";
import { Button, Icon, IconButton } from "../../components/ui";
import "./tasks.css";

/** One file the user picked: being sent, staged on the server, or refused. */
export interface UploadDraft {
  key: string;
  /** The file's name in NFC, as the server stores it. */
  name: string;
  size: number;
  state: "uploading" | "staged" | "failed";
  /** Bytes sent so far. */
  sent: number;
  upload?: StagedUpload;
  error?: string;
}

const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

/**
 * Files the user picked for a command, staged one at a time as they are
 * added (the server takes a few uploads at once and answers more with 429).
 * A file the limits refuse shows its reason in place, without a request.
 * `discard` removes whatever was staged, for a form closed unsent; after a
 * command attached them, `clear` forgets them.
 */
export function useUploadDrafts() {
  const api = useApi();
  const limits = api.capabilities.uploads;
  const [drafts, setDrafts] = useState<UploadDraft[]>([]);
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const controllers = useRef(new Map<string, AbortController>());
  const queue = useRef<Promise<void>>(Promise.resolve());
  const counter = useRef(0);

  const patch = useCallback((key: string, next: Partial<UploadDraft>) => {
    setDrafts((current) =>
      current.map((draft) =>
        draft.key === key ? { ...draft, ...next } : draft,
      ),
    );
  }, []);

  const add = useCallback(
    (files: readonly File[]) => {
      if (!limits) return;
      const kept = draftsRef.current.filter(
        (draft) => draft.state !== "failed",
      );
      let count = kept.length;
      let bytes = kept.reduce((sum, draft) => sum + draft.size, 0);
      const names = kept.map((draft) => draft.name);
      const added: { draft: UploadDraft; file: File }[] = [];
      for (const file of files) {
        const name = file.name.normalize("NFC");
        const problem =
          uploadNameProblem(name) ??
          (file.size > limits.maxFileBytes
            ? `${formatUploadSize(file.size)} is over the ${formatUploadSize(limits.maxFileBytes)} a file can be.`
            : names.some((other) => sameUploadPath(other, name))
              ? "A file with this name is already added."
              : count + 1 > limits.maxFiles
                ? `At most ${limits.maxFiles} files at once.`
                : bytes + file.size >
                    Math.min(UPLOAD_COMMAND_MAX_BYTES, limits.maxTaskBytes)
                  ? `These files would pass the ${formatUploadSize(Math.min(UPLOAD_COMMAND_MAX_BYTES, limits.maxTaskBytes))} one upload takes.`
                  : undefined);
        const key = `upload-${++counter.current}`;
        if (problem) {
          added.push({
            file,
            draft: {
              key,
              name,
              size: file.size,
              state: "failed",
              sent: 0,
              error: problem,
            },
          });
          continue;
        }
        count += 1;
        bytes += file.size;
        names.push(name);
        added.push({
          file,
          draft: { key, name, size: file.size, state: "uploading", sent: 0 },
        });
      }
      setDrafts((current) => [
        ...current,
        ...added.map((entry) => entry.draft),
      ]);
      for (const { draft, file } of added) {
        if (draft.state !== "uploading") continue;
        const controller = new AbortController();
        controllers.current.set(draft.key, controller);
        queue.current = queue.current.then(async () => {
          if (controller.signal.aborted) return;
          try {
            const upload = await api.stageUpload(file, draft.name, {
              signal: controller.signal,
              onProgress: (sent) => patch(draft.key, { sent }),
            });
            // Removed while it was on its way: it is not kept.
            if (controller.signal.aborted)
              await api.deleteUpload(upload.id).catch(() => {});
            else
              patch(draft.key, { state: "staged", sent: draft.size, upload });
          } catch (reason) {
            if (!(isApiError(reason) && reason.code === "ABORTED"))
              patch(draft.key, { state: "failed", error: message(reason) });
          } finally {
            controllers.current.delete(draft.key);
          }
        });
      }
    },
    [api, limits, patch],
  );

  const remove = useCallback(
    (key: string) => {
      const draft = draftsRef.current.find((entry) => entry.key === key);
      controllers.current.get(key)?.abort();
      if (draft?.upload) void api.deleteUpload(draft.upload.id).catch(() => {});
      setDrafts((current) => current.filter((entry) => entry.key !== key));
    },
    [api],
  );

  const discard = useCallback(() => {
    for (const controller of controllers.current.values()) controller.abort();
    for (const draft of draftsRef.current)
      if (draft.upload) void api.deleteUpload(draft.upload.id).catch(() => {});
    setDrafts([]);
  }, [api]);

  const clear = useCallback(() => setDrafts([]), []);

  const entries = useMemo<UploadEntry[]>(
    () =>
      drafts.flatMap((draft) =>
        draft.upload ? [{ uploadId: draft.upload.id }] : [],
      ),
    [drafts],
  );

  return {
    limits,
    drafts,
    entries,
    add,
    remove,
    discard,
    clear,
    uploading: drafts.some((draft) => draft.state === "uploading"),
    failed: drafts.some((draft) => draft.state === "failed"),
  };
}

export type UploadDrafts = ReturnType<typeof useUploadDrafts>;

/** What the server takes, in one line. */
export const limitsText = (limits: UploadLimits) =>
  `Up to ${limits.maxFiles} files of ${formatUploadSize(limits.maxFileBytes)} each, ${formatUploadSize(Math.min(UPLOAD_COMMAND_MAX_BYTES, limits.maxTaskBytes))} in all. They go into uploads/ in the task's workspace before the coordinator starts.`;

/**
 * The New task dialog's files: a drop zone with a file picker, the limits,
 * and each file with its size, progress, error and a remove button.
 */
export function UploadField({
  uploads,
  disabled = false,
}: {
  uploads: UploadDrafts;
  disabled?: boolean;
}) {
  const hintId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const { limits } = uploads;
  if (!limits) return null;
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setOver(false);
    if (!disabled) uploads.add([...event.dataTransfer.files]);
  };
  return (
    <div className="upload-field">
      <div
        className="upload-field__zone"
        data-over={over || undefined}
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <span className="upload-field__lead">Drop files here, or</span>
        <Button
          size="sm"
          disabled={disabled}
          aria-describedby={hintId}
          onClick={() => input.current?.click()}
        >
          Choose files
        </Button>
        <FileInput ref={input} label="Files to upload" onFiles={uploads.add} />
      </div>
      <p id={hintId} className="upload-field__hint">
        {limitsText(limits)}
      </p>
      <UploadDraftList uploads={uploads} disabled={disabled} />
    </div>
  );
}

/** The browser's file picker, hidden: a button opens it, a drop fills it. */
export function FileInput({
  ref,
  label,
  onFiles,
}: {
  ref: Ref<HTMLInputElement>;
  label: string;
  onFiles: (files: File[]) => void;
}) {
  return (
    <input
      ref={ref}
      type="file"
      multiple
      hidden
      tabIndex={-1}
      aria-label={label}
      onChange={(event) => {
        onFiles([...(event.target.files ?? [])]);
        event.target.value = "";
      }}
    />
  );
}

/** The picked files: name, size, progress or error, and a remove button. */
export function UploadDraftList({
  uploads,
  disabled = false,
}: {
  uploads: UploadDrafts;
  disabled?: boolean;
}) {
  if (uploads.drafts.length === 0) return null;
  return (
    <ul className="upload-drafts" aria-label="Files to upload">
      {uploads.drafts.map((draft) => (
        <li key={draft.key} className="upload-draft" data-state={draft.state}>
          <span className="upload-draft__text">
            <span className="upload-draft__name clamp1" title={draft.name}>
              {draft.name}
            </span>
            <span className="upload-draft__meta">
              {formatUploadSize(draft.size)}
              {draft.state === "uploading" &&
                ` · uploading ${Math.round((100 * draft.sent) / Math.max(draft.size, 1))}%`}
              {draft.state === "staged" && " · ready"}
            </span>
            {draft.state === "uploading" && (
              <progress
                className="upload-draft__progress"
                max={Math.max(draft.size, 1)}
                value={draft.sent}
                aria-label={`Uploading ${draft.name}`}
              />
            )}
            {draft.state === "failed" && (
              <span className="upload-draft__error" role="alert">
                <span className="upload-draft__error-word">Not uploaded</span>{" "}
                {draft.error}
              </span>
            )}
          </span>
          <IconButton
            label={`Remove ${draft.name}`}
            icon={<Icon name="close" size={14} />}
            disabled={disabled}
            onClick={() => uploads.remove(draft.key)}
          />
        </li>
      ))}
    </ul>
  );
}

/** Removes the staged files left unsent when the page closes, or when `key` changes. */
export function useDiscardOnUnmount(uploads: UploadDrafts, key?: string) {
  const discard = useRef(uploads.discard);
  discard.current = uploads.discard;
  useEffect(() => () => discard.current(), [key]);
}
