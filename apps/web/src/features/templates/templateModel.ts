import {
  type Bot,
  describeTemplateProblem,
  profileBudgetsSchema,
  type RuntimeProfile,
  type Task,
  type TaskTemplate,
  type TemplateProblem,
  type VerificationPlan,
} from "@jj/contracts";
import { formatCap } from "../tasks/format";

/** How a template sets a started task's cap: the profile's at start, none, or an amount. */
export type CapChoice = "profile" | "none" | "amount";

/** What the template editor holds while the user edits it. */
export interface TemplateDraft {
  title: string;
  goal: string;
  coordinatorId: string;
  /** The other participants, archived bots included until the user saves. */
  others: string[];
  plan: VerificationPlan | null;
  cap: CapChoice;
  /** The amount when `cap` is `amount`. */
  capText: string;
}

const capOf = (
  spendCapUsd: number | null | undefined,
): Pick<TemplateDraft, "cap" | "capText"> =>
  spendCapUsd === undefined
    ? { cap: "profile", capText: "" }
    : spendCapUsd === null
      ? { cap: "none", capText: "" }
      : { cap: "amount", capText: String(spendCapUsd) };

/** A new template: the first bot coordinates, the profile's cap applies. */
export function blankDraft(bots: readonly Bot[]): TemplateDraft {
  return {
    title: "",
    goal: "",
    coordinatorId: bots[0]?.id ?? "",
    others: [],
    plan: null,
    ...capOf(undefined),
  };
}

export function draftFromTemplate(template: TaskTemplate): TemplateDraft {
  return {
    title: template.title,
    goal: template.goal,
    coordinatorId: template.coordinatorBotId,
    others: template.participantBotIds.filter(
      (botId) => botId !== template.coordinatorBotId,
    ),
    plan: template.verificationPlan,
    ...capOf(template.spendCapUsd),
  };
}

/**
 * "Save as template": the task as it is now (its current goal, roster, plan
 * and cap). The cap is the task's own, so the template keeps the amount
 * rather than the profile's at start.
 */
export function draftFromTask(task: Task): TemplateDraft {
  return {
    title: task.title,
    goal: task.goal,
    coordinatorId: task.coordinatorBotId,
    others: task.participantBotIds.filter(
      (botId) => botId !== task.coordinatorBotId,
    ),
    plan: task.verificationPlan,
    ...capOf(task.spendCapUsd),
  };
}

/** The profile a bot runs with, as the server picks it: its own, else the default. */
export function profileOf(
  bot: Pick<Bot, "runtimeProfileId"> | undefined,
  profiles: readonly RuntimeProfile[],
): RuntimeProfile | undefined {
  return bot?.runtimeProfileId
    ? profiles.find((profile) => profile.id === bot.runtimeProfileId)
    : profiles.find((profile) => profile.isDefault);
}

/** The cap a start sets now, and where it comes from, in words. */
export function resolvedCapLine(
  template: Pick<TaskTemplate, "spendCapUsd" | "coordinatorBotId">,
  bots: readonly Bot[],
  profiles: readonly RuntimeProfile[],
): string {
  if (template.spendCapUsd === null) return "No cap, as the template says.";
  if (template.spendCapUsd !== undefined)
    return `${formatCap(template.spendCapUsd)}, as the template says.`;
  const coordinator = bots.find((bot) => bot.id === template.coordinatorBotId);
  const profileCap = (
    profileOf(coordinator, profiles)?.budgets ?? profileBudgetsSchema.parse({})
  ).maxUsdPerTask;
  const whose = coordinator ? `${coordinator.name}'s profile` : "the profile";
  return profileCap === null
    ? `No cap: ${whose} sets none.`
    : `${formatCap(profileCap)}, from ${whose}.`;
}

/** The problems of a template, one sentence each. */
export const problemLines = (problems: readonly TemplateProblem[]) =>
  problems.map(describeTemplateProblem);

/** A template's team in words: "Kite coordinates, with Vesper". */
export function teamLine(
  template: Pick<TaskTemplate, "coordinatorBotId" | "participantBotIds">,
  nameOf: (botId: string) => string,
): string {
  const others = template.participantBotIds
    .filter((botId) => botId !== template.coordinatorBotId)
    .map(nameOf);
  const lead = `${nameOf(template.coordinatorBotId)} coordinates`;
  return others.length > 0 ? `${lead}, with ${others.join(", ")}` : lead;
}
