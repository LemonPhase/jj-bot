import type { Interrupted } from "@jj/sandbox/contract";
import { z } from "zod";
import { idSchema, modelRefSchema, timestampSchema } from "./common";
import {
  ACTIVITY_TEXT_LIMIT,
  type Activity,
  addUsage,
  artifactSchema,
  type ExecutionSession,
  emptyUsage,
  executionSessionSchema,
  finishedTaskStatusSchema,
  isFinishedStatus,
  sessionStatusSchema,
  taskMessageSchema,
  taskSchema,
  taskStatusSchema,
  usageSchema,
} from "./tasks";

/** Whether a command was cut short. `unknown` means its effect may already have happened. */
export const interruptedSchema = z.enum([
  "no",
  "yes",
  "unknown",
]) satisfies z.ZodType<Interrupted>;

/**
 * Cap on a `tool.finished` output preview. The server clamps
 * `JJ_OUTPUT_CAP_BYTES` to this many UTF-8 bytes and spills the rest to an
 * artifact. The schema bound counts characters, so it is never tighter.
 */
export const TOOL_OUTPUT_PREVIEW_LIMIT = 64 * 1024;

/** Most events a task view carries: the latest ones, ending at `cursor`. */
export const TASK_VIEW_EVENT_LIMIT = 500;

/**
 * Fields every task event carries. `sequence` is allocated per task, gap-free,
 * in the same transaction as the change the event records.
 */
const eventBaseSchema = z.object({
  id: idSchema,
  taskId: idSchema,
  sequence: z.number().int().min(1),
  occurredAt: timestampSchema,
  botId: idSchema.nullable(),
  sessionId: idSchema.nullable(),
  runId: idSchema.nullable(),
  /** The event that caused this one, when there is one. */
  causedBy: idSchema.nullable(),
});

const event = <Type extends string, Payload extends z.ZodType>(
  type: Type,
  payload: Payload,
) => eventBaseSchema.extend({ type: z.literal(type), payload });

const toolSummarySchema = z.string().max(300);

/**
 * Events that change a record carry the whole record after the change
 * (`task.created`, `task.updated`, `session.created`, `session.updated`,
 * `message.posted`, `artifact.created`), so `applyTaskEvent` keeps a view in
 * step with the stream on its own. The other events are markers and activity.
 */
export const taskEventSchema = z.discriminatedUnion("type", [
  event("task.created", z.object({ task: taskSchema })),
  /** Any change to the task record: status, goal, result, cancellation request. */
  event(
    "task.updated",
    z.object({ task: taskSchema, previousStatus: taskStatusSchema }),
  ),
  /** Marker: the goal changed. The record arrives in `task.updated`. */
  event(
    "task.goal_changed",
    z.object({ goal: z.string().min(1), goalVersion: z.number().int().min(1) }),
  ),
  /** Marker: a user message continued a waiting, completed or failed task. */
  event(
    "task.reopened",
    z.object({
      previous: taskStatusSchema.extract(["waiting", "completed", "failed"]),
    }),
  ),
  /** Marker: the task finished. The record arrives in `task.updated`. */
  event(
    "task.finished",
    z.object({
      status: finishedTaskStatusSchema,
      result: z.string().nullable(),
      error: z.string().nullable(),
    }),
  ),
  event("message.posted", z.object({ message: taskMessageSchema })),
  event("session.created", z.object({ session: executionSessionSchema })),
  /**
   * Any change to a session record except `activity`: status, waitingFor,
   * goalVersion, result, run count and timestamps.
   */
  event(
    "session.updated",
    z.object({
      session: executionSessionSchema,
      previousStatus: sessionStatusSchema,
    }),
  ),
  event(
    "run.started",
    z.object({ reason: z.enum(["start", "wake", "recovery"]) }),
  ),
  event(
    "run.finished",
    z.object({
      outcome: z.enum(["completed", "waiting", "failed", "cancelled"]),
      error: z.string().optional(),
    }),
  ),
  /** A model call began. */
  event("model.started", z.object({})),
  event(
    "model.finished",
    z.object({
      model: modelRefSchema,
      stopReason: z.string(),
      usage: usageSchema,
      /** Preview of the assistant text. */
      text: z.string().max(2000).optional(),
    }),
  ),
  event(
    "tool.started",
    z.object({
      toolCallId: idSchema,
      tool: z.string().min(1),
      /** The command for bash, the path for file tools, the bot name for delegate. */
      summary: toolSummarySchema,
    }),
  ),
  event(
    "tool.finished",
    z.object({
      toolCallId: idSchema,
      tool: z.string().min(1),
      summary: toolSummarySchema,
      ok: z.boolean(),
      exitCode: z.number().int().nullable().optional(),
      interrupted: interruptedSchema.optional(),
      /**
       * Output preview. Snapshot events drop it; fetch them with
       * `GET /api/tasks/:taskId/events?after=` when needed.
       */
      output: z.string().max(TOOL_OUTPUT_PREVIEW_LIMIT).optional(),
      /** The full output did not fit the preview; `artifactId` holds it when stored. */
      truncated: z.boolean(),
      artifactId: idSchema.optional(),
    }),
  ),
  event("artifact.created", z.object({ artifact: artifactSchema })),
  event(
    "steering.received",
    z.object({
      messageId: idSchema,
      goalVersion: z.number().int().min(1),
      /** Injected into a running session, or queued for its next run. */
      delivered: z.enum(["injected", "queued"]),
    }),
  ),
  event("cancellation.requested", z.object({ reason: z.string().nullable() })),
  event(
    "cancellation.completed",
    z.object({
      stopped: z.array(
        z.object({
          sessionId: idSchema,
          botId: idSchema,
          interrupted: interruptedSchema,
          /** The command that was running when the session stopped. */
          command: z.string().optional(),
        }),
      ),
      /** Sessions that were queued and never ran. */
      neverStarted: z.array(idSchema),
    }),
  ),
]);

export type TaskEvent = z.infer<typeof taskEventSchema>;
export type TaskEventType = TaskEvent["type"];
export type TaskEventOf<Type extends TaskEventType> = Extract<
  TaskEvent,
  { type: Type }
>;

export const TASK_EVENT_TYPES: readonly TaskEventType[] =
  taskEventSchema.options.map((option) => option.shape.type.value);

const knownEventTypes = new Set<string>(TASK_EVENT_TYPES);

/**
 * An event of a type this contract version does not know. Clients ignore
 * unknown event types; a known type with a malformed payload is still an error.
 */
export const unknownTaskEventSchema = eventBaseSchema.extend({
  type: z.string().refine((type) => !knownEventTypes.has(type), {
    message: "Known event types must match their schema.",
  }),
  payload: z.record(z.string(), z.unknown()),
});

export type UnknownTaskEvent = z.infer<typeof unknownTaskEventSchema> & {
  unknown: true;
};

/** A known event, or an unknown one marked `unknown: true`. */
export type ParsedTaskEvent = TaskEvent | UnknownTaskEvent;

const tolerantTaskEventSchema = z.union([
  taskEventSchema,
  unknownTaskEventSchema,
]);

const isKnownEvent = (event: { type: string }): event is TaskEvent =>
  knownEventTypes.has(event.type);

/** Parses a stream frame or page entry. Throws only for a malformed known event or base fields. */
export function parseTaskEvent(raw: unknown): ParsedTaskEvent {
  const event = tolerantTaskEventSchema.parse(raw);
  return isKnownEvent(event) ? event : { ...event, unknown: true };
}

/** Up to TASK_VIEW_EVENT_LIMIT events; unknown types are dropped, so lists hold only known events. */
const knownTaskEventListSchema = z
  .array(tolerantTaskEventSchema)
  .max(TASK_VIEW_EVENT_LIMIT)
  .transform((events) => events.filter(isKnownEvent));

/**
 * `GET /api/tasks/:taskId`: the snapshot a task stream resumes from.
 * `events` holds at most the latest TASK_VIEW_EVENT_LIMIT events, from
 * `firstSequence` to `cursor`; `hasEarlier` is true when older events exist.
 * Snapshot events drop `tool.finished` output previews. Pass `cursor` as
 * `Last-Event-ID` or `?after=` to `GET /api/tasks/:taskId/stream`.
 */
export const taskViewSchema = z.object({
  task: taskSchema,
  sessions: z.array(executionSessionSchema),
  messages: z.array(taskMessageSchema),
  artifacts: z.array(artifactSchema),
  usage: z.object({
    total: usageSchema,
    bySession: z.record(idSchema, usageSchema),
  }),
  events: knownTaskEventListSchema,
  firstSequence: z.number().int().min(1),
  hasEarlier: z.boolean(),
  /** Sequence of the last event the view reflects. */
  cursor: z.number().int().nonnegative(),
});

export type TaskView = z.infer<typeof taskViewSchema>;

/** `GET /api/tasks/:taskId/events?after=<sequence>`: events in sequence order, with full previews. */
export const taskEventPageSchema = z.object({
  events: knownTaskEventListSchema,
  /** Sequence of the last event returned, unknown types included; the next page's `after`. */
  cursor: z.number().int().nonnegative(),
  /** More events follow `cursor`. */
  hasMore: z.boolean(),
});

export type TaskEventPage = z.infer<typeof taskEventPageSchema>;

/** One line of at most `limit` UTF-16 code units, cut between code points. */
const clip = (text: string, limit: number): string => {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= limit) return line;
  let clipped = "";
  for (const point of Array.from(line)) {
    if (clipped.length + point.length > limit - 1) break;
    clipped += point;
  }
  return `${clipped}…`;
};

const describe = (prefix: string, detail: string, suffix = ""): string =>
  `${prefix}${clip(detail, ACTIVITY_TEXT_LIMIT - prefix.length - suffix.length)}${suffix}`;

const waitingText = (session: ExecutionSession): string => {
  switch (session.waitingFor) {
    case "delegations":
      return "Waiting on delegated work";
    case "user":
      return "Waiting for you";
    default:
      return "Waiting";
  }
};

/**
 * The activity an event sets for its session: an Activity to show, `null` to
 * clear it, or `undefined` to leave it unchanged. Pure, so clients and the
 * server derive the same line from the same durable events.
 */
export function activityFromEvent(
  event: TaskEvent,
): Activity | null | undefined {
  if (event.sessionId === null) return undefined;
  const since = event.occurredAt;
  switch (event.type) {
    case "model.started":
      return { kind: "thinking", text: "Thinking…", since };
    case "tool.started": {
      const { tool } = event.payload;
      const summary = event.payload.summary.trim() || tool;
      switch (tool) {
        case "bash":
          return {
            kind: "command",
            text: describe("Running `", summary, "`"),
            since,
          };
        case "read":
          return {
            kind: "reading",
            text: describe("Reading ", summary),
            since,
          };
        case "ls":
          return {
            kind: "reading",
            text: describe("Listing ", summary),
            since,
          };
        case "edit":
        case "write":
          return {
            kind: "editing",
            text: describe("Editing ", summary),
            since,
          };
        case "grep":
        case "find":
          return {
            kind: "searching",
            text: describe("Searching ", summary),
            since,
          };
        case "delegate":
          return {
            kind: "delegating",
            text: describe("Delegated to ", summary),
            since,
          };
        case "message":
          return {
            kind: "messaging",
            text: describe("Messaging ", summary),
            since,
          };
        case "complete_task":
          return { kind: "messaging", text: "Writing the result…", since };
        default:
          return { kind: "command", text: describe("Using ", tool), since };
      }
    }
    case "session.updated": {
      const { session } = event.payload;
      if (session.status === "waiting")
        return { kind: "waiting", text: waitingText(session), since };
      return isFinishedStatus(session.status) ? null : undefined;
    }
    default:
      return undefined;
  }
}

const upsert = <Item extends { id: string }>(
  items: readonly Item[],
  item: Item,
): Item[] => {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index === -1) return [...items, item];
  const next = [...items];
  next[index] = item;
  return next;
};

/**
 * Folds one streamed event onto a task view, so that the view at sequence n
 * plus events n+1..m equals the view at m (snapshot events aside, which drop
 * output previews). Pure. Events at or before `cursor` are already reflected
 * and are ignored; unknown event types only advance the cursor.
 */
export function applyTaskEvent(
  view: TaskView,
  event: ParsedTaskEvent,
): TaskView {
  if (event.sequence <= view.cursor) return view;
  if (!isKnownEvent(event)) return { ...view, cursor: event.sequence };

  let { task, sessions, messages, artifacts, usage } = view;
  switch (event.type) {
    case "task.created":
    case "task.updated":
      task = event.payload.task;
      break;
    case "session.created":
      sessions = upsert(sessions, event.payload.session);
      break;
    case "session.updated": {
      // Activity is derived from the event fold below, never from the payload.
      const { session } = event.payload;
      const known = sessions.find((existing) => existing.id === session.id);
      sessions = upsert(
        sessions,
        known ? { ...session, activity: known.activity } : session,
      );
      break;
    }
    case "message.posted":
      messages = upsert(messages, event.payload.message);
      break;
    case "artifact.created":
      artifacts = upsert(artifacts, event.payload.artifact);
      break;
    case "model.finished": {
      const added = event.payload.usage;
      const { sessionId } = event;
      usage = {
        total: addUsage(usage.total, added),
        bySession:
          sessionId === null
            ? usage.bySession
            : {
                ...usage.bySession,
                [sessionId]: addUsage(
                  usage.bySession[sessionId] ?? emptyUsage(),
                  added,
                ),
              },
      };
      break;
    }
  }

  const activity = activityFromEvent(event);
  if (activity !== undefined)
    sessions = sessions.map((session) =>
      session.id === event.sessionId ? { ...session, activity } : session,
    );

  const appended = [...view.events, event];
  const trimmed = appended.length > TASK_VIEW_EVENT_LIMIT;
  const events = trimmed ? appended.slice(-TASK_VIEW_EVENT_LIMIT) : appended;
  return {
    task,
    sessions,
    messages,
    artifacts,
    usage,
    events,
    firstSequence: trimmed
      ? (events[0]?.sequence ?? event.sequence)
      : view.firstSequence,
    hasEarlier: view.hasEarlier || trimmed,
    cursor: event.sequence,
  };
}
