import {
  isVerified,
  type Task,
  type VerificationCheck,
  type VerificationCriterion,
  type VerificationPlan,
  type VerificationSummary,
  verificationCriterionSchema,
} from "@jj/contracts";
import type { StatusTone } from "../../lib/status";

/**
 * Verification as the task screens show it. Everything here derives from the
 * task's plan, its checks and the contract's `verificationSummary` and
 * `isVerified`; "verified" is never inferred from a status alone.
 */

export interface VerificationDisplay {
  /** "verified", "passed", "failed", "inconclusive" or "not checked". */
  word: string;
  tone: StatusTone;
  /** "2/3": criteria passed of the plan, at the current goal version. */
  count: string;
  /** One sentence for a tooltip or a screen reader. */
  sentence: string;
}

/** How a task's verification reads; undefined for a task without a plan. */
export function verificationDisplay(
  task: Pick<Task, "status" | "goalVersion">,
  summary: VerificationSummary | undefined,
): VerificationDisplay | undefined {
  if (!summary) return undefined;
  const count = `${summary.passed}/${summary.total}`;
  const where = `goal v${summary.goalVersion}${summary.attempt ? `, attempt ${summary.attempt}` : ""}`;
  if (isVerified(task, summary))
    return {
      word: "verified",
      tone: "completed",
      count,
      sentence: `Verified: every check passed (${where}).`,
    };
  switch (summary.state) {
    case "passed":
      return {
        word: "passed",
        tone: "verifying",
        count,
        sentence: `Every check passed (${where}), but the task has not completed with them, so it is not verified.`,
      };
    case "failed":
      return {
        word: "failed",
        tone: "failed",
        count,
        sentence: `Not verified: ${summary.failed} of ${summary.total} checks failed (${where}).`,
      };
    case "inconclusive":
      return {
        word: "inconclusive",
        tone: "verifying",
        count,
        sentence: `Not verified: ${summary.inconclusive} of ${summary.total} checks could not be evaluated (${where}).`,
      };
    default:
      return {
        word: summary.attempt ? "checking" : "not checked",
        tone: "idle",
        count,
        sentence: summary.attempt
          ? `Not verified yet: the checks of ${where} are running or incomplete.`
          : `Not verified: the checks have not run for goal v${summary.goalVersion}.`,
      };
  }
}

/** What a criterion requires, in a few words: "`npm test` exits 0". */
export function criterionRule(criterion: VerificationCriterion): string {
  if (criterion.method === "command") return `\`${criterion.command}\` exits 0`;
  const subject = criterion.method === "file" ? criterion.path : "the result";
  switch (criterion.expect) {
    case "exists":
      return `${subject} exists`;
    case "contains":
      return `${subject} contains "${criterion.value ?? ""}"`;
    case "matches":
      return `${subject} matches /${criterion.value ?? ""}/${criterion.flags ?? ""}`;
    case "json":
      return criterion.schema
        ? `${subject} is JSON valid against a schema`
        : `${subject} is valid JSON`;
  }
}

const seconds = (ms: number) =>
  ms < 1000 ? `${ms} ms` : `${Math.round(ms / 100) / 10} s`;

/** "exit 1 · 4.2 s · attempt 2". */
export function checkMeta(check: VerificationCheck): string {
  return [
    check.exitCode !== null ? `exit ${check.exitCode}` : undefined,
    check.interrupted && check.interrupted !== "no"
      ? `interrupted: ${check.interrupted}`
      : undefined,
    seconds(check.durationMs),
    `attempt ${check.attempt}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

export const OUTCOME_TONE: Record<VerificationCheck["outcome"], StatusTone> = {
  passed: "completed",
  failed: "failed",
  inconclusive: "verifying",
};

/** Checks of goal versions before the current one, newest version first. */
export function supersededVersions(
  checks: readonly VerificationCheck[],
  goalVersion: number,
): { goalVersion: number; checks: VerificationCheck[] }[] {
  const versions = [
    ...new Set(
      checks
        .filter((check) => check.goalVersion < goalVersion)
        .map((check) => check.goalVersion),
    ),
  ].sort((a, b) => b - a);
  return versions.map((version) => ({
    goalVersion: version,
    checks: checks.filter((check) => check.goalVersion === version),
  }));
}

// ── The checks editor's drafts ──────────────────────────────────────────

export type CheckMethod = VerificationCriterion["method"];
export type CheckExpect = "exists" | "contains" | "matches" | "json";

/** One editable criterion. `base` keeps what the editor does not show (flags, schema, timeout). */
export interface CheckDraft {
  key: string;
  id: string;
  description: string;
  method: CheckMethod;
  command: string;
  path: string;
  expect: CheckExpect;
  value: string;
  base?: VerificationCriterion;
}

let drafted = 0;
const nextKey = () => `draft-${++drafted}`;

export function emptyDraft(): CheckDraft {
  return {
    key: nextKey(),
    id: "",
    description: "",
    method: "command",
    command: "",
    path: "",
    expect: "exists",
    value: "",
  };
}

export function draftsFromPlan(
  plan: VerificationPlan | null | undefined,
): CheckDraft[] {
  return (plan ?? []).map((criterion) => ({
    key: nextKey(),
    id: criterion.id,
    description: criterion.description,
    method: criterion.method,
    command: criterion.method === "command" ? criterion.command : "",
    path: criterion.method === "file" ? criterion.path : "",
    expect: criterion.method === "command" ? "exists" : criterion.expect,
    value: criterion.method === "command" ? "" : (criterion.value ?? ""),
    base: criterion,
  }));
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

/** The criterion a draft describes (not yet validated). */
function criterionOf(draft: CheckDraft, id: string): unknown {
  const base = draft.base?.method === draft.method ? draft.base : undefined;
  const common = { id, description: draft.description.trim() };
  if (draft.method === "command")
    return {
      ...common,
      method: "command",
      command: draft.command.trim(),
      ...(base?.method === "command" && base.timeoutSeconds
        ? { timeoutSeconds: base.timeoutSeconds }
        : {}),
    };
  const expect =
    draft.method === "result" && draft.expect === "exists"
      ? "contains"
      : draft.expect;
  const kept =
    base && base.method !== "command" && base.expect === expect
      ? {
          ...(base.flags !== undefined ? { flags: base.flags } : {}),
          ...(base.schema !== undefined ? { schema: base.schema } : {}),
        }
      : {};
  return {
    ...common,
    method: draft.method,
    ...(draft.method === "file" ? { path: draft.path.trim() } : {}),
    expect,
    ...(expect === "contains" || expect === "matches"
      ? { value: draft.value }
      : {}),
    ...kept,
  };
}

/**
 * The plan the drafts make, or each invalid draft's first problem by key.
 * New criteria get ids from their descriptions; kept ones keep theirs.
 */
export function planFromDrafts(
  drafts: readonly CheckDraft[],
):
  | { ok: true; plan: VerificationPlan | null }
  | { ok: false; errors: Record<string, string> } {
  const used = new Set(drafts.map((draft) => draft.id).filter(Boolean));
  const plan: VerificationPlan = [];
  const errors: Record<string, string> = {};
  drafts.forEach((draft, index) => {
    let id = draft.id;
    if (!id) {
      const stem = slug(draft.description) || `check-${index + 1}`;
      id = stem;
      for (let n = 2; used.has(id); n += 1) id = `${stem}-${n}`;
      used.add(id);
    }
    const parsed = verificationCriterionSchema.safeParse(
      criterionOf(draft, id),
    );
    if (parsed.success) plan.push(parsed.data);
    else {
      const issue = parsed.error.issues[0];
      const field = issue?.path[0];
      errors[draft.key] =
        `${field === "description" ? "Say what it checks" : field === "command" ? "Give the command" : field === "path" ? "Give a workspace path" : field === "value" ? "Give the value" : "Fix this check"}: ${issue?.message ?? "invalid"}`;
    }
  });
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, plan: plan.length > 0 ? plan : null };
}
