import { type FormEvent, useId, useState } from "react";
import {
  Avatar,
  Button,
  Chip,
  Dialog,
  ErrorBanner,
  SectionLabel,
  Textarea,
} from "../../components/ui";
import { useWorkspace } from "../../state/WorkspaceContext";
import "./tasks.css";

export interface NewTaskDialogProps {
  /** Preselected bots; the first coordinates. */
  initialBotIds: string[];
  onClose: () => void;
}

/** Starts a task: a goal and the bots that work on it. On success the task opens. */
export function NewTaskDialog({ initialBotIds, onClose }: NewTaskDialogProps) {
  const { bots, createTask } = useWorkspace();
  const formId = useId();
  const pickLabelId = useId();
  const [goal, setGoal] = useState("");
  const [picked, setPicked] = useState<string[]>(() =>
    initialBotIds.filter((botId) => bots.some((bot) => bot.id === botId)),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canStart = goal.trim().length > 0 && picked.length > 0 && !busy;

  const toggle = (botId: string) =>
    setPicked((current) =>
      current.includes(botId)
        ? current.filter((id) => id !== botId)
        : [...current, botId],
    );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canStart) return;
    setBusy(true);
    setError(null);
    try {
      await createTask({ goal: goal.trim(), participantBotIds: picked });
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
      description="Describe the goal and pick the bots. The first bot you pick coordinates."
      dismissible={!goal.trim()}
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
      <form id={formId} className="new-task-form" onSubmit={submit}>
        <Textarea
          label="Goal"
          value={goal}
          rows={3}
          required
          placeholder="What should the bots accomplish?"
          onChange={(event) => setGoal(event.target.value)}
        />
        <div className="new-task-form__bots">
          <SectionLabel id={pickLabelId} tracking="part">
            Bots
          </SectionLabel>
          {bots.length ? (
            <div
              className="new-task-form__chips"
              role="group"
              aria-labelledby={pickLabelId}
            >
              {bots.map((bot) => {
                const index = picked.indexOf(bot.id);
                return (
                  <Chip
                    key={bot.id}
                    selected={index >= 0}
                    onClick={() => toggle(bot.id)}
                    leading={
                      <Avatar
                        appearance={bot.appearance}
                        name={bot.name}
                        size={18}
                        animate={false}
                        decorative
                      />
                    }
                  >
                    {bot.name}
                    {index === 0 && (
                      <span className="new-task-form__coordinator">
                        · coordinator
                      </span>
                    )}
                  </Chip>
                );
              })}
            </div>
          ) : (
            <p className="new-task-form__note">Create a bot first.</p>
          )}
        </div>
        {error && <ErrorBanner>{error}</ErrorBanner>}
      </form>
    </Dialog>
  );
}
