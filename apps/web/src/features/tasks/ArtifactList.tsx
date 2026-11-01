import type { Artifact, TaskView } from "@jj/contracts";
import { useId, useState } from "react";
import { useApi } from "../../api/ApiContext";
import { Button, buttonClass, SectionLabel } from "../../components/ui";
import { sessionOrdinal } from "../../lib/tasks";
import { useWorkspace } from "../../state/WorkspaceContext";
import { formatBytes } from "./format";
import { botName } from "./taskModel";

/** The task's files (SPEC: not designed; built in the panel's language). Hidden when there are none. */
export function ArtifactList({ view }: { view: TaskView }) {
  const labelId = useId();
  if (view.artifacts.length === 0) return null;
  return (
    <section className="artifacts" aria-labelledby={labelId}>
      <SectionLabel as="h2" id={labelId}>
        Artifacts · {view.artifacts.length}
      </SectionLabel>
      <ArtifactRows view={view} artifacts={view.artifacts} />
    </section>
  );
}

/** One row per file: name, size and who produced it, and a download control. */
export function ArtifactRows({
  view,
  artifacts,
}: {
  view: TaskView;
  artifacts: readonly Artifact[];
}) {
  const { getBot } = useWorkspace();
  return (
    <ul className="artifacts__list">
      {artifacts.map((artifact) => {
        const session = view.sessions.find((s) => s.id === artifact.sessionId);
        const producer = session
          ? `${botName(getBot(session.botId))} · ${sessionOrdinal(view, session.id)}`
          : "task";
        return (
          <li key={artifact.id} className="artifact">
            <span className="artifact__text">
              <span className="artifact__name clamp1" title={artifact.path}>
                {artifact.name}
              </span>
              <span className="artifact__meta clamp1">
                {formatBytes(artifact.sizeBytes)} · {producer}
                {artifact.kind === "output" ? " · tool output" : ""}
              </span>
            </span>
            <ArtifactDownload taskId={view.task.id} artifact={artifact} />
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A plain link when the API needs no token. With a token the link could not
 * send the Authorization header, so the content is fetched with it and saved
 * from a blob instead.
 */
function ArtifactDownload({
  taskId,
  artifact,
}: {
  taskId: string;
  artifact: Artifact;
}) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const label = `Download ${artifact.name}`;

  if (!api.fetchArtifact)
    return (
      <a
        className={buttonClass({ size: "sm" })}
        href={api.artifactUrl(taskId, artifact.id)}
        download={artifact.name}
        aria-label={label}
      >
        Download
      </a>
    );

  const fetchArtifact = api.fetchArtifact;
  const download = async () => {
    setBusy(true);
    setFailure(null);
    try {
      saveBlob(await fetchArtifact(taskId, artifact.id), artifact.name);
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="artifact__action">
      <Button
        size="sm"
        aria-label={label}
        disabled={busy}
        onClick={() => void download()}
      >
        {busy ? "Downloading…" : "Download"}
      </Button>
      {failure && (
        <span className="artifact__error" role="alert">
          <span className="artifact__error-word">Failed</span> {failure}
        </span>
      )}
    </span>
  );
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  // Give the browser a moment to start the download before releasing it.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
