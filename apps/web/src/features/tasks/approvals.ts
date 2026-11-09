// What an approval card says. Its state never claims more than the record
// does: a pending call has not run, an approved one "runs" only once a run
// started it, and "ran" needs its stored outcome.
import {
  type Approval,
  approvalSubjectProblem,
  canonicalJson,
  MCP_TOOL_PREFIX,
  type PendingApproval,
  type SpendApproval,
  type TaskView,
  type ToolApproval,
} from "@jj/contracts";
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
  if (approval.kind === "spend") return spendApprovalState(approval);
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

/**
 * A spend approval's state line: no model call it covers starts while it
 * waits; a denial stopped the task at the threshold; an expiry means the cap
 * (or the question) changed before the answer.
 */
export function spendApprovalState(approval: SpendApproval): ApprovalState {
  switch (approval.status) {
    case "pending":
      return { text: "waiting · no model calls", tone: "verifying" };
    case "approved":
      return { text: "approved", tone: "completed" };
    case "denied":
      // A bot's daily cap holds only that bot's sessions in the task.
      return {
        text:
          approval.scope === "task"
            ? "denied · task stopped"
            : "denied · this bot stopped",
        tone: "idle",
      };
    case "expired":
      return {
        text: approval.reason?.includes("turned off")
          ? "expired · question turned off"
          : approval.reason?.includes("reached")
            ? "expired · cap reached"
            : "expired · cap changed",
        tone: "idle",
      };
    case "cancelled":
      return { text: "cancelled", tone: "idle" };
  }
}

/** Longest preview of arguments that have no canonical form, in characters. */
export const PREVIEW_LIMIT = 4_000;
/** Deepest level such a preview shows. */
export const PREVIEW_DEPTH = 16;

/**
 * As much of a value as can be shown when it has no canonical form: keys
 * in canonical order, `…` past PREVIEW_DEPTH levels or `limit` characters,
 * `⟨cycle⟩` where a value contains itself, and `⟨not JSON⟩` for a value
 * JSON cannot hold. Never throws. The card writes invisible characters
 * out (`visibleText`) as for every call.
 */
export function argumentsPreview(
  value: unknown,
  limit = PREVIEW_LIMIT,
): string {
  let out = "";
  const ancestors = new Set<object>();
  const add = (part: string) => {
    out += part;
  };
  const walk = (current: unknown, depth: number): void => {
    if (out.length > limit) return;
    switch (typeof current) {
      case "string":
        return add(JSON.stringify(current.slice(0, limit)));
      case "number":
        return add(Number.isFinite(current) ? String(current) : "null");
      case "boolean":
        return add(String(current));
      case "bigint":
        return add(`${current}n`);
      case "undefined":
        return add("null");
      case "object":
        break;
      default:
        return add("⟨not JSON⟩");
    }
    if (current === null) return add("null");
    if (depth >= PREVIEW_DEPTH) return add("…");
    if (ancestors.has(current)) return add("⟨cycle⟩");
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        add("[");
        for (let index = 0; index < current.length; index += 1) {
          if (out.length > limit) break;
          if (index > 0) add(",");
          walk(current[index], depth + 1);
        }
        add("]");
        return;
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null)
        return add("⟨not JSON⟩");
      const record = current as Record<string, unknown>;
      add("{");
      let first = true;
      for (const key of Object.keys(record).sort()) {
        if (out.length > limit) break;
        if (!first) add(",");
        first = false;
        add(`${JSON.stringify(key.slice(0, limit))}:`);
        walk(record[key], depth + 1);
      }
      add("}");
    } catch {
      add("⟨unreadable⟩");
    } finally {
      ancestors.delete(current);
    }
  };
  walk(value, 0);
  return out.length > limit ? `${out.slice(0, limit)}…` : out;
}

/**
 * The call as the user reviews it: the whole command for bash, an MCP
 * tool's arguments as canonical one-line JSON (or, when they have none, as
 * much as `argumentsPreview` can show; `approvalProblem` says why), else the
 * arguments.
 */
export function approvalCall(
  approval: Pick<ToolApproval, "tool" | "args">,
): string {
  const { tool, args } = approval;
  if (tool === "bash" && typeof args.command === "string") return args.command;
  if (tool.startsWith(MCP_TOOL_PREFIX))
    return canonicalJson(args) ?? argumentsPreview(args);
  return JSON.stringify(args, null, 2);
}

/** Why the call waits whatever its rule's match: its arguments could not be checked. */
export const approvalProblem = (
  approval: Pick<ToolApproval, "tool" | "args">,
) => approvalSubjectProblem(approval.tool, approval.args);

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

/**
 * True while an approval holds the task's coordinator (a call of its own, or
 * spend past a threshold that covers it): a message reaches it with the
 * answer.
 */
export function coordinatorHolds(view: TaskView): boolean {
  const root = view.sessions.find(
    (session) => session.parentSessionId === null,
  );
  return Boolean(
    root &&
      view.approvals.some(
        (approval) =>
          approval.status === "pending" &&
          (approval.kind === "spend"
            ? approval.scope === "task" || approval.botId === root.botId
            : approval.sessionId === root.id),
      ),
  );
}
