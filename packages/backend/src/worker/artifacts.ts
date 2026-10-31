// The artifact snapshot after a run: files the run changed in the task
// workspace become `file` artifacts, deduplicated by path and content.
import {
  changedFiles,
  hasArtifact,
  sha256,
  storeArtifact,
} from "../services/artifacts";
import { attributionOf, type RunContext, writeRun } from "./run-context";
import type { SandboxHold } from "./sandboxes";

/** Clock skew allowed between the worker and the sandbox when finding changed files. */
const SNAPSHOT_SKEW_MS = 2_000;

/** Records files the run changed as `file` artifacts (deduplicated by path and content). */
export async function snapshotArtifacts(rc: RunContext, hold: SandboxHold) {
  const { ctx } = rc.deps;
  const since = new Date(rc.startedAt.getTime() - SNAPSHOT_SKEW_MS);
  const files = await changedFiles(hold.sandbox, since, ctx.config.artifacts);
  if (files.length === 0) return;
  await writeRun(rc, async (tx) => {
    for (const file of files) {
      if (await hasArtifact(tx, rc.task.id, file.path, sha256(file.content)))
        continue;
      await storeArtifact(
        tx,
        ctx,
        {
          taskId: rc.task.id,
          kind: "file",
          path: file.path,
          name: file.path.split("/").pop() || file.path,
          content: file.content,
        },
        attributionOf(rc),
      );
    }
  });
}
