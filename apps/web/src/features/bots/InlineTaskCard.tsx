import {
  type PendingApproval,
  questionExcerpt,
  type TaskSummary,
  visibleText,
} from "@jj/contracts";
import { useId, useState } from "react";
import { useApi } from "../../api/ApiContext";
import { isApiError } from "../../api/client";
import {
  Button,
  buttonClass,
  ErrorBanner,
  Icon,
  StatusSquare,
} from "../../components/ui";
import { statusTitle, statusTone, statusWord } from "../../lib/status";
import { useWorkspace } from "../../state/WorkspaceContext";
import { taskHref } from "../shell/router";
import { verificationDisplay } from "../tasks/verification";

/**
 * The line under a card's title, from the summary the workspace keeps
 * current: a completed task's result, a failed task's error, or the
 * coordinator's question while the task waits for the user, on one line and
 * clipped as the summary's question is (CSS clamps it to two lines). Null
 * for a task at work or stopped.
 */
export function taskExcerpt(
  task: Pick<TaskSummary, "status" | "result" | "error" | "question">,
): { label: "Result" | "Error" | "Question"; text: string } | null {
  const outcome =
    task.status === "completed"
      ? { label: "Result" as const, text: task.result }
      : task.status === "failed"
        ? { label: "Error" as const, text: task.error }
        : task.status === "waiting"
          ? { label: "Question" as const, text: task.question }
          : null;
  const text = outcome?.text ? questionExcerpt(outcome.text) : undefined;
  return outcome && text ? { label: outcome.label, text } : null;
}

/**
 * The task a bot message is about (SPEC §4 inline task card): a link to
 * `#/tasks/:id` with the task's status square, title and status word, and
 * the start of a finished task's result or error or of a waiting task's
 * question. It reads the live task summary, so it shows the task's current
 * status, not its status when the message was written. The link is named by
 * the title and status; the excerpt is its description. The meta shows the
 * goal version and, for a task with checks, where they stand ("verified ·
 * 3/3" only when it completed with every check passed).
 */
export function InlineTaskCard({
  taskId,
  approvals = true,
}: {
  taskId: string;
  /** Shows the task's calls waiting for approval, with Approve and Deny. */
  approvals?: boolean;
}) {
  const { getTask } = useWorkspace();
  const excerptId = useId();
  const task = getTask(taskId);
  const excerpt = task ? taskExcerpt(task) : null;
  return (
    <>
      <TaskCardLink
        taskId={taskId}
        task={task}
        excerpt={excerpt}
        excerptId={excerptId}
      />
      {approvals && task && task.pendingApprovals.length > 0 && (
        <ul
          className="chat-approvals"
          aria-label={`Calls in ${task.title} waiting for your approval`}
        >
          {task.pendingApprovals.map((approval) => (
            <ChatApproval
              key={approval.id}
              taskId={taskId}
              approval={approval}
            />
          ))}
        </ul>
      )}
    </>
  );
}

function TaskCardLink({
  taskId,
  task,
  excerpt,
  excerptId,
}: {
  taskId: string;
  task: TaskSummary | undefined;
  excerpt: ReturnType<typeof taskExcerpt>;
  excerptId: string;
}) {
  const checks = task
    ? verificationDisplay(task, task.verification)
    : undefined;
  const checksText = checks ? ` · ${checks.word} ${checks.count}` : "";
  return (
    <a
      className="chat-task-card"
      href={taskHref(taskId)}
      aria-label={
        task
          ? `Task: ${task.title} ${statusWord(task)} · v${task.goalVersion}${checks ? ` · checks ${checks.word} ${checks.count}` : ""}`
          : "Task: Open the task"
      }
      aria-describedby={excerpt ? excerptId : undefined}
    >
      {task ? (
        <span className="chat-task-card__body">
          <span className="chat-task-card__head">
            <StatusSquare tone={statusTone(task)} />
            <span className="chat-task-card__title clamp1">{task.title}</span>
            <span className="chat-task-card__meta" title={statusTitle(task)}>
              {statusWord(task)} · v{task.goalVersion}
              {checksText}
            </span>
          </span>
          {excerpt && (
            <span id={excerptId} className="chat-task-card__excerpt clamp2">
              {excerpt.label} · {excerpt.text}
            </span>
          )}
        </span>
      ) : (
        <span className="chat-task-card__title clamp1">Open the task</span>
      )}
      <Icon name="arrow-right" size={15} className="chat-task-card__arrow" />
    </a>
  );
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
        <span>
          {name} asks to run {approval.tool}:{" "}
          <code className="chat-approval__call">
            {visibleText(approval.summary)}
          </code>
          {!approval.shownInFull &&
            " (shortened: the task shows the whole call)"}
        </span>
      </p>
      {answer ? (
        <p className="chat-approval__answer" role="status">
          {answer === "approved" ? "Approved" : "Denied"}: the task goes on.
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
