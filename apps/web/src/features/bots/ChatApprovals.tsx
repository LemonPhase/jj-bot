import {
  type PendingApproval,
  type TaskSummary,
  visibleText,
} from "@jj/contracts";
import { useState } from "react";
import { useApi } from "../../api/ApiContext";
import { isApiError } from "../../api/client";
import {
  Button,
  buttonClass,
  ErrorBanner,
  StatusSquare,
} from "../../components/ui";
import { useWorkspace } from "../../state/WorkspaceContext";
import { taskHref } from "../shell/router";

/**
 * The task's calls waiting for the user's approval, under its card in direct
 * chat (`InlineTaskCard`, which loads this chunk while a task has one).
 */
export function ChatApprovals({ task }: { task: TaskSummary }) {
  return (
    <ul
      className="chat-approvals"
      aria-label={`Calls in ${task.title} waiting for your approval`}
    >
      {task.pendingApprovals.map((approval) => (
        <ChatApproval key={approval.id} taskId={task.id} approval={approval} />
      ))}
    </ul>
  );
}

/**
 * What happens after the answer: a held call's task goes on either way; a
 * spend approval's work goes on up to the cap, or stops at the threshold
 * (only the bot's, for its daily cap).
 */
function answeredText(
  approval: PendingApproval,
  answer: "approved" | "denied",
): string {
  if (approval.kind !== "spend")
    return `${answer === "approved" ? "Approved" : "Denied"}: the task goes on.`;
  if (approval.scope === "task")
    return answer === "approved"
      ? "Approved: the task goes on up to its cap."
      : "Denied: the task stops at the threshold.";
  return answer === "approved"
    ? "Approved: the bot goes on up to its daily cap."
    : "Denied: the bot's work in this task stops at the threshold.";
}

/**
 * A call waiting for the user's approval, under the task's card: what it
 * runs, with Approve and Deny. Approve is offered here only when the summary
 * is the whole call; otherwise "Review in the task" opens the task, whose
 * card shows all of it. Only the user answers; a reason for a denial is given
 * in the task chat.
 */
function ChatApproval({
  taskId,
  approval,
}: {
  taskId: string;
  approval: PendingApproval;
}) {
  const api = useApi();
  const { getBot } = useWorkspace();
  const [answer, setAnswer] = useState<"approved" | "denied" | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const name = getBot(approval.botId)?.name ?? "A bot";
  const decide = async (decision: "approve" | "deny") => {
    setBusy(true);
    setFailure(null);
    try {
      const answered = await api.decideApproval(taskId, approval.id, {
        decision,
      });
      setAnswer(answered.status === "approved" ? "approved" : "denied");
    } catch (error) {
      setFailure(isApiError(error) ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="chat-approval">
      <p className="chat-approval__text">
        <StatusSquare tone={answer ? "idle" : "verifying"} />
        {approval.kind === "spend" ? (
          // The summary is all of it: the cap and the threshold.
          <span>
            {approval.summary}:{" "}
            {approval.scope === "task"
              ? "no model call starts until you answer."
              : "none of the bot's model calls in this task starts until you answer."}
          </span>
        ) : (
          <span>
            {name} asks to run {approval.tool}:{" "}
            <code className="chat-approval__call">
              {visibleText(approval.summary)}
            </code>
            {!approval.shownInFull &&
              " (shortened: the task shows the whole call)"}
          </span>
        )}
      </p>
      {answer ? (
        <p className="chat-approval__answer" role="status">
          {answeredText(approval, answer)}
        </p>
      ) : (
        <div className="chat-approval__actions">
          {approval.shownInFull ? (
            <Button
              size="sm"
              variant="primary"
              disabled={busy}
              onClick={() => void decide("approve")}
              aria-label={`Approve: ${approval.summary}`}
            >
              Approve
            </Button>
          ) : (
            // The summary is not the whole call: approve it where all of it shows.
            <a
              className={buttonClass({ variant: "primary", size: "sm" })}
              href={taskHref(taskId)}
              aria-label={`Review in the task: ${visibleText(approval.summary)}`}
            >
              Review in the task
            </a>
          )}
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void decide("deny")}
            aria-label={`Deny: ${visibleText(approval.summary)}`}
          >
            Deny
          </Button>
        </div>
      )}
      {failure && (
        <ErrorBanner word="Not sent" onDismiss={() => setFailure(null)}>
          {failure}
        </ErrorBanner>
      )}
    </li>
  );
}
