import { useState } from "react";
import { useWorkspace } from "../../state/WorkspaceContext";
import { Modal } from "../common/Modal";
import { StatusDot } from "../common/StatusDot";

export function NewTaskModal({
  initialBotIds,
  onClose,
}: {
  initialBotIds: string[];
  onClose: () => void;
}) {
  const { bots, createTask } = useWorkspace();
  const [goal, setGoal] = useState("");
  const [criterion, setCriterion] = useState("");
  const [selected, setSelected] = useState<string[]>(initialBotIds);

  const toggle = (botId: string) =>
    setSelected((current) =>
      current.includes(botId)
        ? current.length > 1
          ? current.filter((id) => id !== botId)
          : current
        : [...current, botId],
    );

  return (
    <Modal
      title="New Task"
      submitLabel="Start Task"
      onClose={onClose}
      onSubmit={() => {
        if (!goal.trim() || !criterion.trim() || selected.length === 0) return;
        void createTask({
          goal: goal.trim(),
          participantBotIds: selected,
          verificationCriterion: criterion.trim(),
        });
        onClose();
      }}
    >
      <div className="form-group">
        <label className="field-label" htmlFor="new-task-goal">
          Goal
        </label>
        <input
          id="new-task-goal"
          className="form-input"
          placeholder="What should the bots accomplish?"
          required
          autoFocus
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
        />
      </div>
      <div className="form-group">
        <div className="field-label">Participants (first is coordinator)</div>
        <div className="bot-check-grid">
          {bots.map((bot) => {
            const index = selected.indexOf(bot.id);
            return (
              <button
                key={bot.id}
                type="button"
                className={`bot-select-pill ${index >= 0 ? "selected" : ""}`}
                aria-pressed={index >= 0}
                onClick={() => toggle(bot.id)}
              >
                <StatusDot color={bot.color} />
                <span>{bot.name}</span>
                {index === 0 && <span className="chip-note">coord</span>}
              </button>
            );
          })}
        </div>
      </div>
      <div className="form-group">
        <label className="field-label" htmlFor="new-task-check">
          Verification criterion
        </label>
        <input
          id="new-task-check"
          className="form-input"
          placeholder="e.g. Unit tests pass & latency < 50ms"
          required
          value={criterion}
          onChange={(event) => setCriterion(event.target.value)}
        />
      </div>
    </Modal>
  );
}
