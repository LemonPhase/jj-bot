// Recovery after a crash. claim() reclaims expired leases (the run resumes from
// its transcript, see session-run.ts); jobs whose lease expired too often are
// returned as exhausted and fail their session or chat reply visibly (a
// compaction pass is queued again instead).
import { isFinishedStatus } from "@jj/contracts";
import type { JobRow, SessionRow, TaskRow } from "@jj/db";
import type { EngineContext } from "../context";
import { getSession, lockTask } from "../services/sessions";
import { settleCancellation } from "../services/tasks";
import { giveUpChatReply } from "./chat-reply";
import { scheduleCompaction } from "./maintenance";
import { giveUpDiscovery } from "./mcp-discovery";
import { failSessionTx } from "./outcomes";
import { closeStaleRun, runningRun } from "./runs";

/**
 * Jobs whose lease expired after their last attempt (claim marked them
 * failed): the session fails visibly, and so do a chat reply and an MCP
 * discovery.
 */
export async function handleExhausted(
  ctx: EngineContext,
  job: JobRow,
): Promise<{ finishedTaskId?: string }> {
  if (job.kind === "chat.reply") {
    await giveUpChatReply(ctx, job);
    return {};
  }
  if (job.kind === "mcp.discover") {
    await giveUpDiscovery(ctx, job);
    return {};
  }
  // A pass that kept dying is idempotent: the next one starts at the next interval.
  if (job.kind === "maintenance.compact") {
    await scheduleCompaction(ctx.db, ctx, ctx.config.compactionIntervalMs);
    return {};
  }
  if (!job.sessionId) return {};
  const sessionId = job.sessionId;
  return ctx.db.transaction(async (tx) => {
    const peek = await getSession(tx, sessionId);
    if (!peek) return {};
    const task = (await lockTask(tx, peek.taskId)) as TaskRow;
    const session = (await getSession(tx, sessionId)) as SessionRow;
    const error =
      "The session was interrupted too many times (its worker kept stopping) and was given up.";
    const stale = await runningRun(tx, sessionId);
    if (stale) await closeStaleRun(tx, ctx, session, stale, "failed", error);
    if (task.cancelRequestedAt) {
      const settled = await settleCancellation(tx, ctx, task);
      return settled ? { finishedTaskId: task.id } : {};
    }
    if (isFinishedStatus(session.status)) return {};
    const failed = await failSessionTx(tx, ctx, task, session, error, {
      botId: session.botId,
      sessionId: session.id,
    });
    return failed.taskFinished ? { finishedTaskId: task.id } : {};
  });
}
