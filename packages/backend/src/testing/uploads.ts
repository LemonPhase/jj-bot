// Upload helpers for engine tests, and the placement scenario both sandbox
// drivers run (uploads.test.ts on `local`, docker.test.ts on `docker`).
import { createHash } from "node:crypto";
import type { StagedUpload, TaskView } from "@jj/contracts";
import { sessionInbox } from "@jj/db";
import { and, eq, like } from "drizzle-orm";
import { expect } from "vitest";
import type { Engine } from "../engine";
import { type Brain, type FakeExecutor, said } from "./fake-executor";
import { untilTask } from "./harness";
import { createTeam, lastResult } from "./scenarios";

export const sha256Hex = (content: string | Uint8Array) =>
  createHash("sha256").update(content).digest("hex");

/** A body that yields `content` whole. */
export async function* bodyOf(content: Uint8Array): AsyncGenerator<Uint8Array> {
  yield content;
}

/** Stages `content` as the user's browser would. */
export async function stage(
  engine: Engine,
  name: string,
  content: string | Uint8Array,
): Promise<StagedUpload> {
  const bytes =
    typeof content === "string" ? Buffer.from(content, "utf8") : content;
  const { upload } = await engine.uploads.stage({
    name,
    sizeBytes: bytes.byteLength,
    body: bodyOf(bytes),
  });
  return upload;
}

/** The root session's upload notices, as stored in its inbox. */
export async function notices(engine: Engine, taskId: string) {
  return engine.context.db
    .select({ text: sessionInbox.text, delivered: sessionInbox.deliveredAt })
    .from(sessionInbox)
    .where(
      and(
        eq(sessionInbox.taskId, taskId),
        like(sessionInbox.text, "[Uploads]%"),
      ),
    );
}

export const uploadsOf = (view: TaskView) =>
  view.artifacts.filter((artifact) => artifact.upload !== null);

/**
 * A task created with two uploads: the coordinator's first model call
 * already hears where they are, and its first step, `sha256sum uploads/*`,
 * matches the bytes given. Then a symlink at a target and a directory in
 * the way, for files uploaded into the running task.
 */
export async function placementScenario(
  engine: Engine,
  executor: FakeExecutor,
): Promise<TaskView> {
  const team = await createTeam(engine, ["Ada"]);
  const [ada] = team.names as [string];
  const files = {
    "a.csv": "id,name\n1,Ada\n2,Bob\n",
    "b.bin": Buffer.from([0, 1, 2, 255, 254, 10, 13, 0]),
  };
  const first: { heard?: boolean; turn0Inputs?: string[] } = {};
  const brain: Brain = (view) => {
    switch (said.turns(view)) {
      case 0:
        first.heard = said.heard(
          view,
          "[Uploads] Now in the workspace: uploads/a.csv",
        );
        first.turn0Inputs = said.inputs(view);
        return {
          calls: [{ name: "bash", args: { command: "sha256sum uploads/*" } }],
        };
      case 1:
        // A symlink at one target (to a file that must stay as it is) and a
        // directory in the way of another, then wait for the user's uploads.
        return {
          calls: [
            {
              name: "bash",
              args: {
                command:
                  "echo keep > secret.txt && ln -s ../secret.txt uploads/c.csv && mkdir -p uploads/d.csv",
              },
            },
          ],
        };
      case 2:
        return { calls: [{ name: "gate", args: { name: `${ada}-uploads` } }] };
      case 3:
        return {
          calls: [
            {
              name: "bash",
              args: {
                command:
                  "cat secret.txt; test -L uploads/c.csv && echo link || cat uploads/c.csv; ls uploads/d.csv | wc -l",
              },
            },
          ],
        };
      default:
        return lastResult(view)?.name === "complete_task"
          ? { text: "done" }
          : {
              calls: [
                {
                  name: "complete_task",
                  args: {
                    result: said
                      .results(view)
                      .filter((result) => result.name === "bash")
                      .map((result) => result.text.trim())
                      .join("\n---\n"),
                  },
                },
              ],
            };
    }
  };
  executor.brain(ada, brain);
  const a = await stage(engine, "a.csv", files["a.csv"]);
  const b = await stage(engine, "b.bin", files["b.bin"]);
  const { task } = await engine.tasks.create({
    goal: "Check the files",
    coordinatorBotId: team.byName[ada] as string,
    uploads: [{ uploadId: a.id }, { uploadId: b.id }],
  });
  await executor.gate(`${ada}-uploads`).reached;
  const c = await stage(engine, "c.csv", "uploaded c\n");
  const d = await stage(engine, "d.csv", "uploaded d\n");
  const later = await engine.tasks.upload(task.id, {
    files: [{ uploadId: c.id }, { uploadId: d.id }],
  });
  expect(later.artifacts.map((artifact) => artifact.upload?.state)).toEqual([
    "pending",
    "pending",
  ]);
  executor.gate(`${ada}-uploads`).open();
  const view = await untilTask(
    engine,
    task.id,
    (v) => v.task.status === "completed",
    "the task with uploads",
  );

  // Placed before the first model call, which heard the notice with its brief.
  expect(first.heard).toBe(true);
  expect(first.turn0Inputs?.[0]).toMatch(/^New task\. Goal/);
  const [sums, , checks] = (view.task.result ?? "").split("\n---\n");
  expect(sums).toBe(
    [
      `${sha256Hex(files["a.csv"])}  uploads/a.csv`,
      `${sha256Hex(files["b.bin"])}  uploads/b.bin`,
    ].join("\n"),
  );
  // The symlink was replaced, not followed; the directory failed that file only.
  expect(checks).toBe("keep\nuploaded c\n0");
  const byPath = new Map(
    uploadsOf(view).map((artifact) => [artifact.path, artifact]),
  );
  expect(
    Object.fromEntries(
      [...byPath].map(([path, artifact]) => [path, artifact.upload?.state]),
    ),
  ).toEqual({
    "uploads/a.csv": "placed",
    "uploads/b.bin": "placed",
    "uploads/c.csv": "placed",
    "uploads/d.csv": "failed",
  });
  expect(byPath.get("uploads/d.csv")?.upload?.error).toBe(
    "a directory is in the way",
  );
  expect(byPath.get("uploads/a.csv")).toMatchObject({
    id: a.id,
    kind: "file",
    sessionId: null,
    runId: null,
    sha256: a.sha256,
    contentType: "text/csv; charset=utf-8",
  });
  expect(byPath.get("uploads/b.bin")?.contentType).toBe(
    "application/octet-stream",
  );
  // No artifact twice: the snapshots knew the placed files.
  expect(
    view.artifacts.filter((artifact) => artifact.path.startsWith("uploads/")),
  ).toHaveLength(4);
  // One notice per announcement, the second naming what was not placed.
  const told = (await notices(engine, task.id)).map((row) => row.text);
  expect(told).toHaveLength(2);
  expect(told[1]).toMatch(
    /^\[Uploads\] Now in the workspace: uploads\/c\.csv \(11 B\); not placed: uploads\/d\.csv \(a directory is in the way\)\. The user uploaded these files \(task log entry msg_/,
  );
  expect(
    view.events.filter((event) => event.type === "artifact.updated"),
  ).toHaveLength(4);
  expect(
    view.messages.filter(
      (message) =>
        message.authorKind === "user" && message.intent === "notification",
    ),
  ).toHaveLength(2);
  return view;
}
