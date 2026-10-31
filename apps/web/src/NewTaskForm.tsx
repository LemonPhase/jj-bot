import {
  type Bot,
  createTaskCommandSchema,
  type TaskView,
} from "@jj/contracts";
import { useId, useState } from "react";
import { type CommandOutcome, createTask } from "./commands";

// A task cannot exist without a verification plan, so the form collects one criterion
// up front rather than letting a goal be created and checked later.
export function NewTaskForm({
  bots,
  onDraft,
}: {
  bots: Bot[];
  onDraft: (view: TaskView) => void;
}) {
  const [open, setOpen] = useState(false);
  const [goal, setGoal] = useState("");
  const [coordinatorBotId, setCoordinatorBotId] = useState(bots[0]?.id ?? "");
  const [participantBotIds, setParticipantBotIds] = useState<string[]>(
    bots.slice(0, 2).map((bot) => bot.id),
  );
  const [description, setDescription] = useState("");
  const [method, setMethod] = useState("");
  const [expectedEvidence, setExpectedEvidence] = useState("");
  const [outcome, setOutcome] = useState<CommandOutcome | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const goalId = useId();
  const coordinatorId = useId();
  const descriptionId = useId();
  const methodId = useId();
  const evidenceId = useId();

  function toggleParticipant(botId: string) {
    setParticipantBotIds((current) =>
      current.includes(botId)
        ? current.filter((id) => id !== botId)
        : [...current, botId],
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (sending) return;
    const command = {
      goal: goal.trim(),
      coordinatorBotId,
      participantBotIds,
      verificationPlan: [
        {
          id: `check-${participantBotIds.length}-${Date.now()}`,
          description: description.trim(),
          method: method.trim(),
          expectedEvidence: expectedEvidence.trim(),
        },
      ],
    };
    // The shared schema is the gate, so the UI enforces exactly what the backend will.
    const parsed = createTaskCommandSchema.safeParse(command);
    if (!parsed.success) {
      setInvalid(parsed.error.issues.map((issue) => issue.message).join(" · "));
      setOutcome(null);
      return;
    }
    setInvalid(null);
    setSending(true);
    const result = await createTask(parsed.data);
    setOutcome(result);
    if (result.status === "rejected") {
      onDraft({
        task: {
          id: `draft-${crypto.randomUUID()}`,
          goal: parsed.data.goal,
          goalVersion: 1,
          coordinatorBotId: parsed.data.coordinatorBotId,
          participantBotIds: parsed.data.participantBotIds,
          verificationPlan: parsed.data.verificationPlan,
          status: "queued",
        },
        participants: bots.filter((bot) =>
          parsed.data.participantBotIds.includes(bot.id),
        ),
        messages: [],
        sessions: [],
        verificationResults: [],
        events: [],
        replayCursor: 0,
      });
    }
    setGoal("");
    setDescription("");
    setMethod("");
    setExpectedEvidence("");
    setSending(false);
  }

  if (!open) {
    return (
      <button
        type="button"
        className="add-button"
        onClick={() => setOpen(true)}
      >
        + New task
      </button>
    );
  }

  return (
    <form className="create-form" onSubmit={submit}>
      <div className="panel-heading">
        <h3>New task</h3>
        <button
          type="button"
          className="link-button"
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
      </div>

      <label className="tiny-label" htmlFor={goalId}>
        Goal
      </label>
      <textarea
        id={goalId}
        value={goal}
        rows={2}
        placeholder="What should be achieved, and what does done mean?"
        onChange={(event) => setGoal(event.target.value)}
      />

      <label className="tiny-label" htmlFor={coordinatorId}>
        Coordinating bot
      </label>
      <select
        id={coordinatorId}
        value={coordinatorBotId}
        onChange={(event) => setCoordinatorBotId(event.target.value)}
      >
        {bots.map((bot) => (
          <option key={bot.id} value={bot.id}>
            {bot.name}
          </option>
        ))}
      </select>

      <fieldset className="participants">
        <legend className="tiny-label">Participating bots</legend>
        {bots.map((bot) => (
          <label key={bot.id}>
            <input
              type="checkbox"
              checked={participantBotIds.includes(bot.id)}
              onChange={() => toggleParticipant(bot.id)}
            />
            {bot.name}
          </label>
        ))}
      </fieldset>

      <p className="form-note">
        Verification is defined now, not after the work. A task cannot be
        created without at least one check.
      </p>
      <label className="tiny-label" htmlFor={descriptionId}>
        Check · what must be true
      </label>
      <input
        id={descriptionId}
        value={description}
        placeholder="Every claim cites a source."
        onChange={(event) => setDescription(event.target.value)}
      />
      <label className="tiny-label" htmlFor={methodId}>
        Check · how it is verified
      </label>
      <input
        id={methodId}
        value={method}
        placeholder="Open each link and locate the passage."
        onChange={(event) => setMethod(event.target.value)}
      />
      <label className="tiny-label" htmlFor={evidenceId}>
        Check · expected evidence
      </label>
      <input
        id={evidenceId}
        value={expectedEvidence}
        placeholder="Source URL plus the passage it rests on."
        onChange={(event) => setExpectedEvidence(event.target.value)}
      />

      <div className="composer-actions">
        <button type="submit" disabled={sending}>
          {sending ? "Creating…" : "Create task ↗"}
        </button>
        {invalid ? (
          <span className="command-error" role="alert">
            {invalid}
          </span>
        ) : null}
        {outcome?.status === "rejected" ? (
          <span className="command-error" role="alert">
            {outcome.reason} Kept in this tab only.
          </span>
        ) : null}
        {outcome?.status === "accepted" ? (
          <span className="command-ok" role="status">
            Created by the API.
          </span>
        ) : null}
      </div>
    </form>
  );
}
