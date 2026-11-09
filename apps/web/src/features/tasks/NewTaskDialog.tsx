import { profileBudgetsSchema } from "@jj/contracts";
import { type FormEvent, useId, useState } from "react";
import { useApi } from "../../api/ApiContext";
import {
  Button,
  Dialog,
  ErrorBanner,
  Input,
  SectionLabel,
  Textarea,
} from "../../components/ui";
import { useWorkspace } from "../../state/WorkspaceContext";
import { ChecksEditor } from "./ChecksEditor";
import { type CheckDraft, planFromDrafts } from "./checkDrafts";
import { formatCap } from "./format";
import { readCapInput } from "./SpendControl";
import { rosterOf, TeamPicker } from "./TeamPicker";
import { UploadField, useDiscardOnUnmount, useUploadDrafts } from "./uploads";
import "./tasks.css";

export interface NewTaskDialogProps {
  /** Preselected bots; the first coordinates. */
  initialBotIds: string[];
  onClose: () => void;
}

/**
 * Starts a task: the goal, the coordinator who plans and delegates, and any
 * number of other participants, and, where the server enforces them,
 * optional verification checks, and where it takes them, files to upload
 * into the workspace. On success the task opens; a dialog closed unsent
 * removes the files it staged.
 */
export function NewTaskDialog({ initialBotIds, onClose }: NewTaskDialogProps) {
  const { bots, profiles, createTask } = useWorkspace();
  const api = useApi();
  const formId = useId();
  const checksLabelId = useId();
  const filesLabelId = useId();
  const uploads = useUploadDrafts();
  useDiscardOnUnmount(uploads);
  const [drafts, setDrafts] = useState<CheckDraft[]>([]);
  const [checkErrors, setCheckErrors] = useState<Record<string, string>>({});
  const known = initialBotIds.filter((botId) =>
    bots.some((bot) => bot.id === botId),
  );
  const [goal, setGoal] = useState("");
  const [coordinatorId, setCoordinatorId] = useState(
    () => known[0] ?? bots[0]?.id ?? "",
  );
  const [others, setOthers] = useState<string[]>(() => known.slice(1));
  /** Null until edited: the coordinator's profile's cap applies. */
  const [capText, setCapText] = useState<string | null>(null);
  const [capError, setCapError] = useState<string | null>(null);
  // As the server picks it: the coordinator's profile, else the default one.
  const coordinator = bots.find((bot) => bot.id === coordinatorId);
  const profile = coordinator?.runtimeProfileId
    ? profiles.find((entry) => entry.id === coordinator.runtimeProfileId)
    : profiles.find((entry) => entry.isDefault);
  const profileCap = (profile?.budgets ?? profileBudgetsSchema.parse({}))
    .maxUsdPerTask;
  const capValue = capText ?? (profileCap === null ? "" : String(profileCap));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const participants = rosterOf(coordinatorId, others);
  const canStart =
    goal.trim().length > 0 &&
    Boolean(coordinatorId) &&
    !busy &&
    !uploads.uploading &&
    !uploads.failed;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canStart) return;
    const checks = planFromDrafts(drafts);
    const cap = readCapInput(capValue);
    if (!checks.ok) setCheckErrors(checks.errors);
    else setCheckErrors({});
    if (!cap.ok) setCapError(cap.error);
    else setCapError(null);
    if (!checks.ok || !cap.ok) return;
    setBusy(true);
    setError(null);
    try {
      await createTask({
        goal: goal.trim(),
        participantBotIds: participants,
        verificationPlan: checks.plan,
        // An untouched field leaves the cap to the server (the profile's).
        ...(capText !== null ? { spendCapUsd: cap.value } : {}),
        ...(uploads.entries.length > 0 ? { uploads: uploads.entries } : {}),
      });
      // Attached now: nothing staged is left to remove.
      uploads.clear();
      onClose();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Could not start the task.",
      );
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      title="New task"
      description="Describe the goal and pick the team. The coordinator plans the work and delegates to the others; everyone sees the whole chat."
      dismissible={
        !goal.trim() && drafts.length === 0 && uploads.drafts.length === 0
      }
      width={drafts.length > 0 ? 600 : 520}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            disabled={!canStart}
          >
            {busy ? "Starting…" : "Start task"}
          </Button>
        </>
      }
    >
      {bots.length === 0 ? (
        <p className="new-task-form__note">
          Create a bot first: a task needs at least a coordinator.
        </p>
      ) : (
        <form
          id={formId}
          className="new-task-form"
          onSubmit={submit}
          noValidate
        >
          <Textarea
            label="Goal"
            value={goal}
            rows={3}
            required
            placeholder="What should the bots accomplish?"
            onChange={(event) => setGoal(event.target.value)}
          />
          <TeamPicker
            bots={bots}
            coordinatorId={coordinatorId}
            onCoordinator={setCoordinatorId}
            others={others}
            onOthers={setOthers}
          />
          <Input
            label="Spend cap (USD)"
            type="number"
            inputMode="decimal"
            step="any"
            min={0}
            placeholder="No cap"
            hint={`No model call starts once the task's priced spend reaches it. Empty for no cap. ${
              profileCap === null
                ? "The coordinator's profile sets none."
                : `The coordinator's profile sets ${formatCap(profileCap)}.`
            }`}
            error={capError ?? undefined}
            value={capValue}
            onChange={(event) => setCapText(event.target.value)}
          />
          {uploads.limits && (
            <div className="new-task-form__files">
              <SectionLabel id={filesLabelId} tracking="part">
                Files · optional
              </SectionLabel>
              <div role="group" aria-labelledby={filesLabelId}>
                <UploadField uploads={uploads} disabled={busy} />
              </div>
            </div>
          )}
          {api.capabilities.verification && (
            <div className="new-task-form__checks">
              <SectionLabel id={checksLabelId} tracking="part">
                Checks · optional
              </SectionLabel>
              <div role="group" aria-labelledby={checksLabelId}>
                <ChecksEditor
                  drafts={drafts}
                  onChange={(next) => {
                    // An edit answers the problems shown; submitting checks again.
                    setDrafts(next);
                    setCheckErrors({});
                  }}
                  errors={checkErrors}
                  disabled={busy}
                />
              </div>
            </div>
          )}
          {uploads.failed && (
            <p className="new-task-form__note" role="status">
              Remove the files that did not upload to start the task.
            </p>
          )}
          {error && <ErrorBanner word="Not started">{error}</ErrorBanner>}
        </form>
      )}
    </Dialog>
  );
}
