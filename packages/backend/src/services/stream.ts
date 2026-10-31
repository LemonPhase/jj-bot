// The task stream: events after a cursor, then each new one as the bus
// announces it. Subscribe first, read second, so nothing falls in between; a
// slow poll and the bus's reconnect hook cover lost notifications.
import type { TaskEvent } from "@jj/contracts";
import { listEvents, tasks } from "@jj/db";
import { eq } from "drizzle-orm";
import type { EngineContext } from "../context";
import { notFound } from "../errors";
import { toTaskEvent } from "../records";

export interface TaskStreamOptions {
  /** Deliver events strictly after this sequence (the view's cursor or `Last-Event-ID`). */
  after?: number;
  /** Awaited, so a slow client applies backpressure. Called in sequence order, each event once. */
  onEvent(event: TaskEvent): void | Promise<void>;
  onError?(error: unknown): void;
}

export interface TaskSubscription {
  /** The sequence of the last event delivered. */
  readonly cursor: number;
  close(): Promise<void>;
}

const PAGE = 200;

export async function subscribeTask(
  ctx: EngineContext,
  taskId: string,
  options: TaskStreamOptions,
): Promise<TaskSubscription> {
  const [task] = await ctx.db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.id, taskId));
  if (!task) throw notFound("Task", taskId);
  let cursor = Math.max(0, Math.floor(options.after ?? 0));
  let closed = false;
  let reading: Promise<void> | undefined;
  let again = false;

  const drain = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (reading) {
      again = true;
      return reading;
    }
    reading = (async () => {
      do {
        again = false;
        while (!closed) {
          const rows = await listEvents(ctx.db, taskId, {
            after: cursor,
            limit: PAGE,
          });
          for (const row of rows) {
            if (closed) return;
            await options.onEvent(toTaskEvent(row));
            cursor = row.sequence;
          }
          if (rows.length < PAGE) break;
        }
      } while (again && !closed);
    })()
      .catch((error: unknown) => {
        if (options.onError) options.onError(error);
        else ctx.logger.warn(`Task stream ${taskId} failed a read`, { error });
      })
      .finally(() => {
        reading = undefined;
      });
    return reading;
  };

  const unsubscribe = await ctx.bus.subscribe("jj_task_event", (notice) => {
    if (notice.taskId === taskId && notice.sequence > cursor) void drain();
  });
  const offReconnect = ctx.bus.onReconnect(() => void drain());
  const timer = setInterval(() => void drain(), ctx.config.streamPollMs);
  timer.unref();
  await drain();
  return {
    get cursor() {
      return cursor;
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      offReconnect();
      await unsubscribe();
      await reading;
    },
  };
}
