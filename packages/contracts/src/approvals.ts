import { z } from "zod";
import { idSchema, timestampSchema } from "./common";
import { type ApprovalRule, approvalRuleSchema } from "./profiles";

/**
 * Approvals: a call whose profile rule says it needs the user's approval
 * waits for it, without running, while its session waits too.
 *
 * - `pending`: waiting for the user. The call has not run.
 * - `approved`: the user approved it. It runs once when its session resumes
 *   (`startedAt`), and `outcome` says how it ended once its result is stored.
 * - `denied`: the user denied it; it never runs, and the model gets the
 *   denial, with the user's reason, as the call's error.
 * - `expired`: the goal (or its plan) changed before the user answered; it
 *   never runs.
 * - `cancelled`: the task was stopped or the session ended before it could
 *   run; it never runs. An approved call that had not started yet is
 *   cancelled too.
 */
export const APPROVAL_STATUSES = [
  "pending",
  "approved",
  "denied",
  "expired",
  "cancelled",
] as const;
export const approvalStatusSchema = z.enum(APPROVAL_STATUSES);

/** Longest `Approval.text`, in UTF-16 code units. */
export const APPROVAL_TEXT_LIMIT = 2_000;
/** Longest reason a denial carries. */
export const APPROVAL_REASON_LIMIT = 500;

/** How an approved call ended, once its result was stored. */
export const approvalOutcomeSchema = z.object({
  ok: z.boolean(),
  exitCode: z.number().int().nullable().optional(),
  /** `unknown`: it may have run; a restart lost its outcome. */
  interrupted: z.enum(["no", "yes", "unknown"]).optional(),
  /**
   * Set when the approved call was refused before it ran (its tool is no
   * longer granted, its arguments are invalid, its response was cut off):
   * why, as the bot was told.
   */
  refused: z.string().max(APPROVAL_REASON_LIMIT).optional(),
});

export const approvalSchema = z.object({
  id: idSchema,
  taskId: idSchema,
  sessionId: idSchema,
  /** The run that made the call. */
  runId: idSchema,
  botId: idSchema,
  /** Matches the `toolCallId` of the call's tool events. */
  toolCallId: idSchema,
  tool: z.string().min(1),
  /** One line: the command for bash, the path for file tools. */
  summary: z.string().max(300),
  /** The call's arguments as they will run, with the server's secrets redacted. */
  args: z.record(z.string(), z.unknown()),
  /** The profile rule that asked for approval. */
  rule: approvalRuleSchema,
  /** What the bot wrote with the call, redacted; empty when it wrote nothing. */
  text: z.string().max(APPROVAL_TEXT_LIMIT),
  /** The goal version the call was made at; a newer one expires it. */
  goalVersion: z.number().int().min(1),
  status: approvalStatusSchema,
  /** Denied: the user's reason, if they gave one. Expired or cancelled: why. */
  reason: z.string().nullable(),
  /** Set once an approved call's result is stored. */
  outcome: approvalOutcomeSchema.nullable(),
  createdAt: timestampSchema,
  decidedAt: timestampSchema.nullable(),
  /** When a run started the approved call. It starts at most once. */
  startedAt: timestampSchema.nullable(),
});

/** A pending approval as task summaries carry it. */
export const pendingApprovalSchema = approvalSchema.pick({
  id: true,
  sessionId: true,
  botId: true,
  tool: true,
  summary: true,
  createdAt: true,
});

/**
 * `POST /api/tasks/:taskId/approvals/:approvalId`. Only the user decides: no
 * agent tool, in a task or in direct chat, can. A blank reason counts as
 * none; only a denial takes one. An approval that is no longer pending
 * answers 409 APPROVAL_NOT_PENDING.
 */
export const decideApprovalCommandSchema = z
  .object({
    decision: z.enum(["approve", "deny"]),
    reason: z
      .string()
      .trim()
      .max(APPROVAL_REASON_LIMIT)
      .optional()
      .transform((reason) => reason || undefined),
  })
  .superRefine((command, context) => {
    if (command.decision === "approve" && command.reason !== undefined)
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "Only a denial takes a reason.",
      });
  });

const text = (value: unknown) => (typeof value === "string" ? value : "");

/**
 * What a rule's `match` is looked for in: the command for `bash`, the
 * pattern and path for `grep` and `find`, the path for the other file tools.
 */
export function approvalSubject(
  tool: string,
  args: Record<string, unknown>,
): string {
  switch (tool) {
    case "bash":
      return text(args.command);
    case "grep":
    case "find":
      return [text(args.pattern), text(args.path)].filter(Boolean).join(" ");
    default:
      return text(args.path);
  }
}

const collapse = (value: string) => value.replace(/\s+/g, " ").trim();

/**
 * True when the parts are found in `text` in order, each after the one
 * before. Leftmost matches are always enough for a pattern open at both
 * ends, so this is a linear scan with no backtracking, whatever the input.
 */
function inOrder(text: string, parts: readonly string[]): boolean {
  let from = 0;
  for (const part of parts) {
    if (!part) continue;
    const at = text.indexOf(part, from);
    if (at === -1) return false;
    from = at + part.length;
  }
  return true;
}

/**
 * True when the rule asks for approval of this call: the tool matches and,
 * when the rule has a `match`, its text is found in the call's subject.
 * Case-sensitive; `*` stands for any run of characters, and runs of
 * whitespace in either count as one space. Linear in the subject's length
 * (no regular expression), so a long command cannot stall the server. Pure,
 * so the profile editor can preview a rule.
 */
export function approvalRuleMatches(
  rule: ApprovalRule,
  tool: string,
  args: Record<string, unknown>,
): boolean {
  if (rule.tool !== tool) return false;
  if (rule.match === undefined) return true;
  return inOrder(
    collapse(approvalSubject(tool, args)),
    collapse(rule.match).split("*"),
  );
}

/** The first rule that asks for approval of this call, if any. */
export function matchingApprovalRule(
  rules: readonly ApprovalRule[],
  tool: string,
  args: Record<string, unknown>,
): ApprovalRule | undefined {
  return rules.find((rule) => approvalRuleMatches(rule, tool, args));
}

/** A rule on one line: "bash calls matching `git push*`", "every write call". */
export function describeApprovalRule(rule: ApprovalRule): string {
  return rule.match === undefined
    ? `every ${rule.tool} call`
    : `${rule.tool} calls matching \`${rule.match}\``;
}

export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;
export type ApprovalOutcome = z.infer<typeof approvalOutcomeSchema>;
export type Approval = z.infer<typeof approvalSchema>;
export type PendingApproval = z.infer<typeof pendingApprovalSchema>;
export type DecideApprovalCommand = z.input<typeof decideApprovalCommandSchema>;
