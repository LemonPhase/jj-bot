import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  API_ERROR_CODES,
  apiErrorCodeSchema,
  COMMAND_TEXT_LIMIT,
  createTaskTemplateCommandSchema,
  describeTemplateProblem,
  MAX_TASK_TEMPLATES,
  PROFILE_SPEND_CAP,
  startTemplateCommandSchema,
  TEMPLATE_INSTRUCTIONS_HEADING,
  TEMPLATE_INSTRUCTIONS_LIMIT,
  taskObjectSchema,
  taskSchema,
  taskTemplateListSchema,
  taskTemplateSchema,
  templateGoalTooLong,
  templateProblemSchema,
  templateRunGoal,
  templateTaskCommand,
  templateUnusableDetailsSchema,
  updateTaskTemplateCommandSchema,
  type VerificationPlan,
  workspaceHintSchema,
} from "./index";

const at = "2026-11-03T10:00:00.000Z";
const plan: VerificationPlan = [
  {
    id: "tests",
    description: "The tests pass",
    method: "command",
    command: "npm test",
  },
];
const template = {
  id: "tmpl_1",
  title: "Weekly report",
  goal: "Write the weekly report.",
  coordinatorBotId: "coord",
  participantBotIds: ["coord", "res"],
  verificationPlan: null,
  createdAt: at,
  updatedAt: at,
};

describe("contract version 1.9.0 (task templates)", () => {
  it("came with 1.9.0, which the changelog records", () => {
    const changelog = readFileSync(
      new URL("../../../docs/contract-changelog.md", import.meta.url),
      "utf8",
    );
    expect(changelog).toMatch(/^## 1\.9\.0 — .* — Task templates$/m);
  });

  it("adds TEMPLATE_UNUSABLE and the templates.changed hint", () => {
    expect(API_ERROR_CODES).toContain("TEMPLATE_UNUSABLE");
    expect(apiErrorCodeSchema.parse("TEMPLATE_UNUSABLE")).toBe(
      "TEMPLATE_UNUSABLE",
    );
    expect(workspaceHintSchema.parse({ type: "templates.changed" })).toEqual({
      type: "templates.changed",
    });
  });

  it("gives tasks a templateId, null for tasks stored before templates", () => {
    const stored = taskSchema.parse({
      id: "t1",
      title: "Old",
      goal: "Old goal",
      goalVersion: 1,
      coordinatorBotId: "coord",
      participantBotIds: ["coord"],
      status: "queued",
      result: null,
      error: null,
      cancelReason: null,
      cancelRequestedAt: null,
      createdAt: at,
      updatedAt: at,
      finishedAt: null,
    });
    expect(stored.templateId).toBeNull();
    expect(taskObjectSchema.shape.templateId.parse("tmpl_1")).toBe("tmpl_1");
  });
});

describe("task template records", () => {
  it("parses a stored template, problems empty and the cap left to the profile when omitted", () => {
    const parsed = taskTemplateSchema.parse(template);
    expect(parsed.problems).toEqual([]);
    expect("spendCapUsd" in parsed).toBe(false);
    expect(
      taskTemplateSchema.parse({ ...template, spendCapUsd: null }).spendCapUsd,
    ).toBeNull();
    expect(
      taskTemplateSchema.parse({ ...template, spendCapUsd: 2.5 }).spendCapUsd,
    ).toBe(2.5);
    expect(
      taskTemplateSchema.safeParse({ ...template, spendCapUsd: 0 }).success,
    ).toBe(false);
    expect(
      taskTemplateListSchema.parse({ templates: [template] }).templates,
    ).toHaveLength(1);
  });

  it("requires the coordinator among the participants, each once", () => {
    expect(
      taskTemplateSchema.safeParse({ ...template, participantBotIds: ["res"] })
        .success,
    ).toBe(false);
    expect(
      taskTemplateSchema.safeParse({
        ...template,
        participantBotIds: ["coord", "coord"],
      }).success,
    ).toBe(false);
  });

  it("lists each problem kind, and describes it in one line", () => {
    const problems = [
      { kind: "bot_archived", botId: "res", name: "Researcher" },
      {
        kind: "model_not_configured",
        botId: "coord",
        message: "Coord cannot run: no key for openai.",
      },
      { kind: "verification_unavailable" },
    ] as const;
    const parsed = taskTemplateSchema.parse({ ...template, problems });
    expect(parsed.problems).toEqual(problems);
    expect(parsed.problems.map(describeTemplateProblem)).toEqual([
      "Researcher is archived.",
      "Coord cannot run: no key for openai.",
      "This server does not enforce verification checks, and the template has some.",
    ]);
    expect(
      templateProblemSchema.safeParse({ kind: "bot_archived", botId: "x" })
        .success,
    ).toBe(false);
    expect(
      templateUnusableDetailsSchema.safeParse({ problems: [] }).success,
    ).toBe(false);
  });
});

describe("template commands", () => {
  it("creates with a required title of 1–120 characters and adds the coordinator", () => {
    const parsed = createTaskTemplateCommandSchema.parse({
      title: "  Weekly report  ",
      goal: "Write it.",
      coordinatorBotId: "coord",
      participantBotIds: ["res"],
    });
    expect(parsed.title).toBe("Weekly report");
    expect(parsed.participantBotIds).toEqual(["coord", "res"]);
    for (const title of [undefined, "", "   ", "x".repeat(121)])
      expect(
        createTaskTemplateCommandSchema.safeParse({
          title,
          goal: "Write it.",
          coordinatorBotId: "coord",
        }).success,
      ).toBe(false);
    expect(
      createTaskTemplateCommandSchema.safeParse({
        title: "x".repeat(120),
        goal: "g".repeat(COMMAND_TEXT_LIMIT),
        coordinatorBotId: "coord",
        verificationPlan: plan,
        spendCapUsd: null,
      }).success,
    ).toBe(true);
    expect(
      createTaskTemplateCommandSchema.safeParse({
        title: "Too long",
        goal: "g".repeat(COMMAND_TEXT_LIMIT + 1),
        coordinatorBotId: "coord",
      }).success,
    ).toBe(false);
  });

  it("updates any field, never filling defaults, and can go back to the profile's cap", () => {
    expect(updateTaskTemplateCommandSchema.safeParse({}).success).toBe(false);
    expect(updateTaskTemplateCommandSchema.parse({ title: "New" })).toEqual({
      title: "New",
    });
    for (const spendCapUsd of [3, null, PROFILE_SPEND_CAP])
      expect(
        updateTaskTemplateCommandSchema.parse({ spendCapUsd }).spendCapUsd,
      ).toBe(spendCapUsd);
    expect(
      updateTaskTemplateCommandSchema.safeParse({ spendCapUsd: "none" })
        .success,
    ).toBe(false);
    expect(
      updateTaskTemplateCommandSchema.parse({ participantBotIds: [] }),
    ).toEqual({ participantBotIds: [] });
  });

  it("starts with optional instructions of 1–4000 characters, a title and a cap", () => {
    expect(startTemplateCommandSchema.parse({})).toEqual({ uploads: [] });
    expect(
      startTemplateCommandSchema.parse({ instructions: "  Focus on Q3.  " })
        .instructions,
    ).toBe("Focus on Q3.");
    for (const instructions of [
      "",
      "   ",
      "x".repeat(TEMPLATE_INSTRUCTIONS_LIMIT + 1),
    ])
      expect(
        startTemplateCommandSchema.safeParse({ instructions }).success,
      ).toBe(false);
    expect(
      startTemplateCommandSchema.safeParse({
        instructions: "x".repeat(TEMPLATE_INSTRUCTIONS_LIMIT),
        title: "Run 3",
        spendCapUsd: null,
      }).success,
    ).toBe(true);
    expect(
      startTemplateCommandSchema.safeParse({ title: "x".repeat(121) }).success,
    ).toBe(false);
    expect(
      startTemplateCommandSchema.safeParse({ spendCapUsd: -1 }).success,
    ).toBe(false);
    expect(MAX_TASK_TEMPLATES).toBe(200);
  });
});

describe("starting a template", () => {
  it("appends the run's instructions to the goal under their heading", () => {
    expect(templateRunGoal("Write it.")).toBe("Write it.");
    expect(templateRunGoal("Write it.", "Only the summary.")).toBe(
      `Write it.\n\n${TEMPLATE_INSTRUCTIONS_HEADING}\nOnly the summary.`,
    );
    expect(TEMPLATE_INSTRUCTIONS_HEADING).toBe("Instructions for this run:");
  });

  it("measures the combined goal against the task goal limit", () => {
    const heading = `\n\n${TEMPLATE_INSTRUCTIONS_HEADING}\n`.length;
    const goal = "g".repeat(COMMAND_TEXT_LIMIT - heading - 10);
    expect(templateGoalTooLong(goal, "i".repeat(10))).toBe(false);
    expect(templateGoalTooLong(goal, "i".repeat(11))).toBe(true);
    expect(templateGoalTooLong("g".repeat(COMMAND_TEXT_LIMIT))).toBe(false);
  });

  it("builds the create-task command from the template and the start options", () => {
    const stored = taskTemplateSchema.parse({
      ...template,
      verificationPlan: plan,
    });
    expect(templateTaskCommand(stored)).toEqual({
      goal: "Write the weekly report.",
      title: "Weekly report",
      coordinatorBotId: "coord",
      participantBotIds: ["coord", "res"],
      verificationPlan: plan,
    });
    // The cap: the template's when it has one, the start's over it.
    expect(
      templateTaskCommand({ ...stored, spendCapUsd: null }).spendCapUsd,
    ).toBeNull();
    expect(
      templateTaskCommand({ ...stored, spendCapUsd: 2 }, { spendCapUsd: 7 })
        .spendCapUsd,
    ).toBe(7);
    expect(
      templateTaskCommand(stored, { spendCapUsd: null }).spendCapUsd,
    ).toBeNull();
    expect(
      templateTaskCommand(stored, { instructions: "Q3 only.", title: "Q3" }),
    ).toMatchObject({
      title: "Q3",
      goal: `Write the weekly report.\n\n${TEMPLATE_INSTRUCTIONS_HEADING}\nQ3 only.`,
    });
  });
});
