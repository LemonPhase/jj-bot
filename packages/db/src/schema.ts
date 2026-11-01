import { type SQL, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// String unions stored in text columns. Each is also a CHECK constraint, so a
// new value is a deliberate schema change (edit here, then `npm run db:generate`).
export const TASK_STATUSES = [
  "queued",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
] as const;
/** Sessions share the task status set. */
export const SESSION_STATUSES = TASK_STATUSES;
export const SESSION_ROLES = ["coordinator", "worker"] as const;
/** What a `waiting` session resumes on; set exactly when the session is waiting. */
export const WAITING_FOR = ["delegations", "user"] as const;
export const RUN_REASONS = ["start", "wake", "recovery"] as const;
export const RUN_STATUSES = [
  "running",
  "completed",
  "waiting",
  "failed",
  "cancelled",
] as const;
export const INBOX_KINDS = ["brief", "result", "steering", "message"] as const;
export const MESSAGE_INTENTS = [
  "discussion",
  "assignment",
  "result",
  "steering",
  "notification",
] as const;
export const AUTHOR_KINDS = ["user", "bot", "system"] as const;
export const CONVERSATION_ROLES = ["user", "assistant"] as const;
export const ARTIFACT_KINDS = ["file", "output"] as const;
export const JOB_KINDS = ["session.run", "chat.reply"] as const;
export const JOB_STATUSES = [
  "queued",
  "running",
  "done",
  "failed",
  "cancelled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type SessionStatus = (typeof SESSION_STATUSES)[number];
export type SessionRole = (typeof SESSION_ROLES)[number];
export type WaitingFor = (typeof WAITING_FOR)[number];
export type RunReason = (typeof RUN_REASONS)[number];
export type RunStatus = (typeof RUN_STATUSES)[number];
export type InboxKind = (typeof INBOX_KINDS)[number];
export type MessageIntent = (typeof MESSAGE_INTENTS)[number];
export type AuthorKind = (typeof AUTHOR_KINDS)[number];
export type ConversationRole = (typeof CONVERSATION_ROLES)[number];
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export type JobKind = (typeof JOB_KINDS)[number];
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Claims of a job before an expired lease is no longer reclaimed (see `claim`). */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** A JSON object stored in a jsonb column. */
export type JsonObject = { [key: string]: unknown };

/** The default owner until multi-user support exists. */
export const LOCAL_OWNER = "local";

const ownerId = () => text("owner_id").notNull().default(LOCAL_OWNER);
const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const optionalTime = (name: string) => timestamp(name, { withTimezone: true });

/** `column IN ('a', 'b')` over a constant union; values are code constants, never input. */
function oneOf(column: SQL | { name: string }, values: readonly string[]) {
  const list = values.map((value) => `'${value.replaceAll("'", "''")}'`);
  return sql`${column} in (${sql.raw(list.join(", "))})`;
}

/** Binary content. node-postgres returns a Buffer and PGlite a Uint8Array; both are Uint8Arrays. */
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
  toDriver: (value) =>
    Buffer.isBuffer(value)
      ? value
      : Buffer.from(value.buffer, value.byteOffset, value.byteLength),
});

export const runtimeProfiles = pgTable(
  "runtime_profiles",
  {
    id: text("id").primaryKey(),
    ownerId: ownerId(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    sandbox: jsonb("sandbox").$type<JsonObject>().notNull(),
    tools: jsonb("tools").$type<string[]>().notNull(),
    budgets: jsonb("budgets").$type<JsonObject>().notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // At most one default profile per owner.
    uniqueIndex("runtime_profiles_one_default")
      .on(t.ownerId)
      .where(sql`${t.isDefault}`),
  ],
);

export const bots = pgTable(
  "bots",
  {
    id: text("id").primaryKey(),
    ownerId: ownerId(),
    name: text("name").notNull(),
    role: text("role").notNull().default(""),
    instructions: text("instructions").notNull().default(""),
    /** `provider/model`; null uses the server default. */
    model: text("model"),
    /** Null uses the default profile. Deleting a referenced profile is refused, never silently re-pointed. */
    runtimeProfileId: text("runtime_profile_id").references(
      () => runtimeProfiles.id,
    ),
    appearance: jsonb("appearance").$type<JsonObject>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /** Last allocated `conversation_messages.sequence`; see `nextConversationSequence`. */
    conversationSeq: integer("conversation_seq").notNull().default(0),
    /** Archived bots keep their history but free their name. */
    archivedAt: optionalTime("archived_at"),
  },
  (t) => [
    // Bots are addressed by name (delegate, create_task), so active names resolve unambiguously.
    uniqueIndex("bots_owner_name_unique")
      .on(t.ownerId, sql`lower(${t.name})`)
      .where(sql`${t.archivedAt} is null`),
    index("bots_runtime_profile_idx").on(t.runtimeProfileId),
  ],
);

export const botMemory = pgTable("bot_memory", {
  botId: text("bot_id")
    .primaryKey()
    .references(() => bots.id, { onDelete: "cascade" }),
  ownerId: ownerId(),
  text: text("text").notNull().default(""),
  updatedAt: updatedAt(),
});

export const tasks = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    ownerId: ownerId(),
    title: text("title").notNull(),
    goal: text("goal").notNull(),
    goalVersion: integer("goal_version").notNull().default(1),
    coordinatorBotId: text("coordinator_bot_id")
      .notNull()
      .references(() => bots.id),
    /** The bot that created the task from direct chat; null when the user created it. Rate-limited per bot. */
    createdByBotId: text("created_by_bot_id").references(() => bots.id),
    /**
     * The conversation message whose reply created the task (attribution, not a
     * foreign key). Unique per creating bot, so a reply that runs again after a
     * hand-off or crash finds the task instead of creating a second one.
     */
    createdFromMessageId: text("created_from_message_id"),
    status: text("status").$type<TaskStatus>().notNull().default("queued"),
    result: text("result"),
    error: text("error"),
    cancelReason: text("cancel_reason"),
    /** Set when a stop is requested; the task is cancelled once nothing of it runs. */
    cancelRequestedAt: optionalTime("cancel_requested_at"),
    /** Last allocated `task_events.sequence`; see `appendEvent`. */
    eventSeq: integer("event_seq").notNull().default(0),
    /** Last allocated `task_messages.sequence`; see `nextMessageSequence`. */
    messageSeq: integer("message_seq").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    finishedAt: optionalTime("finished_at"),
  },
  (t) => [
    index("tasks_coordinator_idx").on(t.coordinatorBotId),
    // Covers the creator foreign key and the per-bot hourly creation count.
    index("tasks_created_by_created_idx").on(t.createdByBotId, t.createdAt),
    uniqueIndex("tasks_created_from_message_unique")
      .on(t.createdByBotId, t.createdFromMessageId)
      .where(sql`${t.createdFromMessageId} is not null`),
    check("tasks_status_check", oneOf(t.status, TASK_STATUSES)),
  ],
);

export const conversationMessages = pgTable(
  "conversation_messages",
  {
    id: text("id").primaryKey(),
    ownerId: ownerId(),
    botId: text("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    role: text("role").$type<ConversationRole>().notNull(),
    text: text("text").notNull(),
    /** The task this message created or forwarded to; a reference kept as history, not a foreign key. */
    taskId: text("task_id"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("conversation_messages_bot_sequence").on(t.botId, t.sequence),
    check(
      "conversation_messages_role_check",
      oneOf(t.role, CONVERSATION_ROLES),
    ),
  ],
);

export const taskParticipants = pgTable(
  "task_participants",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    botId: text("bot_id")
      .notNull()
      .references(() => bots.id),
    ownerId: ownerId(),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.botId] }),
    index("task_participants_bot_idx").on(t.botId),
  ],
);

export const taskGoalVersions = pgTable(
  "task_goal_versions",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    ownerId: ownerId(),
    goal: text("goal").notNull(),
    reason: text("reason"),
    /** `user` or a bot id. */
    author: text("author").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.version] })],
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    ownerId: ownerId(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    botId: text("bot_id")
      .notNull()
      .references(() => bots.id),
    parentSessionId: text("parent_session_id").references(
      (): AnyPgColumn => sessions.id,
      { onDelete: "cascade" },
    ),
    role: text("role").$type<SessionRole>().notNull(),
    brief: text("brief").notNull(),
    goalVersion: integer("goal_version").notNull(),
    depth: integer("depth").notNull().default(0),
    status: text("status").$type<SessionStatus>().notNull().default("queued"),
    waitingFor: text("waiting_for").$type<WaitingFor>(),
    result: text("result"),
    error: text("error"),
    activity: jsonb("activity").$type<JsonObject>(),
    runCount: integer("run_count").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    startedAt: optionalTime("started_at"),
    finishedAt: optionalTime("finished_at"),
    completionRequested: jsonb("completion_requested").$type<JsonObject>(),
  },
  (t) => [
    index("sessions_task_idx").on(t.taskId),
    index("sessions_parent_idx").on(t.parentSessionId),
    index("sessions_bot_status_idx").on(t.botId, t.status),
    check("sessions_role_check", oneOf(t.role, SESSION_ROLES)),
    check("sessions_status_check", oneOf(t.status, SESSION_STATUSES)),
    check(
      "sessions_waiting_for_check",
      sql`(${t.waitingFor} is null or ${oneOf(t.waitingFor, WAITING_FOR)}) and ((${t.status} = 'waiting') = (${t.waitingFor} is not null))`,
    ),
  ],
);

export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    ownerId: ownerId(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    /** 1-based per session. */
    number: integer("number").notNull(),
    reason: text("reason").$type<RunReason>().notNull(),
    status: text("status").$type<RunStatus>().notNull().default("running"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: optionalTime("finished_at"),
  },
  (t) => [
    unique("runs_session_number").on(t.sessionId, t.number),
    index("runs_task_idx").on(t.taskId),
    check("runs_reason_check", oneOf(t.reason, RUN_REASONS)),
    check("runs_status_check", oneOf(t.status, RUN_STATUSES)),
  ],
);

/** The persisted pi transcript: one pi message per row, appended after each completed turn. */
export const sessionEntries = pgTable(
  "session_entries",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    ownerId: ownerId(),
    /** Producing run (attribution, not a foreign key). */
    runId: text("run_id").notNull(),
    entry: jsonb("entry").$type<JsonObject>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.seq] })],
);

export const sessionInbox = pgTable(
  "session_inbox",
  {
    id: text("id").primaryKey(),
    ownerId: ownerId(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    kind: text("kind").$type<InboxKind>().notNull(),
    text: text("text").notNull(),
    /** The task message this item delivers (causal reference, not a foreign key). */
    sourceMessageId: text("source_message_id"),
    createdAt: createdAt(),
    deliveredAt: optionalTime("delivered_at"),
  },
  (t) => [
    index("session_inbox_session_idx").on(t.sessionId, t.createdAt),
    index("session_inbox_task_idx").on(t.taskId),
    check("session_inbox_kind_check", oneOf(t.kind, INBOX_KINDS)),
  ],
);

export const taskMessages = pgTable(
  "task_messages",
  {
    id: text("id").primaryKey(),
    ownerId: ownerId(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    authorKind: text("author_kind").$type<AuthorKind>().notNull(),
    /** Attribution, not a foreign key: messages are append-only and leave with their task. */
    authorBotId: text("author_bot_id"),
    sessionId: text("session_id"),
    intent: text("intent").$type<MessageIntent>().notNull(),
    text: text("text").notNull(),
    /**
     * The conversation message a bot relayed into this task (attribution, not a
     * foreign key). Unique per task, so a relay that runs again posts nothing new.
     */
    relayedFromMessageId: text("relayed_from_message_id"),
    /** Activation, not visibility: the bots this message may wake. */
    recipientBotIds: jsonb("recipient_bot_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    unique("task_messages_task_sequence").on(t.taskId, t.sequence),
    uniqueIndex("task_messages_relayed_from_unique")
      .on(t.taskId, t.relayedFromMessageId)
      .where(sql`${t.relayedFromMessageId} is not null`),
    check("task_messages_author_kind_check", oneOf(t.authorKind, AUTHOR_KINDS)),
    check("task_messages_intent_check", oneOf(t.intent, MESSAGE_INTENTS)),
  ],
);

export const taskEvents = pgTable(
  "task_events",
  {
    id: text("id").primaryKey(),
    ownerId: ownerId(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    type: text("type").notNull(),
    // Attribution, not foreign keys: the log is append-only and leaves with its task.
    botId: text("bot_id"),
    sessionId: text("session_id"),
    runId: text("run_id"),
    causedBy: text("caused_by"),
    payload: jsonb("payload").$type<JsonObject>().notNull().default({}),
    // clock_timestamp(), not now(): the row is written after the task row lock
    // is taken, so occurred_at never runs backwards against sequence.
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [unique("task_events_task_sequence").on(t.taskId, t.sequence)],
);

export const artifacts = pgTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    ownerId: ownerId(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    // Attribution, not foreign keys.
    sessionId: text("session_id"),
    runId: text("run_id"),
    kind: text("kind").$type<ArtifactKind>().notNull(),
    path: text("path").notNull(),
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    content: bytea("content").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("artifacts_task_path_idx").on(t.taskId, t.path),
    check("artifacts_kind_check", oneOf(t.kind, ARTIFACT_KINDS)),
  ],
);

export const usage = pgTable(
  "usage",
  {
    id: text("id").primaryKey(),
    ownerId: ownerId(),
    /** Null for direct chat replies. */
    taskId: text("task_id").references(() => tasks.id, {
      onDelete: "cascade",
    }),
    // Attribution, not foreign keys.
    sessionId: text("session_id"),
    runId: text("run_id"),
    botId: text("bot_id"),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("usage_task_idx").on(t.taskId)],
);

export const jobs = pgTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<JobKind>().notNull(),
    taskId: text("task_id").references(() => tasks.id, {
      onDelete: "cascade",
    }),
    sessionId: text("session_id").references(() => sessions.id, {
      onDelete: "cascade",
    }),
    botId: text("bot_id").references(() => bots.id, { onDelete: "cascade" }),
    payload: jsonb("payload").$type<JsonObject>().notNull().default({}),
    status: text("status").$type<JobStatus>().notNull().default("queued"),
    runAfter: timestamp("run_after", { withTimezone: true })
      .notNull()
      .defaultNow(),
    leaseOwner: text("lease_owner"),
    leaseUntil: optionalTime("lease_until"),
    /** Claims so far; also the lease generation that fences stale runners. */
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts")
      .notNull()
      .default(DEFAULT_MAX_ATTEMPTS),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("jobs_queued_idx")
      .on(t.status, t.runAfter)
      .where(sql`${t.status} = 'queued'`),
    // Lets claim() find expired leases without scanning finished jobs.
    index("jobs_running_lease_idx")
      .on(t.leaseUntil)
      .where(sql`${t.status} = 'running'`),
    index("jobs_task_idx").on(t.taskId),
    index("jobs_session_idx").on(t.sessionId),
    index("jobs_bot_idx").on(t.botId),
    // At most one pending and one running session.run per session, and one
    // chat.reply per bot. enqueue() coalesces wakes on the pending index;
    // claim() never starts a second run while one is running.
    uniqueIndex("jobs_session_run_queued")
      .on(t.sessionId)
      .where(sql`${t.kind} = 'session.run' and ${t.status} = 'queued'`),
    uniqueIndex("jobs_session_run_running")
      .on(t.sessionId)
      .where(sql`${t.kind} = 'session.run' and ${t.status} = 'running'`),
    uniqueIndex("jobs_chat_reply_queued")
      .on(t.botId)
      .where(sql`${t.kind} = 'chat.reply' and ${t.status} = 'queued'`),
    uniqueIndex("jobs_chat_reply_running")
      .on(t.botId)
      .where(sql`${t.kind} = 'chat.reply' and ${t.status} = 'running'`),
    check(
      "jobs_session_run_session_check",
      sql`${t.kind} <> 'session.run' or ${t.sessionId} is not null`,
    ),
    check(
      "jobs_chat_reply_bot_check",
      sql`${t.kind} <> 'chat.reply' or ${t.botId} is not null`,
    ),
    check("jobs_max_attempts_check", sql`${t.maxAttempts} >= 1`),
    check("jobs_kind_check", oneOf(t.kind, JOB_KINDS)),
    check("jobs_status_check", oneOf(t.status, JOB_STATUSES)),
    // A running job always has an owner and a lease.
    check(
      "jobs_running_lease_check",
      sql`${t.status} <> 'running' or (${t.leaseOwner} is not null and ${t.leaseUntil} is not null)`,
    ),
  ],
);

export type BotRow = typeof bots.$inferSelect;
export type NewBot = typeof bots.$inferInsert;
export type BotMemoryRow = typeof botMemory.$inferSelect;
export type NewBotMemory = typeof botMemory.$inferInsert;
export type ConversationMessageRow = typeof conversationMessages.$inferSelect;
export type NewConversationMessage = typeof conversationMessages.$inferInsert;
export type RuntimeProfileRow = typeof runtimeProfiles.$inferSelect;
export type NewRuntimeProfile = typeof runtimeProfiles.$inferInsert;
export type TaskRow = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type TaskParticipantRow = typeof taskParticipants.$inferSelect;
export type NewTaskParticipant = typeof taskParticipants.$inferInsert;
export type TaskGoalVersionRow = typeof taskGoalVersions.$inferSelect;
export type NewTaskGoalVersion = typeof taskGoalVersions.$inferInsert;
export type SessionRow = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type RunRow = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
export type SessionEntryRow = typeof sessionEntries.$inferSelect;
export type NewSessionEntry = typeof sessionEntries.$inferInsert;
export type SessionInboxRow = typeof sessionInbox.$inferSelect;
export type NewSessionInboxItem = typeof sessionInbox.$inferInsert;
export type TaskMessageRow = typeof taskMessages.$inferSelect;
export type NewTaskMessage = typeof taskMessages.$inferInsert;
export type TaskEventRow = typeof taskEvents.$inferSelect;
export type NewTaskEvent = typeof taskEvents.$inferInsert;
export type ArtifactRow = typeof artifacts.$inferSelect;
export type NewArtifact = typeof artifacts.$inferInsert;
export type UsageRow = typeof usage.$inferSelect;
export type NewUsage = typeof usage.$inferInsert;
export type JobRow = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;

/** Every table, for `drizzle(client, { schema: tables })` and the `Db` type. */
export const tables = {
  runtimeProfiles,
  bots,
  botMemory,
  tasks,
  conversationMessages,
  taskParticipants,
  taskGoalVersions,
  sessions,
  runs,
  sessionEntries,
  sessionInbox,
  taskMessages,
  taskEvents,
  artifacts,
  usage,
  jobs,
};
