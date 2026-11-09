import {
  type ChatUpdates,
  DEFAULT_KEEP_WORKSPACES,
  MAX_KEEP_WORKSPACES,
  SCHEDULE_NAME_LIMIT,
  type Schedule,
  TEMPLATE_INSTRUCTIONS_LIMIT,
  type UpdateScheduleCommand,
} from "@jj/contracts";
import { type FormEvent, useId, useMemo, useState } from "react";
import {
  Button,
  Dialog,
  ErrorBanner,
  Input,
  SectionLabel,
  Segmented,
  Select,
  Textarea,
} from "../../components/ui";
import { useWorkspace } from "../../state/WorkspaceContext";
import type { ScheduleDialogRequest } from "../shell/ShellContext";
import { problemLines } from "../templates/templateModel";
import {
  browserTimeZone,
  formatRun,
  knownTimeZones,
  PRESETS,
  type PresetValue,
  pausedLine,
  presetOf,
  uncappedTemplate,
} from "./scheduleModel";
import { previewTrigger, sameTrigger } from "./scheduleTimes";
import "./schedules.css";

const reasonOf = (reason: unknown, fallback: string) =>
  reason instanceof Error ? reason.message : fallback;

/** The server's minimum interval before the list has loaded: the default. */
const DEFAULT_MIN_INTERVAL = 60;

const PRESET_OPTIONS: { value: PresetValue; label: string }[] = [
  ...PRESETS.map((preset) => ({ value: preset.value, label: preset.label })),
  { value: "custom", label: "Custom" },
];

const CHAT_OPTIONS: { value: ChatUpdates; label: string }[] = [
  { value: "attention", label: "When it needs me" },
  { value: "all", label: "Every update" },
];

/** The schedule dialogs, loaded on demand: the editor and the delete confirmation. */
export default function ScheduleDialog({
  request,
  onClose,
}: {
  request: ScheduleDialogRequest;
  onClose: () => void;
}) {
  const { schedules } = useWorkspace();
  if (request.kind === "new")
    return (
      <ScheduleEditor
        schedule={undefined}
        templateId={request.templateId}
        onClose={onClose}
      />
    );
  const schedule = schedules?.schedules.find(
    (entry) => entry.id === request.scheduleId,
  );
  if (!schedule)
    return (
      <Dialog
        open
        onClose={onClose}
        title="Schedule not found"
        description="It was deleted. Tasks it started are kept."
        footer={<Button onClick={onClose}>Close</Button>}
      />
    );
  return request.kind === "edit" ? (
    <ScheduleEditor schedule={schedule} onClose={onClose} />
  ) : (
    <DeleteScheduleDialog schedule={schedule} onClose={onClose} />
  );
}

/**
 * Saves a schedule: a template, when it runs (a preset or a cron
 * expression, in a time zone, previewed as its next 3 runs by the same
 * functions the server uses), the instructions each run adds, how many
 * finished runs keep their workspace, which chat updates it sends, and
 * whether it is on. An edit sends only what changed, and, as the server
 * checks only a changed trigger or template or a schedule turned on, saves
 * a rename or a turn-off while the preview shows a problem with times that
 * stay as they are. The server's refusals are shown as they come.
 */
function ScheduleEditor({
  schedule,
  templateId,
  onClose,
}: {
  schedule: Schedule | undefined;
  templateId?: string;
  onClose: () => void;
}) {
  const {
    templates,
    schedules,
    bots,
    profiles,
    createSchedule,
    updateSchedule,
  } = useWorkspace();
  const formId = useId();
  const zonesId = useId();
  const runsId = useId();
  const list = templates ?? [];
  const [chosen, setChosen] = useState(
    schedule?.templateId ?? templateId ?? list[0]?.id ?? "",
  );
  const template = list.find((entry) => entry.id === chosen);
  const [name, setName] = useState(
    schedule?.name ??
      (template ? template.title.slice(0, SCHEDULE_NAME_LIMIT) : ""),
  );
  const [cron, setCron] = useState(schedule?.trigger.cron ?? PRESETS[1].cron);
  const [timeZone, setTimeZone] = useState(
    schedule?.trigger.timeZone ?? browserTimeZone(),
  );
  const [instructions, setInstructions] = useState(
    schedule?.instructions ?? "",
  );
  const [keepText, setKeepText] = useState(
    String(schedule?.keepWorkspaces ?? DEFAULT_KEEP_WORKSPACES),
  );
  const [chatUpdates, setChatUpdates] = useState<ChatUpdates>(
    schedule?.chatUpdates ?? "attention",
  );
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true);
  const [errors, setErrors] = useState<{ name?: string; keep?: string }>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const zones = useMemo(knownTimeZones, []);
  const minInterval =
    schedules?.scheduler.minIntervalMinutes ?? DEFAULT_MIN_INTERVAL;
  const trigger = useMemo(
    () => ({ kind: "cron" as const, cron, timeZone: timeZone.trim() }),
    [cron, timeZone],
  );
  // The cron walk runs when the times change, not on every keystroke.
  const preview = useMemo(
    () => previewTrigger(trigger, new Date(), minInterval),
    [trigger, minInterval],
  );
  const preset = presetOf(cron);
  const triggerChanged = !schedule || !sameTrigger(trigger, schedule.trigger);
  const checked =
    !schedule ||
    triggerChanged ||
    chosen !== schedule.templateId ||
    (enabled && !schedule.enabled);
  const blocked = checked && Boolean(preview.problem);
  const templateProblems = template ? problemLines(template.problems) : [];
  const noCap = template ? uncappedTemplate(template, bots, profiles) : false;
  const paused =
    schedule?.pausedReason && !schedule.enabled
      ? schedule.pausedReason
      : undefined;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const found: typeof errors = {};
    if (!name.trim()) found.name = "Name the schedule.";
    const keep = Number(keepText);
    if (
      !Number.isInteger(keep) ||
      keep < 0 ||
      keep > MAX_KEEP_WORKSPACES ||
      keepText.trim() === ""
    )
      found.keep = `A whole number from 0 to ${MAX_KEEP_WORKSPACES}.`;
    setErrors(found);
    if (Object.keys(found).length > 0 || blocked || !template) return;
    const fields = {
      name: name.trim(),
      templateId: template.id,
      trigger,
      instructions: instructions.trim(),
      enabled,
      keepWorkspaces: keep,
      chatUpdates,
    };
    const patch: UpdateScheduleCommand = {};
    if (schedule) {
      if (fields.name !== schedule.name) patch.name = fields.name;
      if (fields.templateId !== schedule.templateId)
        patch.templateId = fields.templateId;
      if (triggerChanged) patch.trigger = trigger;
      if (fields.instructions !== schedule.instructions)
        patch.instructions = fields.instructions;
      if (enabled !== schedule.enabled) patch.enabled = enabled;
      if (keep !== schedule.keepWorkspaces) patch.keepWorkspaces = keep;
      if (chatUpdates !== schedule.chatUpdates) patch.chatUpdates = chatUpdates;
      if (Object.keys(patch).length === 0) {
        onClose();
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      if (schedule) await updateSchedule(schedule.id, patch);
      else await createSchedule(fields);
      onClose();
    } catch (reason) {
      setError(reasonOf(reason, "Could not save the schedule."));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      title={schedule ? "Edit schedule" : "New schedule"}
      description="Starts a task from a template on its own, at the times below. Runs start only while the server's worker runs; a time it misses by more than its grace is recorded as missed."
      dismissible={false}
      width={560}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            disabled={busy || !template || blocked}
          >
            {busy ? "Saving…" : "Save schedule"}
          </Button>
        </>
      }
    >
      {list.length === 0 ? (
        <p className="new-task-form__note">
          Save a template first: a schedule starts one.
        </p>
      ) : (
        <form
          id={formId}
          className="new-task-form"
          onSubmit={submit}
          noValidate
        >
          <Select
            label="Template"
            value={chosen}
            options={list.map((entry) => ({
              value: entry.id,
              label: entry.title,
            }))}
            onChange={setChosen}
            error={
              noCap
                ? "Tasks from this template have no spend cap, and a scheduled task needs one: give the template, or its coordinator's profile, a cap."
                : templateProblems.length > 0
                  ? `It cannot start now: ${templateProblems.join(" ")} A run refused for this pauses the schedule.`
                  : undefined
            }
          />
          <Input
            label="Name"
            value={name}
            required
            maxLength={SCHEDULE_NAME_LIMIT}
            placeholder="Morning digest"
            error={errors.name}
            onChange={(event) => setName(event.target.value)}
          />
          <div className="schedule-editor__when">
            <SectionLabel tracking="part">When</SectionLabel>
            <Segmented
              label="Preset"
              variant="compact"
              value={preset}
              onChange={(value) => {
                const picked = PRESETS.find((entry) => entry.value === value);
                if (picked) setCron(picked.cron);
              }}
              options={PRESET_OPTIONS}
            />
            <div className="schedule-editor__trigger">
              <Input
                label="Cron"
                value={cron}
                spellCheck={false}
                autoComplete="off"
                className="schedule-editor__cron"
                hint="minute hour day-of-month month day-of-week"
                error={preview.field === "cron" ? preview.problem : undefined}
                aria-describedby={runsId}
                onChange={(event) => setCron(event.target.value)}
              />
              <Input
                label="Time zone"
                value={timeZone}
                list={zonesId}
                spellCheck={false}
                autoComplete="off"
                error={
                  preview.field === "timeZone" ? preview.problem : undefined
                }
                onChange={(event) => setTimeZone(event.target.value)}
              />
              <datalist id={zonesId}>
                {zones.map((zone) => (
                  <option key={zone} value={zone} />
                ))}
              </datalist>
            </div>
            {preview.problem && !blocked && (
              <p className="schedule-editor__note" role="note">
                Its times stay as they are: you can still rename it or turn it
                off.
              </p>
            )}
            <div id={runsId} className="schedule-editor__runs">
              {preview.runs.length > 0 && (
                <>
                  <span className="schedule-editor__runs-label">
                    Next runs · {trigger.timeZone}
                  </span>
                  <ol>
                    {preview.runs.map((run) => (
                      <li key={run.toISOString()}>
                        <time dateTime={run.toISOString()}>
                          {formatRun(run, trigger.timeZone)}
                        </time>
                      </li>
                    ))}
                  </ol>
                </>
              )}
            </div>
          </div>
          <Textarea
            label="Instructions for each run"
            note="optional"
            value={instructions}
            rows={2}
            maxLength={TEMPLATE_INSTRUCTIONS_LIMIT}
            placeholder="Anything every run should do on top of the template's goal"
            onChange={(event) => setInstructions(event.target.value)}
          />
          <div className="schedule-editor__row">
            <Input
              label="Keep workspaces"
              type="number"
              inputMode="numeric"
              min={0}
              max={MAX_KEEP_WORKSPACES}
              step={1}
              value={keepText}
              hint="Finished runs that keep their files; older ones' are removed (their record stays)."
              error={errors.keep}
              onChange={(event) => setKeepText(event.target.value)}
            />
            <div className="schedule-editor__chat">
              <SectionLabel tracking="part">Chat updates</SectionLabel>
              <Segmented
                label="Chat updates"
                variant="compact"
                value={chatUpdates}
                onChange={setChatUpdates}
                options={CHAT_OPTIONS}
              />
            </div>
          </div>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            On: start tasks at these times
          </label>
          {paused && (
            <p className="schedule-editor__note" role="note">
              Paused: {pausedLine(paused)}.{" "}
              {paused === "template_unusable"
                ? "Fix the template, then turn the schedule on;"
                : "Change its times, then turn it on;"}{" "}
              it starts from its next time, not the ones it missed.
            </p>
          )}
          {error && <ErrorBanner word="Not saved">{error}</ErrorBanner>}
        </form>
      )}
    </Dialog>
  );
}

/** Deletes a schedule after a confirmation; its tasks are kept. */
function DeleteScheduleDialog({
  schedule,
  onClose,
}: {
  schedule: Schedule;
  onClose: () => void;
}) {
  const { deleteSchedule } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteSchedule(schedule.id);
      onClose();
    } catch (reason) {
      setError(reasonOf(reason, "Could not delete the schedule."));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      title={`Delete “${schedule.name}”?`}
      description="No more runs start. Tasks it started are kept, running ones included."
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
            {busy ? "Deleting…" : "Delete schedule"}
          </Button>
        </>
      }
    >
      {error && <ErrorBanner word="Not deleted">{error}</ErrorBanner>}
    </Dialog>
  );
}
