import type { Bot } from "@jj/contracts";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { isApiError } from "../../api/client";
import {
  Avatar,
  Button,
  buttonClass,
  Dialog,
  ErrorBanner,
  Icon,
  IconButton,
  Input,
  Panel,
  SectionLabel,
  Select,
  StatusTag,
  Textarea,
} from "../../components/ui";
import { appearanceSummary } from "../../lib/appearance";
import { formatMessageTime } from "../../lib/format";
import { useWorkspace } from "../../state/WorkspaceContext";
import { studioHref, taskHref } from "../shell/router";
import { navigate } from "../shell/useRoute";
import { draftFromBot, updateBotCommand } from "../studio/studioDraft";
import { DEFAULT_OPTION, modelOptions, profileOptions } from "./botOptions";
import { requestBotFocus } from "./focusRequest";
import { useModels } from "./useModels";

/** What the About links ask the inspector to focus when it opens. */
export type InspectorFocus = "memory" | "tasks";

export interface BotInspectorProps {
  id: string;
  bot: Bot;
  /** Move focus here once rendered, then call `onFocused`. */
  focus: InspectorFocus | null;
  onFocused: () => void;
  onClose: () => void;
}

const errorText = (reason: unknown) =>
  reason instanceof Error ? reason.message : "Something went wrong.";

/**
 * The bot's profile panel (not designed; SPEC §5.1 proposal: Progress panel
 * chrome, 340 wide): details, memory, active tasks and archive.
 */
export function BotInspector({
  id,
  bot,
  focus,
  onFocused,
  onClose,
}: BotInspectorProps) {
  const memoryId = useId();
  const tasksId = useId();

  useEffect(() => {
    if (!focus) return;
    document.getElementById(focus === "memory" ? memoryId : tasksId)?.focus();
    onFocused();
  }, [focus, memoryId, tasksId, onFocused]);

  return (
    <Panel id={id} label={`${bot.name}'s profile`} className="bot-inspector">
      <div className="bot-inspector__head">
        <SectionLabel as="h2">Profile</SectionLabel>
        <IconButton
          label="Close profile"
          icon={<Icon name="close" size={16} />}
          onClick={onClose}
        />
      </div>
      <Appearance bot={bot} />
      <DetailsForm bot={bot} />
      <MemoryForm bot={bot} fieldId={memoryId} />
      <ActiveTasks bot={bot} focusId={tasksId} />
      <ArchiveSection bot={bot} />
    </Panel>
  );
}

/** The bot's look, edited in Bot Studio (`#/studio/:botId`). */
function Appearance({ bot }: { bot: Bot }) {
  const labelId = useId();
  return (
    <section className="inspector-section" aria-labelledby={labelId}>
      <SectionLabel
        as="h3"
        id={labelId}
        tracking="part"
        className="inspector-heading"
      >
        Appearance
      </SectionLabel>
      <div className="inspector-look">
        <Avatar
          appearance={bot.appearance}
          name={bot.name}
          size={36}
          animate={false}
          decorative
        />
        <span className="inspector-look__summary">
          {appearanceSummary(bot.appearance)}
        </span>
      </div>
      <div className="inspector-actions">
        <a className={buttonClass()} href={studioHref(bot.id)}>
          Edit in Studio
        </a>
      </div>
    </section>
  );
}

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at: string }
  | { kind: "error"; message: string };

function SaveStatus({ state }: { state: SaveState }) {
  return (
    <span className="inspector-status" role="status">
      {state.kind === "saving" && "Saving…"}
      {state.kind === "saved" && `Saved ${formatMessageTime(state.at)}`}
    </span>
  );
}

/** Role, instructions, model and runtime profile, saved together with `updateBot`. */
function DetailsForm({ bot }: { bot: Bot }) {
  const { updateBot, profiles } = useWorkspace();
  const { models, error: modelsError } = useModels();
  const [role, setRole] = useState(bot.role);
  const [instructions, setInstructions] = useState(bot.instructions);
  const [model, setModel] = useState(bot.model ?? DEFAULT_OPTION);
  const [profile, setProfile] = useState(
    bot.runtimeProfileId ?? DEFAULT_OPTION,
  );
  const [state, setState] = useState<SaveState>({ kind: "idle" });

  // Only the fields edited here, so a save never overwrites what another tab
  // or Bot Studio changed meanwhile (the Studio diff, on the same fields).
  const changes = updateBotCommand(bot, {
    ...draftFromBot(bot),
    role,
    instructions,
    model,
    runtimeProfileId: profile,
  });
  const dirty = changes !== null;

  // Follow changes made elsewhere while there is nothing unsaved here.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (dirtyRef.current) return;
    setRole(bot.role);
    setInstructions(bot.instructions);
    setModel(bot.model ?? DEFAULT_OPTION);
    setProfile(bot.runtimeProfileId ?? DEFAULT_OPTION);
  }, [bot.role, bot.instructions, bot.model, bot.runtimeProfileId]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!changes) return;
    setState({ kind: "saving" });
    try {
      const saved = await updateBot(bot.id, changes);
      setRole(saved.role);
      setInstructions(saved.instructions);
      setState({ kind: "saved", at: saved.updatedAt });
    } catch (reason) {
      setState({ kind: "error", message: errorText(reason) });
    }
  };

  return (
    <form className="inspector-section" onSubmit={save}>
      <Input
        label="Role"
        value={role}
        maxLength={80}
        placeholder="e.g. Research"
        onChange={(event) => setRole(event.target.value)}
      />
      <Textarea
        label="Instructions"
        value={instructions}
        rows={4}
        placeholder={`How ${bot.name} should work.`}
        onChange={(event) => setInstructions(event.target.value)}
      />
      <Select
        label="Model"
        value={model}
        options={modelOptions(models, bot.model)}
        onChange={setModel}
        hint={modelsError ? `Models did not load: ${modelsError}` : undefined}
      />
      <Select
        label="Runtime profile"
        value={profile}
        options={profileOptions(profiles, bot.runtimeProfileId)}
        onChange={setProfile}
      />
      {state.kind === "error" && <ErrorBanner>{state.message}</ErrorBanner>}
      <div className="inspector-actions">
        <Button
          type="submit"
          variant="primary"
          disabled={!dirty || state.kind === "saving"}
        >
          Save details
        </Button>
        <SaveStatus state={state} />
      </div>
    </form>
  );
}

/** The bot's durable memory (one free-text field), saved with `putMemory`. */
function MemoryForm({ bot, fieldId }: { bot: Bot; fieldId: string }) {
  const { memories, memoryErrors, saveMemory, loadMemory } = useWorkspace();
  const stored = memories[bot.id];
  const loadError = stored ? undefined : memoryErrors[bot.id];
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    setRetrying(true);
    await loadMemory(bot.id);
    setRetrying(false);
  };
  const [draft, setDraft] = useState<string | null>(stored?.text ?? null);
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const dirty = draft !== null && draft !== (stored?.text ?? "");

  // Fill in once loaded, and follow saves made elsewhere while unedited.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (stored && !dirtyRef.current) setDraft(stored.text);
  }, [stored]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (draft === null || !dirty) return;
    setState({ kind: "saving" });
    try {
      const saved = await saveMemory(bot.id, draft);
      setDraft(saved.text);
      setState({ kind: "saved", at: saved.updatedAt });
    } catch (reason) {
      setState({ kind: "error", message: errorText(reason) });
    }
  };

  return (
    <form className="inspector-section" onSubmit={save}>
      <Textarea
        id={fieldId}
        label="Memory"
        value={draft ?? ""}
        rows={5}
        disabled={draft === null}
        placeholder={
          draft !== null
            ? "Nothing remembered yet."
            : loadError
              ? "Not loaded"
              : "Loading…"
        }
        hint={`Facts ${bot.name} keeps across all its sessions.`}
        onChange={(event) => setDraft(event.target.value)}
      />
      {loadError && (
        <ErrorBanner word="Not loaded">
          Memory did not load: {loadError}{" "}
          <button
            type="button"
            className="text-link"
            disabled={retrying}
            onClick={() => void retry()}
          >
            {retrying ? "Retrying…" : "Retry"}
          </button>
        </ErrorBanner>
      )}
      {state.kind === "error" && <ErrorBanner>{state.message}</ErrorBanner>}
      <div className="inspector-actions">
        <Button
          type="submit"
          variant="primary"
          disabled={!dirty || state.kind === "saving"}
        >
          Save memory
        </Button>
        <SaveStatus state={state} />
      </div>
    </form>
  );
}

/** Tasks the bot is in that have not finished, linking to `#/tasks/:id`. */
function ActiveTasks({ bot, focusId }: { bot: Bot; focusId: string }) {
  const { getTask } = useWorkspace();
  const labelId = useId();
  const active = bot.activeTaskIds.flatMap((taskId) => {
    const task = getTask(taskId);
    return task ? [task] : [];
  });
  return (
    <section
      id={focusId}
      tabIndex={-1}
      className="inspector-section"
      aria-labelledby={labelId}
    >
      <SectionLabel
        as="h3"
        id={labelId}
        tracking="part"
        className="inspector-heading"
      >
        Active tasks
      </SectionLabel>
      {active.length ? (
        <ul className="inspector-tasks">
          {active.map((task) => (
            <li key={task.id}>
              <a className="inspector-task" href={taskHref(task.id)}>
                <span className="inspector-task__title clamp1">
                  {task.title}
                </span>
                <StatusTag status={task} />
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="inspector-note">Not in any active tasks.</p>
      )}
    </section>
  );
}

/** Archive, behind a confirmation. The server refuses while tasks are active. */
function ArchiveSection({ bot }: { bot: Bot }) {
  const { bots, archiveBot, refreshBots } = useWorkspace();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = bot.activeTaskIds.length > 0;

  const open = () => {
    setError(null);
    setConfirming(true);
  };
  const cancel = () => {
    if (busy) return;
    setConfirming(false);
    setError(null);
  };
  const archive = async () => {
    setBusy(true);
    setError(null);
    const next = bots.find((other) => other.id !== bot.id);
    try {
      await archiveBot(bot.id);
      // Focus lands on the next bot's heading (or the empty state), not <body>.
      requestBotFocus(next?.id ?? null);
      navigate({ name: "bots", botId: next?.id ?? null }, { replace: true });
    } catch (reason) {
      setError(isApiError(reason) ? reason.message : errorText(reason));
      setBusy(false);
      // The server knows of active tasks this screen did not: catch up, so
      // the button reflects them.
      if (isApiError(reason) && reason.code === "CONFLICT")
        void refreshBots().catch(() => {});
    }
  };

  return (
    <section className="inspector-section">
      <SectionLabel as="h3" tracking="part" className="inspector-heading">
        Archive
      </SectionLabel>
      <p className="inspector-note">
        {blocked
          ? `${bot.name} is in active tasks. Stop or finish them before archiving.`
          : `${bot.name} leaves the bot list and can no longer be messaged.`}
      </p>
      <div className="inspector-actions">
        <Button variant="danger" disabled={blocked} onClick={open}>
          Archive bot
        </Button>
      </div>
      <Dialog
        open={confirming}
        onClose={cancel}
        title={`Archive ${bot.name}?`}
        description={`${bot.name} leaves the bot list and can no longer be messaged.`}
        footer={
          <>
            <Button onClick={cancel} disabled={busy}>
              Cancel
            </Button>
            <Button variant="danger" onClick={archive} disabled={busy}>
              {busy ? "Archiving…" : "Archive"}
            </Button>
          </>
        }
      >
        {error && <ErrorBanner>{error}</ErrorBanner>}
      </Dialog>
    </section>
  );
}
