import type { Bot, TaskMessage, TaskView } from "@jj/contracts";
import { useId, useMemo, useRef, useState } from "react";
import {
  type CommandOutcome,
  postTaskMessage,
  steerTask,
  stopTask,
} from "./commands";
import { FIXTURE_NOTICE } from "./fixtures";

type Composed = "discussion" | "steering";

// A message the user composed that the backend never accepted. Kept visible and clearly
// marked so the transcript does not imply it was delivered or persisted.
interface UnsentMessage {
  key: string;
  text: string;
  as: Composed;
  reason: string;
}

function authorName(message: TaskMessage, participants: Bot[]) {
  if (message.authorKind === "user") return "You";
  if (message.authorKind === "system") return "System";
  return (
    participants.find((bot) => bot.id === message.authorId)?.name ??
    message.authorId
  );
}

function activationNote(message: TaskMessage, participants: Bot[]) {
  if (message.activateBotIds.length === 0) {
    return "Shared with all participants · activated nobody";
  }
  const names = message.activateBotIds.map(
    (botId) => participants.find((bot) => bot.id === botId)?.name ?? botId,
  );
  return `Shared with all participants · activated ${names.join(", ")}`;
}

export function TaskChat({ view }: { view: TaskView }) {
  const { task, participants, messages, verificationResults } = view;
  const [composed, setComposed] = useState<Composed>("discussion");
  const [draft, setDraft] = useState("");
  const [unsent, setUnsent] = useState<UnsentMessage[]>([]);
  const [outcome, setOutcome] = useState<CommandOutcome | null>(null);
  // Stop is reported next to its own button, not in the composer that did not trigger it.
  const [stopOutcome, setStopOutcome] = useState<CommandOutcome | null>(null);
  const [sending, setSending] = useState(false);
  const draftId = useId();
  const intentId = useId();
  const sequence = useRef(0);

  const coordinator = useMemo(
    () => participants.find((bot) => bot.id === task.coordinatorBotId),
    [participants, task.coordinatorBotId],
  );
  const stale = useMemo(
    () =>
      verificationResults.filter(
        (result) => result.goalVersion < task.goalVersion,
      ),
    [verificationResults, task.goalVersion],
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    const result =
      composed === "steering"
        ? await steerTask({
            taskId: task.id,
            text,
            observedGoalVersion: task.goalVersion,
          })
        : await postTaskMessage({
            taskId: task.id,
            text,
            // The user shares context without activating a bot; steering goes to the coordinator.
            activateBotIds: [],
          });
    setOutcome(result);
    if (result.status === "rejected") {
      sequence.current += 1;
      setUnsent((current) => [
        ...current,
        {
          key: `unsent-${sequence.current}`,
          text,
          as: composed,
          reason: result.reason,
        },
      ]);
    }
    setDraft("");
    setSending(false);
  }

  async function requestStop() {
    setSending(true);
    setStopOutcome(
      await stopTask({
        taskId: task.id,
        reason: "Stopped from the task chat by the user.",
      }),
    );
    setSending(false);
  }

  return (
    <section className="task-chat" aria-label={`Task chat: ${task.goal}`}>
      <div className="task-head">
        <div>
          <span className="tiny-label">
            GOAL · VERSION {task.goalVersion} · {task.status.toUpperCase()}
          </span>
          <h2>{task.goal}</h2>
          <p className="task-meta">
            Coordinated by {coordinator?.name ?? task.coordinatorBotId} ·{" "}
            {participants.length} participating bots ·{" "}
            {task.verificationPlan.length} checks
          </p>
        </div>
        <div className="stop-control">
          <button
            type="button"
            className="stop-button"
            onClick={requestStop}
            disabled={sending}
          >
            Stop task
          </button>
          {stopOutcome?.status === "rejected" ? (
            <span className="command-error" role="alert">
              {stopOutcome.reason}
            </span>
          ) : null}
          {stopOutcome?.status === "accepted" ? (
            <span className="command-ok" role="status">
              Stop accepted. Active sessions are being cancelled.
            </span>
          ) : null}
        </div>
      </div>

      <p className="fixture-flag" role="note">
        {FIXTURE_NOTICE}
      </p>

      {stale.length > 0 ? (
        <p className="stale-flag" role="note">
          {stale.length} check {stale.length === 1 ? "result" : "results"}{" "}
          predate goal version {task.goalVersion} and no longer count towards
          completion.
        </p>
      ) : null}

      <ol className="transcript">
        {messages.map((message) => (
          <li key={message.id} className={`message kind-${message.authorKind}`}>
            <div className="message-head">
              <strong>{authorName(message, participants)}</strong>
              <span className={`intent intent-${message.intent}`}>
                {message.intent}
              </span>
            </div>
            <p>{message.text}</p>
            <span className="activation">
              {activationNote(message, participants)}
            </span>
          </li>
        ))}
        {unsent.map((message) => (
          <li key={message.key} className="message kind-user unsent">
            <div className="message-head">
              <strong>You</strong>
              <span className={`intent intent-${message.as}`}>
                {message.as}
              </span>
              <span className="intent intent-unsent">not delivered</span>
            </div>
            <p>{message.text}</p>
            <span className="activation">{message.reason}</span>
          </li>
        ))}
      </ol>

      <form className="composer" onSubmit={submit}>
        <div className="composer-row">
          <label className="tiny-label" htmlFor={intentId}>
            Send as
          </label>
          <select
            id={intentId}
            value={composed}
            onChange={(event) => setComposed(event.target.value as Composed)}
          >
            <option value="discussion">
              Discussion · shares context, activates nobody
            </option>
            <option value="steering">
              Steering · goes to the coordinator and changes the plan
            </option>
          </select>
        </div>
        <label className="tiny-label" htmlFor={draftId}>
          Message
        </label>
        <textarea
          id={draftId}
          value={draft}
          rows={3}
          placeholder={
            composed === "steering"
              ? "Tell the coordinator what to change…"
              : "Add context for the participating bots…"
          }
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="composer-actions">
          <button type="submit" disabled={sending || draft.trim().length === 0}>
            {sending
              ? "Sending…"
              : composed === "steering"
                ? "Send steering ↗"
                : "Post message ↗"}
          </button>
          {outcome?.status === "rejected" ? (
            <span className="command-error" role="alert">
              {outcome.reason}
            </span>
          ) : null}
          {outcome?.status === "accepted" ? (
            <span className="command-ok" role="status">
              Accepted by the API.
            </span>
          ) : null}
        </div>
      </form>
    </section>
  );
}
