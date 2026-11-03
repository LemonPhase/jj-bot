import {
  APPROVAL_REASON_LIMIT,
  type Approval,
  type Bot,
  describeApprovalRule,
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
import { botName } from "./taskModel";

/**
 * A call waiting for (or answered by) the user, in the task chat: who asks
 * to run what, the rule that asked, what the bot wrote with it, and what
 * happened to it. While it is pending, Approve runs it once and Deny returns
 * an error to the bot with the optional reason. Only the user answers: no
 * bot can.
 */
export function ApprovalCard({
  approval,
  bot,
}: {
  approval: Approval;
  bot: Bot | undefined;
}) {
  const api = useApi();
  const reasonId = useId();
  // The server's answer, shown until the stream brings the same record.
  const [answered, setAnswered] = useState<Approval | null>(null);
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const current =
    approval.status === "pending" && answered ? answered : approval;
  const state = approvalState(current);
  const problem = approvalProblem(current);
  const name = botName(bot);
  const pending = current.status === "pending";

  const decide = async (decision: "approve" | "deny") => {
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
      setDenying(false);
    } catch (error) {
      setFailure(isApiError(error) ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const submitDenial = (event: FormEvent) => {
    event.preventDefault();
    void decide("deny");
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
          <form className="approval-card__deny" onSubmit={submitDenial}>
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
