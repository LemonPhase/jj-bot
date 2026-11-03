// What an approval card says. Its state never claims more than the record
// does: a pending call has not run, an approved one "runs" only once a run
// started it, and "ran" needs its stored outcome.
import type { Approval, PendingApproval, TaskView } from "@jj/contracts";
import type { StatusTone } from "../../lib/status";

export interface ApprovalState {
  /** The state, then what happened to the call: "waiting for your approval · not run". */
  text: string;
  tone: StatusTone;
  /** Why it did not run, when the record says (a refusal of the approved call). */
  detail?: string;
}

/** The card's state line, from the record alone. */
export function approvalState(approval: Approval): ApprovalState {
  switch (approval.status) {
    case "pending":
      return { text: "waiting for your approval · not run", tone: "verifying" };
    case "denied":
      return { text: "denied · not run", tone: "idle" };
    case "expired":
      return { text: "expired · not run", tone: "idle" };
    case "cancelled":
      return { text: "cancelled · not run", tone: "idle" };
    case "approved": {
      const { outcome } = approval;
      if (outcome?.refused)
        return {
          text: "approved · not run: refused",
          tone: "failed",
          detail: outcome.refused,
        };
      if (!approval.startedAt)
        return { text: "approved · waiting to run", tone: "running" };
      if (!outcome) return { text: "approved · running", tone: "running" };
      if (outcome.interrupted === "unknown")
        return { text: "interrupted · outcome unknown", tone: "failed" };
      if (outcome.interrupted === "yes")
        return { text: "interrupted · stopped", tone: "failed" };
      const exit =
        outcome.exitCode === undefined || outcome.exitCode === null
          ? ""
          : ` · exit ${outcome.exitCode}`;
      return outcome.ok
        ? { text: `ran${exit}`, tone: "completed" }
        : { text: `ran · failed${exit}`, tone: "failed" };
    }
  }
}

/** The call as the user reviews it: the whole command for bash, else the arguments. */
export function approvalCall(
  approval: Pick<Approval, "tool" | "args">,
): string {
  const { tool, args } = approval;
  if (tool === "bash" && typeof args.command === "string") return args.command;
  return JSON.stringify(args, null, 2);
}

/** The task's approvals still waiting for the user, oldest first. */
export const pendingOf = (approvals: readonly Approval[]): Approval[] =>
  approvals.filter((approval) => approval.status === "pending");

/** "1 approval waiting", "2 approvals waiting", or null for none. */
export function pendingLabel(
  pending: readonly (Approval | PendingApproval)[],
): string | null {
  if (pending.length === 0) return null;
  return `${pending.length} approval${pending.length === 1 ? "" : "s"} waiting`;
}

/** True while the task's coordinator holds a call: a message reaches it with the answer. */
export function coordinatorHolds(view: TaskView): boolean {
  const root = view.sessions.find(
    (session) => session.parentSessionId === null,
  );
  return Boolean(
    root &&
      view.approvals.some(
        (approval) =>
          approval.status === "pending" && approval.sessionId === root.id,
      ),
  );
}
