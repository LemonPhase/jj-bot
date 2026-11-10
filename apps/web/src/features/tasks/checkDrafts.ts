import {
  type VerificationCriterion,
  type VerificationPlan,
  verificationCriterionSchema,
} from "@jj/contracts";

/**
 * The checks editor's drafts: a task's or template's verification plan as
 * editable rows, and back. Loaded with the dialogs that edit checks, not
 * with the task cards that show them (./verification).
 */

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

const EMPTY_FIELD: Record<string, string> = {
  description: "Say what it checks.",
  command: "Give the command to run.",
  path: "Give the file's path in the workspace.",
  value: "Give the text to look for.",
};

/** A draft's first problem, in the editor's words. */
function draftProblem(
  field: PropertyKey | undefined,
  issue: { code: string; message: string } | undefined,
): string {
  const name = typeof field === "string" ? field : "";
  if (issue?.code === "too_small" && EMPTY_FIELD[name])
    return EMPTY_FIELD[name];
  return issue?.message ?? "Fix this check.";
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
      errors[draft.key] = draftProblem(issue?.path[0], issue);
    }
  });
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, plan: plan.length > 0 ? plan : null };
}
