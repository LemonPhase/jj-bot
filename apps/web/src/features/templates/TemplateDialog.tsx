import {
  COMMAND_TEXT_LIMIT,
  PROFILE_SPEND_CAP,
  type TaskTemplate,
  TEMPLATE_INSTRUCTIONS_HEADING,
  TEMPLATE_INSTRUCTIONS_LIMIT,
  templateRunGoal,
} from "@jj/contracts";
import { type FormEvent, useId, useState } from "react";
import { useApi } from "../../api/ApiContext";
import {
  Button,
  Dialog,
  ErrorBanner,
  Input,
  SectionLabel,
  Segmented,
  Textarea,
} from "../../components/ui";
import { useWorkspace } from "../../state/WorkspaceContext";
import { type TemplateDialogRequest, useShell } from "../shell/ShellContext";
import { ChecksEditor } from "../tasks/ChecksEditor";
import { readCapInput } from "../tasks/SpendControl";
import { rosterOf, TeamPicker } from "../tasks/TeamPicker";
import {
  type CheckDraft,
  draftsFromPlan,
  planFromDrafts,
} from "../tasks/verification";
import {
  blankDraft,
  type CapChoice,
  draftFromTask,
  draftFromTemplate,
  problemLines,
  profileCapOf,
  resolvedCapLine,
  type TemplateDraft,
  teamLine,
} from "./templateModel";
import "./templates.css";

const reasonOf = (reason: unknown, fallback: string) =>
  reason instanceof Error ? reason.message : fallback;

/**
 * The task template dialogs, loaded on demand: the editor (new, from a task,
 * or editing one), the start dialog and the delete confirmation.
 */
export default function TemplateDialog({
  request,
  onClose,
}: {
  request: TemplateDialogRequest;
  onClose: () => void;
}) {
  const { templates, taskViews } = useWorkspace();
  if (request.kind === "new") {
    const view = request.fromTaskId ? taskViews[request.fromTaskId] : undefined;
    return (
      <TemplateEditor
        source={view ? { kind: "task", task: view.task } : { kind: "blank" }}
        onClose={onClose}
      />
    );
  }
  const template = templates?.find((entry) => entry.id === request.templateId);
  if (!template) return <TemplateGone onClose={onClose} />;
  switch (request.kind) {
    case "edit":
      return (
        <TemplateEditor
          source={{ kind: "template", template }}
          onClose={onClose}
        />
      );
    case "start":
      return <StartTemplateDialog template={template} onClose={onClose} />;
    case "delete":
      return <DeleteTemplateDialog template={template} onClose={onClose} />;
  }
}

/** The template was deleted, here or elsewhere, before its dialog opened. */
function TemplateGone({ onClose }: { onClose: () => void }) {
  return (
    <Dialog
      open
      onClose={onClose}
      title="Template not found"
      description="It was deleted. Tasks started from it are kept."
      footer={<Button onClick={onClose}>Close</Button>}
    />
  );
}

type EditorSource =
  | { kind: "blank" }
  | { kind: "task"; task: Parameters<typeof draftFromTask>[0] }
  | { kind: "template"; template: TaskTemplate };

const CAP_OPTIONS: { value: CapChoice; label: string }[] = [
  { value: "profile", label: "Profile's" },
  { value: "none", label: "No cap" },
  { value: "amount", label: "Amount" },
];

/**
 * Saves a template: the New task fields with a title, and a cap that is the
 * coordinator's profile's at start, none, or an amount. Archived bots a
 * template still names are left out when it is saved, and said so.
 */
function TemplateEditor({
  source,
  onClose,
}: {
  source: EditorSource;
  onClose: () => void;
}) {
  const { bots, profiles, createTemplate, updateTemplate } = useWorkspace();
  const api = useApi();
  const formId = useId();
  const checksLabelId = useId();
  const capHintId = useId();
  const [initial] = useState<TemplateDraft>(() =>
    source.kind === "template"
      ? draftFromTemplate(source.template)
      : source.kind === "task"
        ? draftFromTask(
            source.task,
            profileCapOf(source.task.coordinatorBotId, bots, profiles),
          )
        : blankDraft(bots),
  );
  const active = (botId: string) => bots.some((bot) => bot.id === botId);
  const [title, setTitle] = useState(initial.title);
  const [goal, setGoal] = useState(initial.goal);
  const [coordinatorId, setCoordinatorId] = useState(() =>
    active(initial.coordinatorId) ? initial.coordinatorId : (bots[0]?.id ?? ""),
  );
  const [others, setOthers] = useState(() => initial.others.filter(active));
  const left = [initial.coordinatorId, ...initial.others].filter(
    (botId) => botId && !active(botId),
  );
  const [cap, setCap] = useState<CapChoice>(initial.cap);
  const [capText, setCapText] = useState(initial.capText);
  const [drafts, setDrafts] = useState<CheckDraft[]>(() =>
    draftsFromPlan(initial.plan),
  );
  const [checkErrors, setCheckErrors] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<{
    title?: string;
    goal?: string;
    cap?: string;
  }>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editing = source.kind === "template";
  // Without enforcement the checks cannot be edited here; a stored plan is kept.
  const checksShown = api.capabilities.verification;
  const archivedNames =
    source.kind === "template"
      ? source.template.problems.flatMap((problem) =>
          problem.kind === "bot_archived" ? [problem.name] : [],
        )
      : [];

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const found: typeof errors = {};
    if (!title.trim()) found.title = "Give the template a title.";
    else if (title.trim().length > 120)
      found.title = "Keep the title to 120 characters.";
    if (!goal.trim()) found.goal = "Describe the goal.";
    let spendCapUsd: number | null | undefined;
    if (cap === "none") spendCapUsd = null;
    else if (cap === "amount") {
      const read = readCapInput(capText);
      if (!read.ok) found.cap = read.error;
      else if (read.value === null) found.cap = "Enter an amount.";
      else spendCapUsd = read.value;
    }
    const checks = checksShown
      ? planFromDrafts(drafts)
      : { ok: true as const, plan: initial.plan };
    setCheckErrors(checks.ok ? {} : checks.errors);
    setErrors(found);
    if (Object.keys(found).length > 0 || !checks.ok || !coordinatorId) return;
    const fields = {
      title: title.trim(),
      goal: goal.trim(),
      coordinatorBotId: coordinatorId,
      participantBotIds: rosterOf(coordinatorId, others),
      verificationPlan: checks.plan,
    };
    setBusy(true);
    setError(null);
    try {
      if (source.kind === "template")
        await updateTemplate(source.template.id, {
          ...fields,
          spendCapUsd: cap === "profile" ? PROFILE_SPEND_CAP : spendCapUsd,
        });
      else
        await createTemplate({
          ...fields,
          ...(cap === "profile" ? {} : { spendCapUsd }),
        });
      onClose();
    } catch (reason) {
      setError(reasonOf(reason, "Could not save the template."));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      title={editing ? "Edit template" : "New template"}
      description={
        source.kind === "task"
          ? "Saved from this task as it is now: its goal, team, checks and cap (the profile's, when the task has the cap its profile sets). Start it again from the Templates list."
          : "A task setup to start again in one step: its goal, team, checks and cap."
      }
      dismissible={false}
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
            disabled={busy || bots.length === 0}
          >
            {busy ? "Saving…" : "Save template"}
          </Button>
        </>
      }
    >
      {bots.length === 0 ? (
        <p className="new-task-form__note">
          Create a bot first: a template needs at least a coordinator.
        </p>
      ) : (
        <form
          id={formId}
          className="new-task-form"
          onSubmit={submit}
          noValidate
        >
          <Input
            label="Title"
            value={title}
            required
            maxLength={120}
            placeholder="Weekly report"
            error={errors.title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <Textarea
            label="Goal"
            value={goal}
            rows={3}
            required
            maxLength={COMMAND_TEXT_LIMIT}
            placeholder="What should the bots accomplish each time?"
            error={errors.goal}
            onChange={(event) => setGoal(event.target.value)}
          />
          <TeamPicker
            bots={bots}
            coordinatorId={coordinatorId}
            onCoordinator={setCoordinatorId}
            others={others}
            onOthers={setOthers}
          />
          {left.length > 0 && (
            <p className="template-editor__note" role="note">
              {archivedNames.length > 0
                ? `${archivedNames.join(", ")} ${archivedNames.length === 1 ? "is" : "are"} archived and left out when you save.`
                : "Archived bots are left out when you save."}
            </p>
          )}
          <div className="template-editor__cap">
            <SectionLabel tracking="part">Spend cap</SectionLabel>
            <Segmented
              label="Spend cap"
              variant="compact"
              value={cap}
              onChange={setCap}
              options={CAP_OPTIONS}
              describedBy={capHintId}
            />
            {cap === "amount" && (
              <Input
                label="Cap (USD)"
                type="number"
                inputMode="decimal"
                step="any"
                min={0}
                value={capText}
                error={errors.cap}
                onChange={(event) => setCapText(event.target.value)}
              />
            )}
            <p id={capHintId} className="ui-field__hint">
              {cap === "profile"
                ? "Each task takes the coordinator's profile's cap when it starts."
                : cap === "none"
                  ? "Tasks from this template have no cap."
                  : "Each task starts with this cap."}
            </p>
          </div>
          {checksShown && (
            <div className="new-task-form__checks">
              <SectionLabel id={checksLabelId} tracking="part">
                Checks · optional
              </SectionLabel>
              <div role="group" aria-labelledby={checksLabelId}>
                <ChecksEditor
                  drafts={drafts}
                  onChange={(next) => {
                    setDrafts(next);
                    setCheckErrors({});
                  }}
                  errors={checkErrors}
                  disabled={busy}
                />
              </div>
            </div>
          )}
          {error && <ErrorBanner word="Not saved">{error}</ErrorBanner>}
        </form>
      )}
    </Dialog>
  );
}

/**
 * Starts a task from a template, optionally with instructions for this run
 * (added to the goal) and its own title. It shows the cap the task will get
 * and, while the template has problems, why it cannot start.
 */
function StartTemplateDialog({
  template,
  onClose,
}: {
  template: TaskTemplate;
  onClose: () => void;
}) {
  const { bots, profiles, getBot, startTemplate } = useWorkspace();
  const { openTemplateDialog } = useShell();
  const formId = useId();
  const [instructions, setInstructions] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problems = problemLines(template.problems);
  const trimmed = instructions.trim();
  const tooLong =
    templateRunGoal(template.goal, trimmed || undefined).length >
    COMMAND_TEXT_LIMIT;
  const titleTooLong = title.trim().length > 120;
  const canStart = problems.length === 0 && !busy && !tooLong && !titleTooLong;
  const nameOf = (botId: string) => getBot(botId)?.name ?? "an archived bot";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canStart) return;
    setBusy(true);
    setError(null);
    try {
      await startTemplate(template.id, {
        ...(trimmed ? { instructions: trimmed } : {}),
        ...(title.trim() ? { title: title.trim() } : {}),
      });
      onClose();
    } catch (reason) {
      setError(reasonOf(reason, "Could not start the task."));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      title={`Start: ${template.title}`}
      description="A new task with the template's goal, team, checks and cap."
      dismissible={!instructions.trim() && !title.trim()}
      width={520}
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
      <form id={formId} className="new-task-form" onSubmit={submit} noValidate>
        <dl className="template-start__facts">
          <dt>Goal</dt>
          <dd className="template-start__goal">{template.goal}</dd>
          <dt>Team</dt>
          <dd>{teamLine(template, nameOf)}</dd>
          <dt>Checks</dt>
          <dd>
            {template.verificationPlan
              ? `${template.verificationPlan.length} · the task completes only when every one passes`
              : "None"}
          </dd>
          <dt>Spend cap</dt>
          <dd>{resolvedCapLine(template, bots, profiles)}</dd>
        </dl>
        {problems.length > 0 ? (
          <div className="template-start__problems">
            <ErrorBanner word="Can't start">{problems.join(" ")}</ErrorBanner>
            <Button
              size="sm"
              onClick={() =>
                openTemplateDialog({ kind: "edit", templateId: template.id })
              }
            >
              Edit template
            </Button>
          </div>
        ) : (
          <>
            <Textarea
              label="Instructions for this run"
              note="optional"
              value={instructions}
              rows={3}
              maxLength={TEMPLATE_INSTRUCTIONS_LIMIT}
              placeholder="Anything this run should do differently"
              hint={`Added to the goal under “${TEMPLATE_INSTRUCTIONS_HEADING}”.`}
              error={
                tooLong
                  ? `With these instructions the goal is over ${COMMAND_TEXT_LIMIT} characters; shorten them.`
                  : undefined
              }
              onChange={(event) => setInstructions(event.target.value)}
            />
            <Input
              label="Task title"
              note="optional"
              value={title}
              maxLength={120}
              placeholder={template.title}
              hint="Empty: the template's title."
              error={
                titleTooLong ? "Keep the title to 120 characters." : undefined
              }
              onChange={(event) => setTitle(event.target.value)}
            />
          </>
        )}
        {error && <ErrorBanner word="Not started">{error}</ErrorBanner>}
      </form>
    </Dialog>
  );
}

/** Deletes a template after a confirmation; its tasks are kept. */
function DeleteTemplateDialog({
  template,
  onClose,
}: {
  template: TaskTemplate;
  onClose: () => void;
}) {
  const { deleteTemplate } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteTemplate(template.id);
      onClose();
    } catch (reason) {
      setError(reasonOf(reason, "Could not delete the template."));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      title={`Delete “${template.title}”?`}
      description="Tasks started from it are kept, and still say which template they came from."
      width={440}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Keep it
          </Button>
          <Button
            variant="danger"
            onClick={() => void remove()}
            disabled={busy}
          >
            {busy ? "Deleting…" : "Delete template"}
          </Button>
        </>
      }
    >
      {error && <ErrorBanner word="Not deleted">{error}</ErrorBanner>}
    </Dialog>
  );
}
