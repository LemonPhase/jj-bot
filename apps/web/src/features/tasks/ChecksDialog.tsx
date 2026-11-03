import type { TaskView } from "@jj/contracts";
import { type FormEvent, useId, useState } from "react";
import type { ApiError } from "../../api/client";
import { Button, Dialog, ErrorBanner, Textarea } from "../../components/ui";
import { useWorkspace } from "../../state/WorkspaceContext";
import { ChecksEditor } from "./ChecksEditor";
import { draftsFromPlan, planFromDrafts } from "./verification";

/**
 * Changes a task's verification plan. The change is a message to the
 * coordinator that starts a new goal version (v n+1): evidence gathered for
 * earlier versions no longer counts, and the task completes only when every
 * new check passes. Removing every check removes the plan.
 */
export function ChecksDialog({
  view,
  onClose,
}: {
  view: TaskView;
  onClose: () => void;
}) {
  const { postTaskMessage, retryTask } = useWorkspace();
  const formId = useId();
  const { task } = view;
  const [drafts, setDrafts] = useState(() =>
    draftsFromPlan(task.verificationPlan),
  );
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const next = task.goalVersion + 1;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const built = planFromDrafts(drafts);
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setErrors({});
    setBusy(true);
    setFailure(null);
    const text =
      note.trim() ||
      (built.plan
        ? "I changed the verification checks."
        : "I removed the verification checks.");
    const result = await postTaskMessage(task.id, text, false, built.plan);
    if (result.ok) onClose();
    else {
      setFailure(result.error);
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      title="Verification checks"
      description={`The task completes only when every check passes. Saving starts goal v${next}: earlier evidence no longer counts. Only you set the checks; bots cannot change them.`}
      width={600}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary" disabled={busy}>
            {busy ? "Saving…" : `Save as goal v${next}`}
          </Button>
        </>
      }
    >
      <form id={formId} className="new-task-form" onSubmit={submit}>
        <ChecksEditor
          drafts={drafts}
          onChange={(next) => {
            setDrafts(next);
            setErrors({});
          }}
          errors={errors}
          disabled={busy}
        />
        <Textarea
          label="Note to the coordinator"
          value={note}
          rows={2}
          placeholder="Optional: why the checks changed"
          disabled={busy}
          onChange={(event) => setNote(event.target.value)}
        />
        {failure &&
          (failure.code === "STALE_GOAL_VERSION" ? (
            <ErrorBanner word="Goal changed" onDismiss={() => setFailure(null)}>
              The goal changed since you opened this, so the checks were not
              saved. Refresh, then edit the checks again.{" "}
              <button
                type="button"
                className="text-link"
                onClick={() => {
                  retryTask();
                  onClose();
                }}
              >
                Refresh
              </button>
            </ErrorBanner>
          ) : (
            <ErrorBanner word="Not saved" onDismiss={() => setFailure(null)}>
              {failure.message}
            </ErrorBanner>
          ))}
      </form>
    </Dialog>
  );
}
