// The task chat's view of uploaded files: the announcement as a card with a
// chip per file. Kept apart from uploads.tsx, which the New task dialog
// loads with the first screen, so the chat's download code stays with it.
import {
  type Artifact,
  formatUploadSize,
  type TaskMessage,
} from "@jj/contracts";
import { useId } from "react";
import { formatMessageTime } from "../../lib/format";
import { ArtifactDownload } from "./ArtifactList";

/** Where an uploaded file stands, as its chip says it. */
export function uploadStateText(artifact: Artifact): string {
  switch (artifact.upload?.state) {
    case "placed":
      return `In workspace · ${artifact.path}`;
    case "failed":
      return `Not placed: ${artifact.upload.error ?? "the workspace refused it"}`;
    default:
      return "Waiting for the next run";
  }
}

/**
 * The announcement of files the user uploaded, where it is in the chat: a
 * chip per file with where it stands, and its download.
 */
export function UploadCard({
  taskId,
  message: announcement,
  files,
}: {
  taskId: string;
  message: TaskMessage;
  files: readonly Artifact[];
}) {
  const labelId = useId();
  return (
    <article
      className="task-msg task-msg--user upload-card"
      aria-labelledby={labelId}
    >
      <span className="task-msg__meta">
        <span id={labelId}>
          You uploaded {files.length === 1 ? "1 file" : `${files.length} files`}
        </span>
        <time className="task-msg__time" dateTime={announcement.createdAt}>
          {formatMessageTime(announcement.createdAt)}
        </time>
      </span>
      <ul className="upload-card__files">
        {files.map((file) => (
          <li
            key={file.id}
            className="upload-chip"
            data-state={file.upload?.state ?? "pending"}
          >
            <span className="upload-chip__text">
              <span className="upload-chip__name clamp1" title={file.path}>
                {file.name}
                <span className="upload-chip__size">
                  {" "}
                  · {formatUploadSize(file.sizeBytes)}
                </span>
              </span>
              <span
                className="upload-chip__state clamp1"
                title={uploadStateText(file)}
              >
                {uploadStateText(file)}
              </span>
            </span>
            <ArtifactDownload taskId={taskId} artifact={file} />
          </li>
        ))}
      </ul>
    </article>
  );
}

/** The task's uploaded files by the announcement that attached them. */
export function uploadsByMessage(
  artifacts: readonly Artifact[],
): Map<string, Artifact[]> {
  const groups = new Map<string, Artifact[]>();
  for (const artifact of artifacts) {
    const messageId = artifact.upload?.messageId;
    if (!messageId) continue;
    groups.set(messageId, [...(groups.get(messageId) ?? []), artifact]);
  }
  return groups;
}
