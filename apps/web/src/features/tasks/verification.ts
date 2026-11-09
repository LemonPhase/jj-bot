import {
  isVerified,
  type Task,
  type VerificationCheck,
  type VerificationCriterion,
  type VerificationSummary,
} from "@jj/contracts";
import type { StatusTone } from "../../lib/status";

/**
 * Verification as the task screens show it. Everything here derives from the
 * task's plan, its checks and the contract's `verificationSummary` and
 * `isVerified`; "verified" is never inferred from a status alone. The checks
 * editor's drafts are in ./checkDrafts.
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
