import { type FormEvent, useId, useState } from "react";
import {
  Avatar,
  Button,
  Chip,
  Dialog,
  ErrorBanner,
  SectionLabel,
  Select,
  Textarea,
} from "../../components/ui";
import { useWorkspace } from "../../state/WorkspaceContext";

export interface NewTaskDialogProps {
  /** Preselected bots; the first coordinates. */
  initialBotIds: string[];
  onClose: () => void;
}

/**
 * Starts a task: the goal, the coordinator who plans and delegates, and any
 * number of other participants. On success the task opens.
 */
export function NewTaskDialog({ initialBotIds, onClose }: NewTaskDialogProps) {
  const { bots, createTask } = useWorkspace();
  const formId = useId();
  const pickLabelId = useId();
  const known = initialBotIds.filter((botId) =>
    bots.some((bot) => bot.id === botId),
  );
  const [goal, setGoal] = useState("");
  const [coordinatorId, setCoordinatorId] = useState(
    () => known[0] ?? bots[0]?.id ?? "",
  );
  const [others, setOthers] = useState<string[]>(() => known.slice(1));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const participants = [
    coordinatorId,
    ...others.filter((botId) => botId !== coordinatorId),
  ].filter(Boolean);
  const canStart = goal.trim().length > 0 && Boolean(coordinatorId) && !busy;

  const toggle = (botId: string) =>
    setOthers((current) =>
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
      await createTask({ goal: goal.trim(), participantBotIds: participants });
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
      {bots.length === 0 ? (
        <p className="new-task-form__note">
          Create a bot first: a task needs at least a coordinator.
        </p>
      ) : (
        <form id={formId} className="new-task-form" onSubmit={submit}>
          <Textarea
            label="Goal"
            value={goal}
            rows={3}
            required
            placeholder="What should the bots accomplish?"
            onChange={(event) => setGoal(event.target.value)}
          />
          <Select
            label="Coordinator"
            value={coordinatorId}
            onChange={setCoordinatorId}
            options={bots.map((bot) => ({
              value: bot.id,
              label: bot.role ? `${bot.name} · ${bot.role}` : bot.name,
            }))}
          />
          <div className="new-task-form__bots">
            <SectionLabel id={pickLabelId} tracking="part">
              Participants · {participants.length}
            </SectionLabel>
            <div
              className="new-task-form__chips"
              role="group"
              aria-labelledby={pickLabelId}
            >
              {bots.map((bot) => {
                const isCoordinator = bot.id === coordinatorId;
                return (
                  <Chip
                    key={bot.id}
                    selected={isCoordinator || others.includes(bot.id)}
                    aria-disabled={isCoordinator || undefined}
                    onClick={() => {
                      if (!isCoordinator) toggle(bot.id);
                    }}
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
                    {isCoordinator && (
                      <span className="new-task-form__coordinator">
                        · coordinator
                      </span>
                    )}
                  </Chip>
                );
              })}
            </div>
          </div>
          {error && <ErrorBanner word="Not started">{error}</ErrorBanner>}
        </form>
      )}
    </Dialog>
  );
}
