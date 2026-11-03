import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMMAND_TEXT_LIMIT,
  MAX_TASK_TEMPLATES,
  PROFILE_SPEND_CAP,
  type TaskView,
  TEMPLATE_INSTRUCTIONS_HEADING,
  taskTemplateSchema,
  templateRunGoal,
  templateUnusableDetailsSchema,
  type VerificationPlan,
  type WorkspaceHint,
} from "@jj/contracts";
import {
  jobs,
  openDatabase,
  runtimeProfiles,
  sessionInbox,
  sessions,
  taskEvents,
  taskGoalVersions,
  taskMessages,
  taskParticipants,
  tasks,
  taskTemplates,
  usage,
} from "@jj/db";
import { asc, count, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DomainError } from "./errors";
import { FAKE_MODEL } from "./testing/fake-executor";
import { FakeModels } from "./testing/fakes";
import {
  OPEN_TIMEOUT,
  openTestDatabase,
  type TestDatabase,
  type TestEngine,
  testEngine,
  uniqueName,
  until,
} from "./testing/harness";
import { createTeam } from "./testing/scenarios";

let db: TestDatabase;
const opened: TestEngine[] = [];

beforeAll(async () => {
  db = await openTestDatabase();
}, OPEN_TIMEOUT);
afterEach(async () => {
  for (const engine of opened.splice(0)) await engine.dispose();
});
afterAll(async () => {
  await db?.close();
});

/** An engine whose worker never runs, so a started task stays as created. */
async function setup(
  options: Parameters<typeof testEngine>[1] = {},
  database = db.database,
) {
  const engine = await testEngine(database, { start: false, ...options });
  opened.push(engine);
  return engine;
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(DomainError);
  return error as DomainError;
}

const plan: VerificationPlan = [
  {
    id: "notes",
    description: "The notes exist",
    method: "file",
    path: "notes.md",
    expect: "exists",
  },
];

/** Rows a start could write: none may appear when it is refused. */
async function written() {
  const [taskCount] = await db.database.db
    .select({ value: count() })
    .from(tasks);
  const [eventCount] = await db.database.db
    .select({ value: count() })
    .from(taskEvents);
  const [jobCount] = await db.database.db.select({ value: count() }).from(jobs);
  return {
    tasks: taskCount?.value,
    events: eventCount?.value,
    jobs: jobCount?.value,
  };
}

/** Ids the engine mints for a new task's records; bots and profiles are shared, so they stay. */
const MINTED =
  /^(task|sess|run|inbox|msg|evt|art|use|appr|chk|job|upd)_[0-9A-Z]{26}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * Everything a task holds once created: its whole view (task, sessions,
 * messages, events with their payloads, usage) and every row the creation
 * wrote, with the ids it minted numbered by first appearance, times blanked
 * and `templateId` (`template_id`) nulled. Two tasks created alike read the
 * same.
 */
async function created(view: TaskView) {
  const taskId = view.task.id;
  const rows = {
    task: await db.database.db.select().from(tasks).where(eq(tasks.id, taskId)),
    participants: await db.database.db
      .select()
      .from(taskParticipants)
      .where(eq(taskParticipants.taskId, taskId))
      .orderBy(asc(taskParticipants.botId)),
    versions: await db.database.db
      .select()
      .from(taskGoalVersions)
      .where(eq(taskGoalVersions.taskId, taskId))
      .orderBy(asc(taskGoalVersions.version)),
    sessions: await db.database.db
      .select()
      .from(sessions)
      .where(eq(sessions.taskId, taskId))
      .orderBy(asc(sessions.id)),
    inbox: await db.database.db
      .select()
      .from(sessionInbox)
      .where(eq(sessionInbox.taskId, taskId))
      .orderBy(asc(sessionInbox.id)),
    messages: await db.database.db
      .select()
      .from(taskMessages)
      .where(eq(taskMessages.taskId, taskId))
      .orderBy(asc(taskMessages.sequence)),
    events: await db.database.db
      .select()
      .from(taskEvents)
      .where(eq(taskEvents.taskId, taskId))
      .orderBy(asc(taskEvents.sequence)),
    jobs: await db.database.db
      .select()
      .from(jobs)
      .where(eq(jobs.taskId, taskId))
      .orderBy(asc(jobs.id)),
  };
  const ids = new Map<string, string>();
  const walk = (value: unknown, key?: string): unknown => {
    if (key === "templateId") return null;
    if (value instanceof Date) return "<time>";
    if (typeof value === "string") {
      if (ISO_TIME.test(value)) return "<time>";
      if (!MINTED.test(value)) return value;
      if (!ids.has(value))
        ids.set(value, `<${value.split("_")[0]} ${ids.size + 1}>`);
      return ids.get(value);
    }
    if (Array.isArray(value)) return value.map((item) => walk(item));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([name, item]) => [name, walk(item, name)]),
      );
    return value;
  };
  return walk({ view, rows }) as { view: TaskView; rows: typeof rows };
}

const templateHints = (hints: WorkspaceHint[]) =>
  hints.filter((hint) => hint.type === "templates.changed").length;

describe("task templates: create, read, update, delete", () => {
  it("saves, lists, edits and deletes a template, hinting each change", async () => {
    const { engine } = await setup();
    const team = await createTeam(engine, ["Lead", "Writer", "Checker"]);
    const [lead, writer, checker] = team.ids as [string, string, string];
    const hints: WorkspaceHint[] = [];
    const unsubscribe = await engine.subscribeHints((hint) => hints.push(hint));

    const { template } = await engine.templates.create({
      title: "  Weekly report  ",
      goal: "Write the weekly report to report.md.",
      coordinatorBotId: lead,
      participantBotIds: [writer],
      verificationPlan: plan,
      spendCapUsd: 2.5,
    });
    expect(taskTemplateSchema.parse(template)).toEqual(template);
    expect(template).toMatchObject({
      title: "Weekly report",
      coordinatorBotId: lead,
      participantBotIds: [lead, writer],
      verificationPlan: plan,
      spendCapUsd: 2.5,
      problems: [],
    });
    expect(template.id).toMatch(/^tmpl_/);
    expect((await engine.templates.get(template.id)).template).toEqual(
      template,
    );
    expect(
      (await engine.templates.list()).templates.map((entry) => entry.id),
    ).toContain(template.id);

    // Participants replaced whole, the coordinator added back; the cap three ways.
    const edited = await engine.templates.update(template.id, {
      title: "Weekly report v2",
      participantBotIds: [checker],
      spendCapUsd: null,
    });
    expect(edited.template).toMatchObject({
      title: "Weekly report v2",
      goal: template.goal,
      participantBotIds: [lead, checker],
      verificationPlan: plan,
      spendCapUsd: null,
    });
    const inherit = await engine.templates.update(template.id, {
      spendCapUsd: PROFILE_SPEND_CAP,
      verificationPlan: null,
    });
    expect("spendCapUsd" in inherit.template).toBe(false);
    expect(inherit.template.verificationPlan).toBeNull();
    // A new coordinator joins the roster; the old one stays a participant.
    const handedOver = await engine.templates.update(template.id, {
      coordinatorBotId: writer,
    });
    expect(handedOver.template.coordinatorBotId).toBe(writer);
    expect(handedOver.template.participantBotIds).toEqual([
      writer,
      ...[lead, checker].sort(),
    ]);
    expect((await refusal(engine.templates.update(template.id, {}))).code).toBe(
      "VALIDATION_FAILED",
    );

    await engine.templates.delete(template.id);
    for (const call of [
      () => engine.templates.get(template.id),
      () => engine.templates.update(template.id, { title: "Gone" }),
      () => engine.templates.delete(template.id),
      () => engine.templates.start(template.id, {}),
    ])
      expect((await refusal(call())).code).toBe("NOT_FOUND");

    await until(() => templateHints(hints) >= 5);
    await unsubscribe();
    expect(templateHints(hints)).toBe(5);
  });

  it("refuses unknown and archived bots at save, as task creation does, storing nothing", async () => {
    const { engine } = await setup();
    const team = await createTeam(engine, ["Keeper", "Leaver"]);
    const [keeper, leaver] = team.ids as [string, string];
    await engine.bots.archive(leaver);
    const [before] = await db.database.db
      .select({ value: count() })
      .from(taskTemplates);
    for (const participantBotIds of [["bot_nobody"], [leaver]]) {
      const error = await refusal(
        engine.templates.create({
          title: "Bad roster",
          goal: "Never saved.",
          coordinatorBotId: keeper,
          participantBotIds,
        }),
      );
      expect(error.code).toBe("VALIDATION_FAILED");
      expect(error.details).toEqual({ botIds: participantBotIds });
    }
    const { template } = await engine.templates.create({
      title: "Good roster",
      goal: "Saved.",
      coordinatorBotId: keeper,
    });
    expect(
      (
        await refusal(
          engine.templates.update(template.id, { participantBotIds: [leaver] }),
        )
      ).code,
    ).toBe("VALIDATION_FAILED");
    expect((await engine.templates.get(template.id)).template).toEqual(
      template,
    );
    const [after] = await db.database.db
      .select({ value: count() })
      .from(taskTemplates);
    expect(after?.value).toBe((before?.value ?? 0) + 1);
  });

  it(
    "keeps at most MAX_TASK_TEMPLATES, answering CONFLICT past it",
    async () => {
      const own = await openTestDatabase();
      try {
        const { engine } = await setup({}, own.database);
        const team = await createTeam(engine, ["Many"]);
        const coordinatorBotId = team.ids[0] as string;
        const now = new Date();
        await own.database.db.insert(taskTemplates).values(
          Array.from({ length: MAX_TASK_TEMPLATES - 1 }, (_, index) => ({
            id: `tmpl_bulk_${index}`,
            title: `Bulk ${index}`,
            goal: "Bulk.",
            coordinatorBotId,
            participantBotIds: [coordinatorBotId],
            createdAt: now,
            updatedAt: now,
          })),
        );
        await engine.templates.create({
          title: "The last one",
          goal: "Fits.",
          coordinatorBotId,
        });
        const error = await refusal(
          engine.templates.create({
            title: "One too many",
            goal: "Does not fit.",
            coordinatorBotId,
          }),
        );
        expect(error.code).toBe("CONFLICT");
        expect(error.details).toEqual({ limit: MAX_TASK_TEMPLATES });
        expect((await engine.templates.list()).templates).toHaveLength(
          MAX_TASK_TEMPLATES,
        );
      } finally {
        for (const engine of opened.splice(0)) await engine.dispose();
        await own.close();
      }
    },
    OPEN_TIMEOUT,
  );

  it("survives a restart: a new engine on the same database reads every template", async () => {
    const first = await setup();
    const team = await createTeam(first.engine, ["Restart"]);
    const { template } = await first.engine.templates.create({
      title: "Survives",
      goal: "Still here after a restart.",
      coordinatorBotId: team.ids[0] as string,
      spendCapUsd: null,
    });
    const { template: edited } = await first.engine.templates.update(
      template.id,
      { goal: "Edited before the restart." },
    );
    await first.dispose();
    opened.splice(opened.indexOf(first), 1);

    const second = await setup();
    expect((await second.engine.templates.get(template.id)).template).toEqual(
      edited,
    );
  });

  it(
    "survives reopening an embedded database from disk",
    async () => {
      const path = await mkdtemp(join(tmpdir(), "jj-templates-"));
      try {
        const database = await openDatabase({
          mode: "pglite",
          path,
          onError: () => {},
        });
        const first = await setup({}, database);
        const team = await createTeam(first.engine, ["Disk"]);
        const { template } = await first.engine.templates.create({
          title: "On disk",
          goal: "Kept in the data directory.",
          coordinatorBotId: team.ids[0] as string,
          verificationPlan: plan,
          spendCapUsd: 1.25,
        });
        await first.dispose();
        opened.splice(opened.indexOf(first), 1);
        await database.close();

        const reopened = await openDatabase({
          mode: "pglite",
          path,
          onError: () => {},
        });
        try {
          const second = await setup({}, reopened);
          expect((await second.engine.templates.list()).templates).toEqual([
            template,
          ]);
          await second.dispose();
          opened.splice(opened.indexOf(second), 1);
        } finally {
          await reopened.close();
        }
      } finally {
        await rm(path, { recursive: true, force: true });
      }
    },
    OPEN_TIMEOUT,
  );
});

describe("starting a template", () => {
  it("creates the same task as createTask with the same fields, for each kind of cap", async () => {
    const { engine } = await setup();
    // A profile whose task cap a start reads then, not when the template was saved.
    const { profile } = await engine.profiles.create({
      name: uniqueName("Template cap"),
      sandbox: { driver: "local", network: { mode: "open" } },
      budgets: { maxUsdPerTask: 1.5 },
    });
    const { bot: lead } = await engine.bots.create({
      name: uniqueName("Lead"),
      runtimeProfileId: profile.id,
    });
    const team = await createTeam(engine, ["Helper"]);
    const helper = team.ids[0] as string;
    const fields = {
      title: "Same task",
      goal: "Write notes.md with the findings.",
      coordinatorBotId: lead.id,
      participantBotIds: [helper],
      verificationPlan: plan,
    };

    for (const cap of [{}, { spendCapUsd: 4 }, { spendCapUsd: null }]) {
      const { template } = await engine.templates.create({
        ...fields,
        ...cap,
      });
      await engine.profiles.update(profile.id, {
        budgets: { maxUsdPerTask: 2.75 },
      });
      const started = await engine.templates.start(template.id, {});
      const manual = await engine.tasks.create({ ...fields, ...cap });
      expect(started.task.templateId).toBe(template.id);
      expect(manual.task.templateId).toBeNull();
      expect(started.task.spendCapUsd).toBe(
        "spendCapUsd" in cap ? cap.spendCapUsd : 2.75,
      );
      const [fromTemplate, fromForm] = await Promise.all([
        engine.tasks.get(started.task.id),
        engine.tasks.get(manual.task.id),
      ]);
      expect(fromTemplate.task.templateId).toBe(template.id);
      const shape = await created(fromTemplate);
      expect(shape).toEqual(await created(fromForm));
      // What the equivalence covers, among the rest: the roster, the
      // task.created payload, goal version 1 and the root brief.
      expect(shape.view.task.participantBotIds).toEqual([lead.id, helper]);
      const [createdEvent] = shape.rows.events;
      expect(createdEvent?.type).toBe("task.created");
      expect(createdEvent?.payload).toMatchObject({
        task: {
          participantBotIds: [lead.id, helper],
          verificationPlan: plan,
          spendCapUsd: started.task.spendCapUsd,
        },
      });
      expect(shape.rows.versions).toMatchObject([
        {
          version: 1,
          goal: fields.goal,
          verificationPlan: plan,
          author: "user",
        },
      ]);
      expect(shape.rows.inbox).toMatchObject([
        {
          kind: "brief",
          text: expect.stringContaining(`Goal (version 1):\n${fields.goal}`),
        },
      ]);
      expect(shape.rows.jobs).toMatchObject([
        { kind: "session.run", status: "queued" },
      ]);
      await engine.profiles.update(profile.id, {
        budgets: { maxUsdPerTask: 1.5 },
      });
    }
  });

  it("appends the run's instructions to the goal, and takes the run's title and cap", async () => {
    const { engine } = await setup();
    const team = await createTeam(engine, ["Solo"]);
    const fields = {
      title: "Daily digest",
      goal: "Summarise the inbox.",
      coordinatorBotId: team.ids[0] as string,
      spendCapUsd: 3,
    };
    const { template } = await engine.templates.create(fields);
    const started = await engine.templates.start(template.id, {
      instructions: "  Only the unread ones.  ",
      title: "Digest for Monday",
      spendCapUsd: null,
    });
    const goal = `Summarise the inbox.\n\n${TEMPLATE_INSTRUCTIONS_HEADING}\nOnly the unread ones.`;
    expect(goal).toBe(templateRunGoal(fields.goal, "Only the unread ones."));
    expect(started.task).toMatchObject({
      title: "Digest for Monday",
      goal,
      spendCapUsd: null,
      templateId: template.id,
    });
    const manual = await engine.tasks.create({
      ...fields,
      title: "Digest for Monday",
      goal,
      spendCapUsd: null,
    });
    expect(await created(await engine.tasks.get(started.task.id))).toEqual(
      await created(await engine.tasks.get(manual.task.id)),
    );
    // The template itself is unchanged.
    expect((await engine.templates.get(template.id)).template).toEqual(
      template,
    );
  });

  it("answers 422 when the goal with the instructions is over the task limit, writing nothing", async () => {
    const { engine } = await setup();
    const team = await createTeam(engine, ["Wordy"]);
    const { template } = await engine.templates.create({
      title: "Long goal",
      goal: "g".repeat(COMMAND_TEXT_LIMIT - 30),
      coordinatorBotId: team.ids[0] as string,
    });
    const before = await written();
    const error = await refusal(
      engine.templates.start(template.id, { instructions: "x".repeat(10) }),
    );
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.status).toBe(422);
    expect(await written()).toEqual(before);
    // Without instructions it fits.
    expect(
      (await engine.templates.start(template.id, {})).task.goal,
    ).toHaveLength(COMMAND_TEXT_LIMIT - 30);
  });

  it("lists an archived participant as a problem and refuses to start without it, writing nothing", async () => {
    const { engine } = await setup();
    const team = await createTeam(engine, ["Stays", "Archived"]);
    const [stays, archived] = team.ids as [string, string];
    const name = team.names[1] as string;
    const { template } = await engine.templates.create({
      title: "Two bots",
      goal: "Needs both.",
      coordinatorBotId: stays,
      participantBotIds: [archived],
    });
    await engine.bots.archive(archived);
    const problems = [{ kind: "bot_archived", botId: archived, name }];
    expect((await engine.templates.get(template.id)).template.problems).toEqual(
      problems,
    );
    expect(
      (await engine.templates.list()).templates.find(
        (entry) => entry.id === template.id,
      )?.problems,
    ).toEqual(problems);

    const before = await written();
    const error = await refusal(engine.templates.start(template.id, {}));
    expect(error.code).toBe("TEMPLATE_UNUSABLE");
    expect(error.status).toBe(409);
    expect(templateUnusableDetailsSchema.parse(error.details)).toEqual({
      problems,
    });
    expect(error.message).toContain(`${name} is archived.`);
    expect(await written()).toEqual(before);

    // Replacing the archived bot makes it usable again.
    const { template: fixed } = await engine.templates.update(template.id, {
      participantBotIds: [stays],
    });
    expect(fixed.problems).toEqual([]);
    expect(
      (await engine.templates.start(template.id, {})).task.templateId,
    ).toBe(template.id);
  });

  it("lists a model that cannot run as a problem and refuses to start, writing nothing", async () => {
    const { engine } = await setup();
    const team = await createTeam(engine, ["Modelled"]);
    const { template } = await engine.templates.create({
      title: "Needs a model",
      goal: "Think.",
      coordinatorBotId: team.ids[0] as string,
    });
    expect(template.problems).toEqual([]);
    // The same database, served without any configured model.
    const { engine: keyless } = await setup({
      models: new FakeModels(false),
    });
    const problems = [
      {
        kind: "model_not_configured",
        botId: team.ids[0],
        message: `${team.names[0]} cannot run: No model provider is configured.`,
      },
    ];
    expect(
      (await keyless.templates.get(template.id)).template.problems,
    ).toEqual(problems);
    const before = await written();
    const error = await refusal(keyless.templates.start(template.id, {}));
    expect(error.code).toBe("TEMPLATE_UNUSABLE");
    expect(error.details).toEqual({ problems });
    expect(await written()).toEqual(before);
  });

  it("answers SPEND_CAP_REACHED for a coordinator at its daily cap, writing nothing", async () => {
    const { engine } = await setup();
    const { profile } = await engine.profiles.create({
      name: uniqueName("Spent profile"),
      sandbox: { driver: "local", network: { mode: "open" } },
      budgets: { maxUsdPerBotPerDay: 0.01 },
    });
    const { bot } = await engine.bots.create({
      name: uniqueName("Spent"),
      runtimeProfileId: profile.id,
    });
    const { template } = await engine.templates.create({
      title: "Too expensive",
      goal: "Spend.",
      coordinatorBotId: bot.id,
    });
    await db.database.db.insert(usage).values({
      id: `use_${bot.id}`,
      botId: bot.id,
      model: FAKE_MODEL,
      costUsd: 0.01,
    });
    const before = await written();
    const error = await refusal(engine.templates.start(template.id, {}));
    expect(error.code).toBe("SPEND_CAP_REACHED");
    expect(error.details).toMatchObject({ scope: "bot", botId: bot.id });
    expect(await written()).toEqual(before);
    // Not a template problem: the cap is checked at start.
    expect((await engine.templates.get(template.id)).template.problems).toEqual(
      [],
    );
  });

  it("leaves the tasks a template started unchanged when it is deleted", async () => {
    const { engine } = await setup();
    const team = await createTeam(engine, ["Orphan"]);
    const { template } = await engine.templates.create({
      title: "Short-lived",
      goal: "Start once.",
      coordinatorBotId: team.ids[0] as string,
    });
    const { task } = await engine.templates.start(template.id, {});
    await engine.templates.delete(template.id);
    const view = await engine.tasks.get(task.id);
    expect(view.task.templateId).toBe(template.id);
    expect(
      (await engine.tasks.list()).tasks.find((entry) => entry.id === task.id)
        ?.templateId,
    ).toBe(template.id);
    const [row] = await db.database.db
      .select({ templateId: tasks.templateId })
      .from(tasks)
      .where(eq(tasks.id, task.id));
    expect(row?.templateId).toBe(template.id);
  });

  it("re-reads the coordinator's profile cap at every start", async () => {
    const { engine } = await setup();
    const [defaultProfile] = await db.database.db
      .select()
      .from(runtimeProfiles)
      .where(eq(runtimeProfiles.isDefault, true));
    expect(defaultProfile).toBeDefined();
    const team = await createTeam(engine, ["Inherits"]);
    const { template } = await engine.templates.create({
      title: "Profile cap",
      goal: "Inherit the cap.",
      coordinatorBotId: team.ids[0] as string,
    });
    const first = await engine.templates.start(template.id, {});
    expect(first.task.spendCapUsd).toBe(5);
    await engine.profiles.update(defaultProfile?.id as string, {
      budgets: { maxUsdPerTask: 0.5 },
    });
    try {
      const second = await engine.templates.start(template.id, {});
      expect(second.task.spendCapUsd).toBe(0.5);
    } finally {
      await engine.profiles.update(defaultProfile?.id as string, {
        budgets: { maxUsdPerTask: 5 },
      });
    }
  });
});
