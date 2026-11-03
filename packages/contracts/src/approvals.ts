import { z } from "zod";
import {
  CANONICAL_DEPTH_LIMIT,
  CANONICAL_LENGTH_LIMIT,
  type CanonicalProblem,
  canonicalForm,
} from "./canonical";
import { idSchema, timestampSchema } from "./common";
import {
  MCP_TOOL_PREFIX,
  type McpServer,
  type McpToolSnapshot,
  mcpServerOf,
  toolSelectorMatches,
} from "./mcp";
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

/**
 * A pending approval as task summaries carry it. `shownInFull` is true when
 * `summary` is the whole call (a bash command on one line within the summary
 * limit), so a client may offer Approve from the summary alone; otherwise the
 * whole call is on the task's approval card, and only it should offer Approve.
 */
export const pendingApprovalSchema = approvalSchema
  .pick({
    id: true,
    sessionId: true,
    botId: true,
    tool: true,
    summary: true,
    createdAt: true,
  })
  .extend({ shownInFull: z.boolean().default(false) });

/**
 * `POST /api/tasks/:taskId/approvals/:approvalId`. Only the user decides: no
 * agent tool, in a task or in direct chat, can. A blank reason counts as
 * none; only a denial takes one. An approval that is no longer pending
 * answers 409 APPROVAL_NOT_PENDING; a stopping or stopped task, 409
 * TASK_TERMINAL.
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
 * pattern and path for `grep` and `find`, the path for the other file
 * tools. For an MCP tool (`mcp__…`), the arguments' keys and string and
 * number values, unescaped, in canonical key order (`canonicalForm`'s
 * `words`), so a match sees what the call really holds: `rm -rf /` finds
 * `{"cmd":"rm -rf\n/"}` and `C:\Windows` finds `{"path":"C:\\Windows"}`.
 * Undefined when an MCP call's arguments have no canonical form
 * (`approvalSubjectProblem` says why); such a call fails closed.
 */
export function approvalSubject(
  tool: string,
  args: Record<string, unknown>,
): string | undefined {
  if (tool.startsWith(MCP_TOOL_PREFIX)) {
    const form = canonicalForm(args);
    return form.ok ? form.words : undefined;
  }
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

const UNREADABLE_ARGUMENTS: Record<CanonicalProblem, string> = {
  cycle: "refer to themselves",
  depth: `nest deeper than ${CANONICAL_DEPTH_LIMIT} levels`,
  length: `run longer than ${CANONICAL_LENGTH_LIMIT} characters as JSON`,
  unserializable: "hold a value JSON cannot represent",
};

/**
 * Why no rule's `match` can be checked against this call: its arguments (an
 * MCP tool's) have no canonical form. Undefined when they can, and for every
 * built-in tool. Such a call is held by every rule for its tool, `match` or
 * not, so it waits for the user (it fails closed); the approval card says why.
 */
export function approvalSubjectProblem(
  tool: string,
  args: Record<string, unknown>,
): string | undefined {
  if (!tool.startsWith(MCP_TOOL_PREFIX)) return undefined;
  const form = canonicalForm(args);
  return form.ok
    ? undefined
    : `Its arguments ${UNREADABLE_ARGUMENTS[form.problem]}, so no rule's match could be checked: every rule for ${tool} holds it.`;
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
 * True when the rule asks for approval of this call: the tool matches (the
 * same name, or `mcp__<server>__*` and a tool of that server) and,
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
  return matchingApprovalRule([rule], tool, args) !== undefined;
}

/**
 * The first rule that asks for approval of this call, if any. The call's
 * subject is built and collapsed once, however many rules are checked. A
 * call without a subject (`approvalSubjectProblem`) matches the first rule
 * for its tool, `match` or not: it fails closed. Never throws.
 */
export function matchingApprovalRule(
  rules: readonly ApprovalRule[],
  tool: string,
  args: Record<string, unknown>,
): ApprovalRule | undefined {
  let subject: string | null | undefined = null;
  return rules.find((rule) => {
    if (!toolSelectorMatches(rule.tool, tool)) return false;
    if (rule.match === undefined) return true;
    if (subject === null) {
      const raw = approvalSubject(tool, args);
      subject = raw === undefined ? undefined : collapse(raw);
    }
    if (subject === undefined) return true;
    return inOrder(subject, collapse(rule.match).split("*"));
  });
}

/**
 * Indexes of the exact MCP rules (`mcp__<server>__<tool>`, not `__*`) that
 * name no tool of their server's pinned snapshot. Exposed names hold only
 * within a snapshot: a new one can rename a tool (a name that now collides
 * gains the hash suffix), so such a rule would silently match nothing, and
 * a profile save refuses it. `servers` and `snapshots` are the profile's;
 * a rule for a server it lacks, or one without a snapshot, names no tool.
 */
export function mcpRulesWithoutTool(
  rules: readonly ApprovalRule[],
  servers: readonly McpServer[],
  snapshots: readonly McpToolSnapshot[],
): number[] {
  return rules.flatMap((rule, index) => {
    const server = mcpServerOf(rule.tool);
    if (server === undefined || rule.tool.endsWith("__*")) return [];
    const snapshotId = servers.find(
      (candidate) => candidate.name === server,
    )?.snapshotId;
    const snapshot = snapshots.find(
      (candidate) => candidate.id === snapshotId && candidate.server === server,
    );
    return snapshot?.tools.some((tool) => tool.exposedName === rule.tool)
      ? []
      : [index];
  });
}

/**
 * A rule on one line: "bash calls matching `git push*`", "every write
 * call", "every call to MCP server docs".
 */
export function describeApprovalRule(rule: ApprovalRule): string {
  const server = rule.tool.endsWith("__*") ? mcpServerOf(rule.tool) : undefined;
  if (server !== undefined)
    return rule.match === undefined
      ? `every call to MCP server ${server}`
      : `calls to MCP server ${server} matching \`${rule.match}\``;
  return rule.match === undefined
    ? `every ${rule.tool} call`
    : `${rule.tool} calls matching \`${rule.match}\``;
}

/**
 * Characters a reader cannot see in a call: controls other than tab and
 * newline, bidirectional controls, zero-width and other invisible format
 * characters, variation selectors and tag characters.
 */
const INVISIBLE =
  "[\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F\\u00AD\\u034F\\u061C\\u115F\\u1160\\u17B4\\u17B5\\u180B-\\u180F\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u206F\\u3164\\uFE00-\\uFE0F\\uFEFF\\uFFA0\\uFFF0-\\uFFFB]|\\uDB40[\\uDC00-\\uDDEF]";
const invisibleOne = new RegExp(INVISIBLE);
const invisibleAll = new RegExp(INVISIBLE, "g");

/** True when the text holds a character a reader cannot see (see `visibleText`). */
export const hasInvisible = (text: string): boolean => invisibleOne.test(text);

/**
 * The text with every character a reader cannot see written out as its code
 * point, `⟨U+202E⟩`, so what a card shows is what runs. Tabs and newlines
 * stay as they are.
 */
export function visibleText(text: string): string {
  return text.replace(
    invisibleAll,
    (character) =>
      `⟨U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}⟩`,
  );
}

/**
 * True when the approval's summary is its whole call, exactly as it will
 * run and with nothing in it a reader cannot see.
 */
export function shownInFull(
  approval: Pick<Approval, "tool" | "args" | "summary">,
): boolean {
  return (
    approval.tool === "bash" &&
    typeof approval.args.command === "string" &&
    approval.args.command === approval.summary &&
    !hasInvisible(approval.summary)
  );
}

/** The approval as task summaries carry it while it is pending. */
export function pendingApprovalOf(approval: Approval): PendingApproval {
  const { id, sessionId, botId, tool, summary, createdAt } = approval;
  return {
    id,
    sessionId,
    botId,
    tool,
    summary,
    createdAt,
    shownInFull: shownInFull(approval),
  };
}

export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;
export type ApprovalOutcome = z.infer<typeof approvalOutcomeSchema>;
export type Approval = z.infer<typeof approvalSchema>;
export type PendingApproval = z.infer<typeof pendingApprovalSchema>;
export type DecideApprovalCommand = z.input<typeof decideApprovalCommandSchema>;
