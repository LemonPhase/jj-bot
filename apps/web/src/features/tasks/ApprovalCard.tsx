import {
  APPROVAL_REASON_LIMIT,
  type Approval,
  type Bot,
  describeApprovalRule,
  formatSpendAgainstCap,
  type SpendApproval,
  type TaskView,
  type ToolApproval,
  visibleText,
} from "@jj/contracts";
import { type FormEvent, useId, useState } from "react";
import { useApi } from "../../api/ApiContext";
import { isApiError } from "../../api/client";
import {
  Avatar,
  Button,
  ErrorBanner,
  Input,
  StatusSquare,
} from "../../components/ui";
import { formatMessageTime } from "../../lib/format";
import { approvalCall, approvalProblem, approvalState } from "./approvals";
import { SpendCapDialog, THRESHOLD_PERCENT } from "./SpendControl";
import { botName } from "./taskModel";

/**
 * An approval in the task chat, waiting for the user or answered: a held
 * call (`ToolApprovalCard`) or spend past a cap's threshold
 * (`SpendApprovalCard`). Only the user answers: no bot can.
 */
export function ApprovalCard({
  approval,
  bot,
  view,
}: {
  approval: Approval;
  bot: Bot | undefined;
  /** The task's view, for the cap dialog a spend approval offers. */
  view?: TaskView;
}) {
  return approval.kind === "spend" ? (
    <SpendApprovalCard approval={approval} bot={bot} view={view} />
  ) : (
    <ToolApprovalCard approval={approval} bot={bot} />
  );
}

/** Sends the user's answer; the server's record is shown until the stream brings it. */
function useDecision<Kind extends Approval>(approval: Kind) {
  const api = useApi();
  const [answered, setAnswered] = useState<Approval | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const current = (
    approval.status === "pending" && answered ? answered : approval
  ) as Kind;
  const decide = async (decision: "approve" | "deny", reason = "") => {
    setBusy(true);
    setFailure(null);
    try {
      const trimmed = reason.trim();
      setAnswered(
        await api.decideApproval(approval.taskId, approval.id, {
          decision,
          ...(decision === "deny" && trimmed ? { reason: trimmed } : {}),
        }),
      );
      return true;
    } catch (error) {
      setFailure(isApiError(error) ? error.message : String(error));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { current, decide, busy, failure, setFailure };
}

/**
 * A call waiting for (or answered by) the user: who asks to run what, the
 * rule that asked, what the bot wrote with it, and what happened to it.
 * While it is pending, Approve runs it once and Deny returns an error to the
 * bot with the optional reason.
 */
function ToolApprovalCard({
  approval,
  bot,
}: {
  approval: ToolApproval;
  bot: Bot | undefined;
}) {
  const reasonId = useId();
  const { current, decide, busy, failure, setFailure } = useDecision(approval);
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const state = approvalState(current);
  const problem = approvalProblem(current);
  const name = botName(bot);
  const pending = current.status === "pending";

  const submitDenial = async (event: FormEvent) => {
    event.preventDefault();
    if (await decide("deny", reason)) setDenying(false);
  };

  return (
    <article
      className="approval-card"
      data-status={current.status}
      aria-label={`Approval: ${name} asks to run ${current.tool}`}
    >
      <div className="task-msg__head">
        <Avatar
          appearance={bot?.appearance}
          name={name}
          size={24}
          animate={false}
          decorative
        />
        <span className="task-msg__author">{name}</span>
        <time className="task-msg__time" dateTime={current.createdAt}>
          asks to run {current.tool} · {formatMessageTime(current.createdAt)}
        </time>
      </div>
      <div className="approval-card__body">
        <pre
          className="approval-card__call"
          // Scrollable by keyboard when the call is long.
          tabIndex={0}
          aria-label={`The ${current.tool} call`}
        >
          {visibleText(approvalCall(current))}
        </pre>
        {current.text && (
          <p className="approval-card__text">
            {name} wrote: {visibleText(current.text)}
          </p>
        )}
        <p className="approval-card__rule">
          {pending ? "Needs your approval" : "Held by the rule"}:{" "}
          {describeApprovalRule(current.rule)}
        </p>
        {problem && <p className="approval-card__rule">{problem}</p>}
        <p className="approval-card__state" role="status">
          <StatusSquare tone={state.tone} />
          <span>{state.text}</span>
          {current.reason && (
            <span className="approval-card__reason">
              {current.status === "denied" ? "Your reason: " : ""}
              {current.reason}
            </span>
          )}
          {state.detail && (
            <span className="approval-card__reason">{state.detail}</span>
          )}
        </p>
        {pending && !denying && (
          <div className="approval-card__actions">
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => void decide("approve")}
            >
              {busy ? "Sending…" : "Approve"}
            </Button>
            <Button disabled={busy} onClick={() => setDenying(true)}>
              Deny
            </Button>
          </div>
        )}
        {pending && denying && (
          <form
            className="approval-card__deny"
            onSubmit={(event) => void submitDenial(event)}
          >
            <Input
              id={reasonId}
              label="Reason for the bot (optional)"
              value={reason}
              maxLength={APPROVAL_REASON_LIMIT}
              onChange={(event) => setReason(event.target.value)}
              disabled={busy}
              autoFocus
            />
            <div className="approval-card__actions">
              <Button type="submit" variant="danger" disabled={busy}>
                {busy ? "Sending…" : "Deny the call"}
              </Button>
              <Button disabled={busy} onClick={() => setDenying(false)}>
                Back
              </Button>
            </div>
          </form>
        )}
        {failure && (
          <ErrorBanner word="Not sent" onDismiss={() => setFailure(null)}>
            {failure}
          </ErrorBanner>
        )}
      </div>
    </article>
  );
}

/**
 * What a spend approval asks, from its record: "Spent $4.02 of $5.00, past
 * the 80% threshold." for the task's cap, or the bot's daily cap.
 */
export function spendQuestion(approval: SpendApproval, name: string): string {
  const { spent, cap } = formatSpendAgainstCap(
    approval.spentUsd,
    approval.capUsd,
  );
  return approval.scope === "task"
    ? `Spent ${spent} of ${cap}, past the ${THRESHOLD_PERCENT} threshold.`
    : `${name} spent ${spent} of its ${cap} daily cap in the last 24 hours, past the ${THRESHOLD_PERCENT} threshold.`;
}

/**
 * Spend past a cap's threshold, waiting for (or answered by) the user. While
 * it is pending no model call it covers starts, in any session: Approve lets
 * them run on up to the cap, Deny stops the task as the cap would, and
 * Raise cap… changes the task's cap, which expires the question.
 */
function SpendApprovalCard({
  approval,
  bot,
  view,
}: {
  approval: SpendApproval;
  bot: Bot | undefined;
  view: TaskView | undefined;
}) {
  const api = useApi();
  const { current, decide, busy, failure, setFailure } = useDecision(approval);
  const [raising, setRaising] = useState(false);
  const state = approvalState(current);
  const name = botName(bot);
  const pending = current.status === "pending";
  const editable =
    view !== undefined &&
    view.task.status !== "cancelled" &&
    !view.task.cancelRequestedAt;
  const capLabel =
    current.scope === "task" ? "the task's cap" : `${name}'s daily cap`;

  return (
    <article
      className="approval-card approval-card--spend"
      data-status={current.status}
      aria-label={`Approval: spend past ${THRESHOLD_PERCENT} of ${capLabel}`}
    >
      <div className="task-msg__head">
        <Avatar
          appearance={bot?.appearance}
          name={name}
          size={24}
          animate={false}
          decorative
        />
        <span className="task-msg__author">{name}</span>
        <time className="task-msg__time" dateTime={current.createdAt}>
          spend past {THRESHOLD_PERCENT} of {capLabel} ·{" "}
          {formatMessageTime(current.createdAt)}
        </time>
      </div>
      <div className="approval-card__body">
        <p className="approval-card__question">
          {spendQuestion(current, name)}
          {pending ? " Continue up to the cap?" : ""}
        </p>
        <p className="approval-card__rule">
          {!pending
            ? "You were asked because asking past the threshold is on for this cap."
            : current.scope === "task"
              ? "No model call starts until you answer. Calls already running finish."
              : `None of ${name}'s model calls in this task starts until you answer. Calls already running finish.`}
        </p>
        <p className="approval-card__state" role="status">
          <StatusSquare tone={state.tone} />
          <span>{state.text}</span>
          {current.reason && (
            <span className="approval-card__reason">
              {current.status === "denied" ? "Your reason: " : ""}
              {current.reason}
            </span>
          )}
        </p>
        {pending && (
          <div className="approval-card__actions">
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => void decide("approve")}
            >
              {busy ? "Sending…" : "Approve"}
            </Button>
            <Button disabled={busy} onClick={() => void decide("deny")}>
              Deny
            </Button>
            {current.scope === "task" && editable && (
              <Button disabled={busy} onClick={() => setRaising(true)}>
                Raise cap…
              </Button>
            )}
          </div>
        )}
        {pending && current.scope === "bot" && (
          <p className="approval-card__rule">
            To raise {name}'s daily cap, edit its runtime profile.
          </p>
        )}
        {failure && (
          <ErrorBanner word="Not sent" onDismiss={() => setFailure(null)}>
            {failure}
          </ErrorBanner>
        )}
      </div>
      {raising && view && (
        <SpendCapDialog
          view={view}
          onClose={() => setRaising(false)}
          save={(command) => api.updateTask(view.task.id, command)}
        />
      )}
    </article>
  );
}
