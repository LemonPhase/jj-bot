// Verification plans and their evidence as the engine reads them: the plan's
// text for prompts and messages, the latest checks of a goal version, and the
// summary every view and lookup uses. The gate that runs checks is in
// worker/gate.ts.
import {
  type CheckOutcome,
  latestAttemptChecks,
  type VerificationCheck,
  type VerificationCriterion,
  type VerificationPlan,
  type VerificationSummary,
  verificationSummary,
} from "@jj/contracts";
import {
  type Executor,
  type TaskRow,
  tasks as tasksTable,
  verificationChecks,
} from "@jj/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { planOf, toVerificationCheck } from "../records";

/**
 * This build accepts and enforces verification plans
 * (`capabilities.verification`): bootstrap reports it, and a template with a
 * plan is unusable without it.
 */
export const VERIFICATION_ENFORCED = true;

const quoted = (text: string) => JSON.stringify(text);

/** What one criterion requires, in a line: "command `npm test` exits with code 0". */
export function criterionRule(criterion: VerificationCriterion): string {
  if (criterion.method === "command")
    return `the command \`${criterion.command}\` exits with code 0${
      criterion.timeoutSeconds ? ` within ${criterion.timeoutSeconds} s` : ""
    }`;
  const subject =
    criterion.method === "file"
      ? `the file \`${criterion.path}\``
      : "the result you pass to `complete_task`";
  switch (criterion.expect) {
    case "exists":
      return `${subject} exists`;
    case "contains":
      return `${subject} contains ${quoted(criterion.value ?? "")}`;
    case "matches":
      return `${subject} matches the regular expression /${criterion.value ?? ""}/${criterion.flags ?? ""}`;
    case "json":
      return criterion.schema
        ? `${subject} is JSON valid against this JSON Schema: ${JSON.stringify(criterion.schema)}`
        : `${subject} is valid JSON`;
  }
}

/** The plan as lines: `- <id>: <description> (<rule>)`. */
export function describePlan(plan: VerificationPlan): string {
  return plan
    .map(
      (criterion) =>
        `- ${criterion.id}: ${criterion.description} (${criterionRule(criterion)})`,
    )
    .join("\n");
}

/**
 * Checks of the latest attempt of each goal version of these tasks, ordered
 * by task, goal version and plan position (as a task view carries them).
 */
export async function latestChecks(
  exec: Executor,
  taskIds: readonly string[],
): Promise<Map<string, VerificationCheck[]>> {
  const result = new Map<string, VerificationCheck[]>();
  if (taskIds.length === 0) return result;
  const rows = await exec
    .select()
    .from(verificationChecks)
    .where(inArray(verificationChecks.taskId, [...taskIds]))
    .orderBy(
      asc(verificationChecks.taskId),
      asc(verificationChecks.goalVersion),
      asc(verificationChecks.attempt),
      asc(verificationChecks.position),
    );
  const all = new Map<string, VerificationCheck[]>();
  for (const row of rows) {
    const list = all.get(row.taskId) ?? [];
    list.push(toVerificationCheck(row));
    all.set(row.taskId, list);
  }
  for (const [taskId, checks] of all) {
    const versions = [...new Set(checks.map((check) => check.goalVersion))];
    result.set(
      taskId,
      versions.flatMap((version) => latestAttemptChecks(checks, version)),
    );
  }
  return result;
}

/**
 * The outcomes (criterion, goal version, attempt) of the latest attempt of
 * each task's current goal version: what a task summary needs, without the
 * checks' details and output previews.
 */
export async function latestOutcomes(
  exec: Executor,
  tasks: readonly { id: string; goalVersion: number }[],
): Promise<
  Map<
    string,
    {
      goalVersion: number;
      attempt: number;
      criterionId: string;
      outcome: CheckOutcome;
    }[]
  >
> {
  const result = new Map<
    string,
    {
      goalVersion: number;
      attempt: number;
      criterionId: string;
      outcome: CheckOutcome;
    }[]
  >();
  if (tasks.length === 0) return result;
  const rows = await exec
    .select({
      taskId: verificationChecks.taskId,
      goalVersion: verificationChecks.goalVersion,
      attempt: verificationChecks.attempt,
      criterionId: verificationChecks.criterionId,
      outcome: verificationChecks.outcome,
    })
    .from(verificationChecks)
    // Only each task's current goal version: earlier versions' rows never count.
    .innerJoin(
      tasksTable,
      and(
        eq(tasksTable.id, verificationChecks.taskId),
        eq(tasksTable.goalVersion, verificationChecks.goalVersion),
      ),
    )
    .where(
      inArray(
        verificationChecks.taskId,
        tasks.map((task) => task.id),
      ),
    );
  for (const task of tasks)
    result.set(
      task.id,
      latestAttemptChecks(
        rows.filter((row) => row.taskId === task.id),
        task.goalVersion,
      ),
    );
  return result;
}

/** The checks of one attempt of one goal version, in plan order. */
export async function attemptChecks(
  exec: Executor,
  taskId: string,
  goalVersion: number,
  attempt: number,
): Promise<VerificationCheck[]> {
  const rows = await exec
    .select()
    .from(verificationChecks)
    .where(
      and(
        eq(verificationChecks.taskId, taskId),
        eq(verificationChecks.goalVersion, goalVersion),
        eq(verificationChecks.attempt, attempt),
      ),
    )
    .orderBy(asc(verificationChecks.position));
  return rows.map(toVerificationCheck);
}

/** The task's verification summary for its current goal version; undefined without a plan. */
export async function taskVerification(
  exec: Executor,
  task: Pick<TaskRow, "id" | "goalVersion" | "verificationPlan">,
): Promise<VerificationSummary | undefined> {
  const plan = planOf(task.verificationPlan);
  if (!plan) return undefined;
  const checks = (await latestChecks(exec, [task.id])).get(task.id) ?? [];
  return verificationSummary(
    { goalVersion: task.goalVersion, verificationPlan: plan },
    checks,
  );
}

/** "passed 3 of 3 checks (goal version 2, attempt 1)", for task state and updates. */
export function summaryLine(summary: VerificationSummary): string {
  const where = `goal version ${summary.goalVersion}${summary.attempt ? `, attempt ${summary.attempt}` : ""}`;
  switch (summary.state) {
    case "pending":
      return summary.attempt
        ? `checks running or incomplete (${where})`
        : `not checked yet for goal version ${summary.goalVersion}`;
    case "passed":
      return `passed ${summary.passed} of ${summary.total} checks (${where})`;
    case "failed":
      return `failed: ${summary.failed} of ${summary.total} checks failed${summary.inconclusive ? `, ${summary.inconclusive} inconclusive` : ""} (${where})`;
    case "inconclusive":
      return `inconclusive: ${summary.inconclusive} of ${summary.total} checks could not be evaluated (${where})`;
  }
}
