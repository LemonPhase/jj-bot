import { z } from "zod";
import { idSchema, timestampSchema } from "./common";

/**
 * Verification plans and the evidence their checks record. A plan belongs to
 * one goal version: changing it starts a new version, and evidence gathered
 * under an older version never counts (docs/verification.md).
 */

/** Most criteria one plan holds. */
export const VERIFICATION_PLAN_LIMIT = 20;
/** Longest command a `command` criterion runs. */
export const CHECK_COMMAND_LIMIT = 4000;
/** Longest `value` a `contains` or `matches` assertion takes. */
export const CHECK_VALUE_LIMIT = 2000;
/** Largest file a `file` criterion reads; a larger one is inconclusive. */
export const CHECK_FILE_LIMIT_BYTES = 1024 * 1024;
/** Cap on a check record's output preview (head and tail), in UTF-8 bytes. */
export const CHECK_OUTPUT_PREVIEW_LIMIT = 8 * 1024;
/** Longest `detail` of a check record. */
export const CHECK_DETAIL_LIMIT = 2000;

/** A criterion id: a short slug, unique within its plan. */
export const criterionIdSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/,
    "Use 1–64 letters, digits, - or _, starting with a letter or digit.",
  );

/**
 * What a `file` or `result` criterion asserts about its text: it `contains`
 * `value`, it `matches` the regular expression `value` (JavaScript syntax,
 * with optional `flags` from i, m and s), or it parses as `json`, valid
 * against `schema` (a JSON Schema object) when one is given. `exists` (files
 * only) passes when the path exists in the workspace.
 */
const TEXT_ASSERTIONS = ["contains", "matches", "json"] as const;
const FILE_ASSERTIONS = ["exists", ...TEXT_ASSERTIONS] as const;

const assertionFields = {
  value: z.string().min(1).max(CHECK_VALUE_LIMIT).optional(),
  flags: z
    .string()
    .regex(/^[ims]{0,3}$/, "Use only the regular expression flags i, m and s.")
    .optional(),
  schema: z.record(z.string(), z.unknown()).optional(),
};

const criterionBase = {
  id: criterionIdSchema,
  description: z.string().trim().min(1).max(500),
};

/**
 * One criterion of a plan, by `method`:
 * - `command`: runs `sh -c <command>` in the task's sandbox from the
 *   workspace root; passes only on exit code 0 with no interruption.
 *   `timeoutSeconds` can only shorten the sandbox's command limit.
 * - `file`: an assertion on a workspace file (`path` is workspace-relative).
 * - `result`: an assertion on the result text the coordinator passed to
 *   `complete_task`.
 */
export const verificationCriterionObjectSchema = z.discriminatedUnion(
  "method",
  [
    z.object({
      ...criterionBase,
      method: z.literal("command"),
      command: z.string().trim().min(1).max(CHECK_COMMAND_LIMIT),
      timeoutSeconds: z.number().int().min(1).max(86_400).optional(),
    }),
    z.object({
      ...criterionBase,
      method: z.literal("file"),
      path: z
        .string()
        .trim()
        .min(1)
        .max(1024)
        .refine(
          (path) =>
            !path.startsWith("/") &&
            !path.split(/[\\/]/).includes("..") &&
            !path.includes("\0"),
          "Use a path inside the workspace, relative to its root, without `..`.",
        ),
      expect: z.enum(FILE_ASSERTIONS),
      ...assertionFields,
    }),
    z.object({
      ...criterionBase,
      method: z.literal("result"),
      expect: z.enum(TEXT_ASSERTIONS),
      ...assertionFields,
    }),
  ],
);

type CriterionObject = z.infer<typeof verificationCriterionObjectSchema>;

/** Longest JSON Schema a criterion takes, as JSON text. */
export const CHECK_SCHEMA_LIMIT = 20_000;
const SCHEMA_DEPTH_LIMIT = 32;
const REFERENCE_KEYS = new Set(["$ref", "$dynamicRef", "$recursiveRef"]);

/** Keywords whose value maps names (properties, definitions) to schemas. */
const NAME_MAPS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);
/** Keywords whose value is data, not a schema. */
const DATA_KEYWORDS = new Set(["enum", "const", "default", "examples"]);

/**
 * Why a JSON Schema cannot be a criterion's, if it cannot: larger than
 * CHECK_SCHEMA_LIMIT, nested deeper than SCHEMA_DEPTH_LIMIT, or using a
 * reference keyword (a schema that refers to itself, such as
 * `{"$ref": "#"}`, would recurse without end when checked). A property, a
 * definition or data that is merely named `$ref` is allowed. Walked without
 * recursion, so a schema nested thousands of levels deep is refused, never a
 * stack overflow.
 */
function schemaShapeProblem(schema: unknown): string | undefined {
  type Kind = "schema" | "names" | "data";
  const stack: { value: unknown; depth: number; kind: Kind }[] = [
    { value: schema, depth: 0, kind: "schema" },
  ];
  let size = 0;
  for (let next = stack.pop(); next; next = stack.pop()) {
    const { value, depth, kind } = next;
    if (depth > SCHEMA_DEPTH_LIMIT)
      return `A JSON Schema may nest at most ${SCHEMA_DEPTH_LIMIT} levels.`;
    if (Array.isArray(value)) {
      size += 2;
      for (const item of value)
        stack.push({
          value: item,
          depth: depth + 1,
          kind: kind === "data" ? "data" : "schema",
        });
    } else if (value && typeof value === "object") {
      size += 2;
      for (const [key, item] of Object.entries(value)) {
        size += key.length + 3;
        if (kind === "schema" && REFERENCE_KEYS.has(key))
          return `JSON Schema references (${key}) are not supported; write the schema out in full.`;
        const child: Kind =
          kind === "data"
            ? "data"
            : kind === "names"
              ? "schema"
              : NAME_MAPS.has(key)
                ? "names"
                : DATA_KEYWORDS.has(key)
                  ? "data"
                  : "schema";
        stack.push({ value: item, depth: depth + 1, kind: child });
      }
    } else size += typeof value === "string" ? value.length + 2 : 8;
    if (size > CHECK_SCHEMA_LIMIT)
      return `A JSON Schema may be at most ${CHECK_SCHEMA_LIMIT} characters.`;
  }
  return undefined;
}

/** Field problems of a criterion's assertion, by field. Empty when it is well formed. */
function assertionProblems(
  criterion: CriterionObject,
): { path: string; message: string }[] {
  if (criterion.method === "command") return [];
  const problems: { path: string; message: string }[] = [];
  const needsValue =
    criterion.expect === "contains" || criterion.expect === "matches";
  if (needsValue && criterion.value === undefined)
    problems.push({
      path: "value",
      message: `\`${criterion.expect}\` needs a value.`,
    });
  if (!needsValue && criterion.value !== undefined)
    problems.push({
      path: "value",
      message: `\`${criterion.expect}\` takes no value.`,
    });
  if (criterion.flags !== undefined && criterion.expect !== "matches")
    problems.push({ path: "flags", message: "Only `matches` takes flags." });
  if (criterion.expect === "matches" && criterion.value !== undefined)
    try {
      new RegExp(criterion.value, criterion.flags);
    } catch (error) {
      problems.push({
        path: "value",
        message: `Not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  if (criterion.schema !== undefined) {
    const shape = schemaShapeProblem(criterion.schema);
    if (criterion.expect !== "json")
      problems.push({ path: "schema", message: "Only `json` takes a schema." });
    else if (shape) problems.push({ path: "schema", message: shape });
    else
      try {
        z.fromJSONSchema(criterion.schema as never);
      } catch (error) {
        problems.push({
          path: "schema",
          message: `Not a JSON Schema this server can check: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
  }
  return problems;
}

export const verificationCriterionSchema =
  verificationCriterionObjectSchema.superRefine((criterion, context) => {
    for (const problem of assertionProblems(criterion))
      context.addIssue({
        code: "custom",
        path: [problem.path],
        message: problem.message,
      });
  });

/**
 * Opt-in per task, written only by the user: 1 to VERIFICATION_PLAN_LIMIT
 * criteria with unique ids. A task with a plan completes only when every
 * criterion passes for the current goal version.
 */
export const verificationPlanSchema = z
  .array(verificationCriterionSchema)
  .min(1)
  .max(VERIFICATION_PLAN_LIMIT)
  .superRefine((plan, context) => {
    const seen = new Set<string>();
    plan.forEach((criterion, index) => {
      if (seen.has(criterion.id))
        context.addIssue({
          code: "custom",
          path: [index, "id"],
          message: `Criterion ids must be unique; "${criterion.id}" repeats.`,
        });
      seen.add(criterion.id);
    });
  });

export const CHECK_OUTCOMES = ["passed", "failed", "inconclusive"] as const;
export const checkOutcomeSchema = z.enum(CHECK_OUTCOMES);

/**
 * The evidence one check recorded: one criterion, evaluated once at one
 * attempt of one goal version. Append-only. `attempt` counts the gate runs
 * of its goal version from 1. `detail` says what was observed (the exit
 * code, the match or parse result); `output` is a command's redacted output
 * preview (head and tail), and `artifactId` holds its full output when the
 * preview did not fit. A check passes only with evidence.
 */
export const verificationCheckSchema = z
  .object({
    id: idSchema,
    taskId: idSchema,
    goalVersion: z.number().int().min(1),
    attempt: z.number().int().min(1),
    criterionId: criterionIdSchema,
    method: z.enum(["command", "file", "result"]),
    outcome: checkOutcomeSchema,
    /** Command checks: the exit code, null when the command never exited. */
    exitCode: z.number().int().nullable(),
    /** Command checks: whether the command was cut short. */
    interrupted: z.enum(["no", "yes", "unknown"]).nullable(),
    durationMs: z.number().int().nonnegative(),
    detail: z.string().min(1).max(CHECK_DETAIL_LIMIT),
    output: z.string().max(CHECK_OUTPUT_PREVIEW_LIMIT).nullable(),
    /** The output did not fit the preview; `artifactId` holds it when stored. */
    truncated: z.boolean(),
    artifactId: idSchema.nullable(),
    sessionId: idSchema.nullable(),
    runId: idSchema.nullable(),
    startedAt: timestampSchema,
    finishedAt: timestampSchema,
  })
  .superRefine((check, context) => {
    if (
      check.outcome === "passed" &&
      check.method === "command" &&
      (check.exitCode !== 0 || check.interrupted !== "no")
    )
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message:
          "A command check passes only on exit code 0 with no interruption.",
      });
  });

/**
 * Where a task's verification stands for its current goal version:
 * `pending` before its checks have run (or while they run), `passed` when
 * every criterion passed at the latest attempt, else `failed` (any failed)
 * or `inconclusive`.
 */
export const VERIFICATION_STATES = [
  "pending",
  "passed",
  "failed",
  "inconclusive",
] as const;

export const verificationSummarySchema = z.object({
  state: z.enum(VERIFICATION_STATES),
  goalVersion: z.number().int().min(1),
  /** The latest attempt at this goal version; null before any. */
  attempt: z.number().int().min(1).nullable(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  inconclusive: z.number().int().nonnegative(),
  total: z.number().int().min(1),
});

export type VerificationCriterion = z.infer<typeof verificationCriterionSchema>;
export type VerificationPlan = z.infer<typeof verificationPlanSchema>;
export type CheckOutcome = z.infer<typeof checkOutcomeSchema>;
export type VerificationCheck = z.infer<typeof verificationCheckSchema>;
export type VerificationState = (typeof VERIFICATION_STATES)[number];
export type VerificationSummary = z.infer<typeof verificationSummarySchema>;

type CheckFields = Pick<
  VerificationCheck,
  "goalVersion" | "attempt" | "criterionId" | "outcome"
>;

/**
 * The checks of `goalVersion`'s latest attempt, in `checks`' order (checks of
 * other versions and earlier attempts are superseded).
 */
export function latestAttemptChecks<Check extends CheckFields>(
  checks: readonly Check[],
  goalVersion: number,
): Check[] {
  let attempt = 0;
  for (const check of checks)
    if (check.goalVersion === goalVersion && check.attempt > attempt)
      attempt = check.attempt;
  return checks.filter(
    (check) => check.goalVersion === goalVersion && check.attempt === attempt,
  );
}

/**
 * The verification summary of a task from its plan and checks; undefined
 * for a task without a plan. Only evidence of the current goal version's
 * latest attempt counts, and a criterion without a check is not passed.
 */
export function verificationSummary(
  task: {
    goalVersion: number;
    verificationPlan: readonly { id: string }[] | null;
  },
  checks: readonly CheckFields[],
): VerificationSummary | undefined {
  const plan = task.verificationPlan;
  if (!plan || plan.length === 0) return undefined;
  const latest = latestAttemptChecks(checks, task.goalVersion);
  const outcomes = plan.map(
    (criterion) =>
      latest.find((check) => check.criterionId === criterion.id)?.outcome,
  );
  const count = (outcome: CheckOutcome) =>
    outcomes.filter((value) => value === outcome).length;
  const passed = count("passed");
  const failed = count("failed");
  const inconclusive = count("inconclusive");
  const state: VerificationState =
    passed === plan.length
      ? "passed"
      : failed > 0
        ? "failed"
        : inconclusive > 0
          ? "inconclusive"
          : "pending";
  return {
    state,
    goalVersion: task.goalVersion,
    attempt: latest[0]?.attempt ?? null,
    passed,
    failed,
    inconclusive,
    total: plan.length,
  };
}

/** JSON with object keys sorted, so a plan read back from storage compares equal. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}

/**
 * Whether two plans are the same, whatever their key order. A message that
 * repeats the current plan starts no new goal version.
 */
export function samePlan(
  a: readonly object[] | null | undefined,
  b: readonly object[] | null | undefined,
): boolean {
  return canonicalJson(a ?? null) === canonicalJson(b ?? null);
}

/**
 * The one rule for showing a task as verified: it completed, it has a plan,
 * and every criterion of that plan passed at the latest attempt of its
 * current goal version. A finished turn, a status or a passing session never
 * counts on its own.
 */
export function isVerified(
  task: { status: string; goalVersion: number },
  summary: VerificationSummary | undefined,
): boolean {
  return (
    task.status === "completed" &&
    summary !== undefined &&
    summary.state === "passed" &&
    summary.goalVersion === task.goalVersion &&
    summary.passed === summary.total
  );
}
