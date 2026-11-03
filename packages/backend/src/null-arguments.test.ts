// A null where an engine tool needs text, on the real pi runtime: pi reports
// the argument missing, so the tool refuses it instead of taking the text "null".
import { callTool, lastMessage, textOf } from "@jj/runtime/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { fauxTeamEngine, route, toolFinished } from "./testing/faux-team";
import {
  OPEN_TIMEOUT,
  openTestDatabase,
  type TestDatabase,
  type TestEngine,
  untilTask,
} from "./testing/harness";
import { createTeam } from "./testing/scenarios";

let db: TestDatabase;
let current: TestEngine | undefined;

beforeAll(async () => {
  db = await openTestDatabase();
}, OPEN_TIMEOUT);
afterEach(async () => {
  await current?.dispose();
  current = undefined;
});
afterAll(async () => {
  await db?.close();
});

describe("null arguments to the engine's tools", () => {
  it("never completes a task with a null result", async () => {
    const team = await fauxTeamEngine(db.database);
    current = team;
    const { engine, faux } = team;
    const { names, byName, ids } = await createTeam(engine, ["Ada"]);
    const [ada] = names as [string];
    const refusals: string[] = [];
    route(faux, {
      [ada]: (context, n) => {
        if (n === 0) return callTool("complete_task", { result: null });
        refusals.push(textOf(lastMessage(context)));
        return callTool("complete_task", { result: "Wrote notes.md." });
      },
    });
    const { task } = await engine.tasks.create({
      goal: "Write notes.md",
      coordinatorBotId: byName[ada] as string,
      participantBotIds: ids,
    });
    const done = await untilTask(
      engine,
      task.id,
      (view) =>
        view.task.status === "completed" || view.task.status === "failed",
    );
    expect(done.task).toMatchObject({
      status: "completed",
      result: "Wrote notes.md.",
    });
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain('Validation failed for tool "complete_task"');
    expect(refusals[0]).toContain("- result: missing");
    const finished = await toolFinished(engine, task.id);
    expect(finished.map((event) => event.payload.ok)).toEqual([false, true]);
  });
});
