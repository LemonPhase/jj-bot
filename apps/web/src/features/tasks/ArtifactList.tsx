import type { Artifact, TaskView } from "@jj/contracts";
import { useId, useState } from "react";
import { useApi } from "../../api/ApiContext";
import { Button, buttonClass, SectionLabel } from "../../components/ui";
import { useWorkspace } from "../../state/WorkspaceContext";
import { formatBytes } from "./format";
import { botName } from "./taskModel";
import { useOrdinals } from "./useTaskModel";

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
  const ordinals = useOrdinals(view);
  // Events over the payload cap, saved whole: not tool output.
  const savedEvents = new Set(
    view.events.flatMap((event) =>
      event.payloadArtifactId ? [event.payloadArtifactId] : [],
    ),
  );
  return (
    <ul className="artifacts__list">
      {artifacts.map((artifact) => {
        const session = view.sessions.find((s) => s.id === artifact.sessionId);
        const producer = session
          ? `${botName(getBot(session.botId))} · ${ordinals.get(session.id) ?? "s-?"}`
          : "task";
        return (
          <li key={artifact.id} className="artifact">
            <span className="artifact__text">
              <span className="artifact__name clamp1" title={artifact.path}>
                {artifact.name}
              </span>
              <span className="artifact__meta clamp1">
                {formatBytes(artifact.sizeBytes)} · {producer}
                {artifact.kind !== "output"
                  ? ""
                  : savedEvents.has(artifact.id)
                    ? " · saved event"
                    : " · tool output"}
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
 * from a blob instead. `text` replaces the "Download" it reads.
 */
export function ArtifactDownload({
  taskId,
  artifact,
  text = "Download",
}: {
  taskId: string;
  artifact: Artifact;
  text?: string;
}) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const label =
    text === "Download"
      ? `Download ${artifact.name}`
      : `${text}: ${artifact.name}`;

  if (!api.fetchArtifact)
    return (
      <a
        className={buttonClass({ size: "sm" })}
        href={api.artifactUrl(taskId, artifact.id)}
        download={artifact.name}
        aria-label={label}
      >
        {text}
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
        {busy ? "Downloading…" : text}
      </Button>
      {failure && (
        <span className="artifact__error" role="alert">
          <span className="artifact__error-word">Failed</span> {failure}
        </span>
      )}
    </span>
  );
}

/**
 * The saved copy of an event that was over the payload cap: its whole
 * payload, as JSON. The view's records are whole; this is the event as sent.
 */
export function SavedCopy({
  view,
  artifactId,
}: {
  view: TaskView;
  artifactId: string;
}) {
  const artifact = view.artifacts.find((entry) => entry.id === artifactId);
  if (!artifact) return null;
  return (
    <span className="saved-copy">
      <ArtifactDownload
        taskId={view.task.id}
        artifact={artifact}
        text="Large: open the saved copy"
      />
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
