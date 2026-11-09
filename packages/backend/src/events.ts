// Appending task events, deriving session activity from them, and the
// workspace hints the UI refetches on. All of it happens in the caller's
// transaction, so nothing is published before it is durable.
import {
  activityFromEvent,
  savedPayloadPath,
  type TaskEvent,
  type TaskEventOf,
  type TaskEventType,
  type WorkspaceHint,
} from "@jj/contracts";
import {
  appendEvent,
  type Bus,
  type Executor,
  notify,
  sessions,
  type Tx,
} from "@jj/db";
import { eq } from "drizzle-orm";
import { afterCommit } from "./commit-hooks";
import type { EngineContext } from "./context";
import { clippedPayload } from "./event-payloads";
import { toTaskEvent } from "./records";
import { storeArtifact } from "./services/artifacts";

export interface Attribution {
  botId?: string | null;
  sessionId?: string | null;
  runId?: string | null;
  causedBy?: string | null;
}

export type EmitInput = {
  [Type in TaskEventType]: {
    type: Type;
    payload: TaskEventOf<Type>["payload"];
  } & Attribution;
}[TaskEventType];

/**
 * Appends a task event and applies `activityFromEvent` to its session, so the
 * stored activity always equals what a client folds from the stream. Sends the
 * workspace hints the event implies. A payload whose JSON is over the cap
 * (`eventPayloadCapBytes`) and that has unbounded parts to clip is stored in
 * full as an `output` artifact first, attributed like the event, and the
 * event keeps a clipped copy, valid for its type, that names it
 * (`payloadArtifactId`). Record snapshots, which their schemas bound, are
 * stored whole whatever their size.
 */
export async function emit(
  tx: Tx,
  ctx: EngineContext,
  taskId: string,
  input: EmitInput,
): Promise<TaskEvent> {
  let payload = input.payload as Record<string, unknown>;
  let payloadArtifactId: string | null = null;
  const json = JSON.stringify(payload);
  const clipped =
    Buffer.byteLength(json, "utf8") > ctx.config.eventPayloadCapBytes
      ? clippedPayload(input.type, payload, ctx.config.eventPayloadCapBytes)
      : undefined;
  if (clipped) {
    const artifact = await storeArtifact(
      tx,
      ctx,
      {
        taskId,
        kind: "output",
        path: savedPayloadPath(input.type),
        name: `${input.type}.json`,
        content: Buffer.from(json, "utf8"),
        contentType: "application/json",
      },
      {
        botId: input.botId,
        sessionId: input.sessionId,
        runId: input.runId,
        causedBy: input.causedBy,
      },
    );
    payload = clipped;
    payloadArtifactId = artifact.id;
    const { type } = input;
    afterCommit(tx, () => ctx.metrics.payloadSpilled(type));
  }
  const row = await appendEvent(tx, {
    taskId,
    type: input.type,
    payload,
    botId: input.botId ?? null,
    sessionId: input.sessionId ?? null,
    runId: input.runId ?? null,
    causedBy: input.causedBy ?? null,
    payloadArtifactId,
  });
  const event = toTaskEvent(row);
  const activity = activityFromEvent(event);
  if (activity !== undefined && event.sessionId)
    await tx
      .update(sessions)
      .set({ activity })
      .where(eq(sessions.id, event.sessionId));
  for (const implied of hintsFor(event)) await hint(tx, implied);
  return event;
}

/** Hints a client needs after an event: task lists (status, counts, usage) and bot presence. */
function hintsFor(event: TaskEvent): WorkspaceHint[] {
  switch (event.type) {
    case "task.created":
      return [{ type: "tasks.changed", taskId: event.taskId }, botsChanged()];
    case "task.updated":
      return event.payload.previousStatus === event.payload.task.status
        ? [{ type: "tasks.changed", taskId: event.taskId }]
        : [{ type: "tasks.changed", taskId: event.taskId }, botsChanged()];
    case "session.created":
      return [
        { type: "tasks.changed", taskId: event.taskId },
        botsChanged(event.payload.session.botId),
      ];
    case "session.updated":
      return event.payload.previousStatus === event.payload.session.status
        ? [{ type: "tasks.changed", taskId: event.taskId }]
        : [
            { type: "tasks.changed", taskId: event.taskId },
            botsChanged(event.payload.session.botId),
          ];
    case "model.finished":
    case "approval.requested":
    case "approval.updated":
      return [{ type: "tasks.changed", taskId: event.taskId }];
    default:
      return [];
  }
}

const botsChanged = (botId?: string): WorkspaceHint =>
  botId ? { type: "bots.changed", botId } : { type: "bots.changed" };

/** Sends a workspace hint (delivered on commit when `exec` is a transaction). */
export async function hint(exec: Executor, value: WorkspaceHint) {
  const { type, ...rest } = value;
  await notify(exec, "jj_hint", { kind: type, ...rest });
}

/** Bus hints as contract hints; anything malformed is dropped. */
export async function subscribeHints(
  bus: Bus,
  handler: (hint: WorkspaceHint) => void,
): Promise<() => Promise<void>> {
  return bus.subscribe("jj_hint", (message) => {
    const { kind, ...rest } = message;
    const value = { type: kind, ...rest } as WorkspaceHint;
    switch (value.type) {
      case "bots.changed":
      case "tasks.changed":
      case "conversation.changed":
      case "profiles.changed":
      case "secrets.changed":
      case "templates.changed":
        handler(value);
    }
  });
}

/** Pokes workers to claim now instead of at their next poll. */
export async function wakeWorkers(exec: Executor, taskId = "") {
  await notify(exec, "jj_control", { kind: "wake", taskId });
}
