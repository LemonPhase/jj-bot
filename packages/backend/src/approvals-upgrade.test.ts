// A tool approval and its event stored before spend approvals (the
// `approvals_spend` migration added `approvals.kind` and the `spend` column,
// after `0014_event_retention`, where this seeds them): after the upgrade the
// row is a tool approval, the stored event parses as one, and it is answered
// as before. Runs on PGlite only; the migration itself is checked against a
// new install by the @jj/db upgrade tests.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  taskEventSchema,
  taskSummarySchema,
  taskViewSchema,
} from "@jj/contracts";
import { approvals, type Database, openDatabase } from "@jj/db";
import { seedAt } from "@jj/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPEN_TIMEOUT, type TestEngine, testEngine } from "./testing/harness";

const AT = "2026-11-08T10:00:00.000Z";

/** The approval as a 1.10 server recorded it, in its row and its event. */
const APPROVAL = {
  id: "appr_old",
  taskId: "task_old",
  sessionId: "sess_old",
  runId: "run_old",
  botId: "bot_old",
  toolCallId: "call_old",
  tool: "bash",
  summary: "git push",
  args: { command: "git push" },
  rule: { tool: "bash", match: "git push" },
  text: "",
  goalVersion: 1,
  status: "pending",
  reason: null,
  outcome: null,
  createdAt: AT,
  decidedAt: null,
  startedAt: null,
};

const json = (value: unknown) => `'${JSON.stringify(value)}'::jsonb`;

let directory: string;
let database: Database;
let current: TestEngine;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "jj-approvals-upgrade-"));
  const location = { mode: "pglite", path: directory } as const;
  await seedAt(
    location,
    "0014_event_retention",
    `insert into bots (id, name) values ('bot_old', 'Ada');
    insert into tasks (id, title, goal, coordinator_bot_id, status, event_seq, created_at, updated_at)
      values ('task_old', 'Push', 'Push the work', 'bot_old', 'waiting', 1, '${AT}', '${AT}');
    insert into task_participants (task_id, bot_id) values ('task_old', 'bot_old');
    insert into task_goal_versions (task_id, version, goal, author, created_at)
      values ('task_old', 1, 'Push the work', 'user', '${AT}');
    insert into sessions (id, task_id, bot_id, role, brief, goal_version, depth, status, waiting_for, run_count, created_at, updated_at)
      values ('sess_old', 'task_old', 'bot_old', 'coordinator', 'Push the work', 1, 0, 'waiting', 'approval', 1, '${AT}', '${AT}');
    insert into approvals (id, task_id, session_id, run_id, bot_id, tool_call_id, tool, summary, args, rule, goal_version, status, created_at)
      values ('appr_old', 'task_old', 'sess_old', 'run_old', 'bot_old', 'call_old', 'bash', 'git push',
        ${json(APPROVAL.args)}, ${json(APPROVAL.rule)}, 1, 'pending', '${AT}');
    insert into task_events (id, task_id, sequence, type, bot_id, session_id, run_id, payload, occurred_at)
      values ('evt_old', 'task_old', 1, 'approval.requested', 'bot_old', 'sess_old', 'run_old',
        ${json({ approval: APPROVAL })}, '${AT}');`,
  );
  database = await openDatabase({ ...location, onError: () => {} });
  current = await testEngine(database, { start: false });
}, OPEN_TIMEOUT);
afterAll(async () => {
  await current?.dispose();
  await database?.close();
  await rm(directory, { recursive: true, force: true });
}, OPEN_TIMEOUT);

describe("an approval stored before spend approvals", () => {
  it("is a tool approval after the upgrade, its stored event parses as one, and it is answered as before", async () => {
    const { engine } = current;
    const [row] = await database.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, "appr_old"));
    expect(row).toMatchObject({ kind: "tool", spend: null, tool: "bash" });

    const view = taskViewSchema.parse(await engine.tasks.get("task_old"));
    expect(view.approvals).toEqual([
      expect.objectContaining({ kind: "tool", id: "appr_old", tool: "bash" }),
    ]);
    const [stored] = (await engine.tasks.events("task_old", {})).events;
    const event = taskEventSchema.parse(stored);
    expect(event.type).toBe("approval.requested");
    if (event.type !== "approval.requested") throw new Error("unreachable");
    expect(event.payload.approval).toMatchObject({
      kind: "tool",
      id: "appr_old",
      summary: "git push",
    });
    const { tasks } = await engine.tasks.list();
    expect(
      taskSummarySchema.parse(tasks.find((task) => task.id === "task_old"))
        .pendingApprovals,
    ).toEqual([
      expect.objectContaining({
        kind: "tool",
        id: "appr_old",
        summary: "git push",
        shownInFull: true,
      }),
    ]);

    const { approval } = await engine.tasks.decideApproval(
      "task_old",
      "appr_old",
      { decision: "approve" },
    );
    expect(approval).toMatchObject({ kind: "tool", status: "approved" });
  });
});
