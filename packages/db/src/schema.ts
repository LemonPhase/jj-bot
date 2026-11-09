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
export const WAITING_FOR = ["delegations", "user", "approval"] as const;
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
/**
 * What a task update tells its coordinator's chat: the task completed,
 * failed or waits for the user, or a call waits for the user's approval.
 */
export const TASK_UPDATE_EVENTS = [
  "completed",
  "failed",
  "waiting",
  "approval",
] as const;
export const APPROVAL_STATUSES = [
  "pending",
  "approved",
  "denied",
  "expired",
  "cancelled",
] as const;
export const ARTIFACT_KINDS = ["file", "output"] as const;
export const CHECK_METHODS = ["command", "file", "result"] as const;
export const CHECK_OUTCOMES = ["passed", "failed", "inconclusive"] as const;
export const JOB_KINDS = [
  "session.run",
  "chat.reply",
  "maintenance.compact",
  "mcp.discover",
] as const;
/** What a stored secret is: a model provider's key, or a sandbox secret granted by name. */
export const SECRET_KINDS = ["provider", "sandbox"] as const;
export const JOB_STATUSES = [
  "queued",
  "running",
  "done",
  "failed",
  "cancelled",
] as const;
/** Where one test of an MCP server configuration is (`mcp_discoveries.status`). */
export const MCP_DISCOVERY_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
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
export type TaskUpdateEvent = (typeof TASK_UPDATE_EVENTS)[number];
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export type CheckMethod = (typeof CHECK_METHODS)[number];
export type CheckOutcome = (typeof CHECK_OUTCOMES)[number];
export type JobKind = (typeof JOB_KINDS)[number];
export type JobStatus = (typeof JOB_STATUSES)[number];
export type SecretKind = (typeof SECRET_KINDS)[number];
export type McpDiscoveryStatus = (typeof MCP_DISCOVERY_STATUSES)[number];

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
    /** Approval rules (`approvalRuleSchema`), none by default. */
    approvals: jsonb("approvals").$type<JsonObject[]>().notNull().default([]),
    /** Names of the sandbox secrets this profile grants (`secrets.name`, kind `sandbox`). */
    secrets: jsonb("secrets").$type<string[]>().notNull().default([]),
    /** MCP servers (`mcpServersSchema`), none by default. */
    mcpServers: jsonb("mcp_servers")
      .$type<JsonObject[]>()
      .notNull()
      .default([]),
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
    /** The task's spend cap in US dollars (`task.spendCapUsd`); null for none. */
    spendCapUsd: doublePrecision("spend_cap_usd"),
    /**
     * The user's verification plan for the current goal version (the
     * contract's `verificationPlanSchema`); null for none. Its history is in
     * `task_goal_versions`.
     */
    verificationPlan: jsonb("verification_plan").$type<JsonObject[]>(),
    /**
     * The worker holding the task's ephemeral sandbox, which no other worker
     * can reach, and until when (refreshed while held, cleared on release).
     * Other workers hand the task's sessions back while it is live.
     */
    sandboxHolder: text("sandbox_holder"),
    sandboxHolderUntil: optionalTime("sandbox_holder_until"),
    /**
     * The task template the task was started from (attribution, not a
     * foreign key): deleting the template leaves it set.
     */
    templateId: text("template_id"),
    /** Last allocated `task_events.sequence`; see `appendEvent`. */
    eventSeq: integer("event_seq").notNull().default(0),
    /** Last allocated `task_messages.sequence`; see `nextMessageSequence`. */
    messageSeq: integer("message_seq").notNull().default(0),
    /**
     * Events at or below this sequence were compacted (the view's
     * `compactedThrough`); 0 for none. A pass sets it to `event_seq` and
     * appends `task.compacted` right after, so a task with nothing new since
     * has `event_seq = events_compacted_through + 1`.
     */
    eventsCompactedThrough: integer("events_compacted_through")
      .notNull()
      .default(0),
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
    // The compaction pass's candidates: finished tasks, oldest finish first.
    index("tasks_finished_idx")
      .on(t.finishedAt)
      .where(sql`${t.status} in ('completed', 'failed', 'cancelled')`),
    index("tasks_template_idx").on(t.templateId),
    check("tasks_status_check", oneOf(t.status, TASK_STATUSES)),
  ],
);

/**
 * A saved task setup the user starts again (`taskTemplateSchema`). Its
 * problems are derived on read, never stored.
 */
export const taskTemplates = pgTable(
  "task_templates",
  {
    id: text("id").primaryKey(),
    ownerId: ownerId(),
    title: text("title").notNull(),
    goal: text("goal").notNull(),
    /**
     * Like the participants, a plain id checked against `bots` at save and
     * at start, not a foreign key: bots are archived, never deleted.
     */
    coordinatorBotId: text("coordinator_bot_id").notNull(),
    /** Every participant, the coordinator first; checked against `bots` at save and at start. */
    participantBotIds: jsonb("participant_bot_ids").$type<string[]>().notNull(),
    /** The contract's `verificationPlanSchema`; null for none. */
    verificationPlan: jsonb("verification_plan").$type<JsonObject[]>(),
    /** The task cap a start sets when `spend_cap_inherit` is false; null for none. */
    spendCapUsd: doublePrecision("spend_cap_usd"),
    /** True: a start takes the coordinator's profile's cap, read then. */
    spendCapInherit: boolean("spend_cap_inherit").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("task_templates_owner_created_idx").on(t.ownerId, t.createdAt),
    index("task_templates_coordinator_idx").on(t.coordinatorBotId),
    check(
      "task_templates_cap_check",
      sql`not (${t.spendCapInherit} and ${t.spendCapUsd} is not null)`,
    ),
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
    /**
     * A user message: when a reply took it up, answered or failed. Null while
     * it waits, so one that arrives during a reply (whose answer is stored
     * after it) is still answered next.
     */
    handledAt: optionalTime("handled_at"),
  },
  (t) => [
    unique("conversation_messages_bot_sequence").on(t.botId, t.sequence),
    index("conversation_messages_waiting_idx")
      .on(t.botId, t.sequence)
      .where(sql`${t.role} = 'user' and ${t.handledAt} is null`),
    check(
      "conversation_messages_role_check",
      oneOf(t.role, CONVERSATION_ROLES),
    ),
  ],
);

/**
 * A task update for its coordinator's direct chat: the task completed, failed
 * or waits for the user. Recorded in the transaction that changes the task,
 * so each event has exactly one row, keyed by the task and the task's event
 * sequence at that moment (a task that continues and waits again is a new
 * event). A chat reply answers it: `answered_at` and `message_id` are set in
 * the transaction that stores the conversation message telling the user (the
 * bot's reply, or the engine's fallback), so an update is answered once. An
 * update a later event of its task overtook is closed without a message.
 */
export const chatTaskUpdates = pgTable(
  "chat_task_updates",
  {
    id: text("id").primaryKey(),
    ownerId: ownerId(),
    botId: text("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    event: text("event").$type<TaskUpdateEvent>().notNull(),
    /** `tasks.event_seq` once the event was recorded: with the task, the update's key. */
    taskEventSeq: integer("task_event_seq").notNull(),
    /** The result, error or the coordinator's question, as stored then, clipped. */
    text: text("text").notNull(),
    createdAt: createdAt(),
    /** The conversation message that told it; null while pending or when overtaken (attribution, not a foreign key). */
    messageId: text("message_id"),
    /** When it was told, or overtaken by a later event of its task; null while pending. */
    answeredAt: optionalTime("answered_at"),
    /** The approval an `approval` update is about (attribution, not a foreign key). */
    approvalId: text("approval_id"),
  },
  (t) => [
    // Also covers the task foreign key.
    unique("chat_task_updates_task_event").on(t.taskId, t.taskEventSeq),
    index("chat_task_updates_pending_idx")
      .on(t.botId, t.createdAt)
      .where(sql`${t.answeredAt} is null`),
    check("chat_task_updates_event_check", oneOf(t.event, TASK_UPDATE_EVENTS)),
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
    /** The verification plan this version is checked against; null for none. */
    verificationPlan: jsonb("verification_plan").$type<JsonObject[]>(),
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
    /**
     * True from the run's start until a snapshot has recorded its files. It
     * stays true for a run handed back by a graceful stop, cut off by a crash,
     * or whose last snapshot failed, so a later snapshot covers it.
     */
    snapshotPending: boolean("snapshot_pending").notNull().default(false),
  },
  (t) => [
    unique("runs_session_number").on(t.sessionId, t.number),
    index("runs_task_idx").on(t.taskId),
    check("runs_reason_check", oneOf(t.reason, RUN_REASONS)),
    check("runs_status_check", oneOf(t.status, RUN_STATUSES)),
  ],
);

/**
 * The persisted pi transcript, append-only: one entry per row, a pi message
 * or a compaction checkpoint (`role: "compaction"`), written as the run goes.
 */
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
    // Attribution, not foreign keys: the log is appended to (only compaction
    // deletes or rewrites, once its task finished) and leaves with its task.
    botId: text("bot_id"),
    sessionId: text("session_id"),
    runId: text("run_id"),
    causedBy: text("caused_by"),
    payload: jsonb("payload").$type<JsonObject>().notNull().default({}),
    /**
     * The `output` artifact holding the full payload when it was over the
     * payload cap; `payload` is then the clipped copy. An attribution id.
     */
    payloadArtifactId: text("payload_artifact_id"),
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

/**
 * Verification evidence, append-only: one criterion of a plan evaluated once,
 * at one gate attempt of one goal version (`attempt` counts that version's
 * gate runs from 1). `position` is the criterion's index in its plan.
 */
export const verificationChecks = pgTable(
  "verification_checks",
  {
    id: text("id").primaryKey(),
    ownerId: ownerId(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    goalVersion: integer("goal_version").notNull(),
    attempt: integer("attempt").notNull(),
    position: integer("position").notNull(),
    criterionId: text("criterion_id").notNull(),
    method: text("method").$type<CheckMethod>().notNull(),
    outcome: text("outcome").$type<CheckOutcome>().notNull(),
    exitCode: integer("exit_code"),
    interrupted: text("interrupted"),
    durationMs: integer("duration_ms").notNull(),
    detail: text("detail").notNull(),
    output: text("output"),
    truncated: boolean("truncated").notNull().default(false),
    // Attribution, not foreign keys.
    artifactId: text("artifact_id"),
    sessionId: text("session_id"),
    runId: text("run_id"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    unique("verification_checks_attempt_criterion").on(
      t.taskId,
      t.goalVersion,
      t.attempt,
      t.criterionId,
    ),
    check("verification_checks_method_check", oneOf(t.method, CHECK_METHODS)),
    check(
      "verification_checks_outcome_check",
      oneOf(t.outcome, CHECK_OUTCOMES),
    ),
    // A command check passes only on exit code 0 with no interruption.
    check(
      "verification_checks_command_pass_check",
      sql`${t.method} <> 'command' or ${t.outcome} <> 'passed' or (${t.exitCode} = 0 and ${t.interrupted} = 'no')`,
    ),
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
    /** False when the model lists no price: `cost_usd` is then 0 and the real cost unknown. */
    priced: boolean("priced").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    index("usage_task_idx").on(t.taskId),
    // The spend guard's rolling 24 hours, per bot and for the instance.
    index("usage_bot_created_idx").on(t.botId, t.createdAt),
    index("usage_created_idx").on(t.createdAt),
  ],
);

/**
 * A call that waits, or waited, for the user's approval: one per session
 * and tool call, at most one pending per session. The call's result reaches
 * the session's transcript once (`resolved_at`): an approved call starts at
 * most once (`started_at`, claimed by `started_run_id`).
 */
export const approvals = pgTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    ownerId: ownerId(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    /** The run that made the call (attribution, not a foreign key). */
    runId: text("run_id").notNull(),
    botId: text("bot_id").notNull(),
    toolCallId: text("tool_call_id").notNull(),
    tool: text("tool").notNull(),
    summary: text("summary").notNull(),
    /** The call's arguments, redacted. */
    args: jsonb("args").$type<JsonObject>().notNull(),
    /** The profile rule that asked for approval. */
    rule: jsonb("rule").$type<JsonObject>().notNull(),
    text: text("text").notNull().default(""),
    goalVersion: integer("goal_version").notNull(),
    status: text("status").$type<ApprovalStatus>().notNull().default("pending"),
    reason: text("reason"),
    /** How an approved call ended, once its result was stored. */
    outcome: jsonb("outcome").$type<JsonObject>(),
    createdAt: createdAt(),
    decidedAt: optionalTime("decided_at"),
    startedRunId: text("started_run_id"),
    startedAt: optionalTime("started_at"),
    resolvedAt: optionalTime("resolved_at"),
  },
  (t) => [
    unique("approvals_session_call").on(t.sessionId, t.toolCallId),
    uniqueIndex("approvals_one_pending")
      .on(t.sessionId)
      .where(sql`${t.status} = 'pending'`),
    index("approvals_task_idx").on(t.taskId, t.createdAt),
    check("approvals_status_check", oneOf(t.status, APPROVAL_STATUSES)),
  ],
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
    // What a chat reply was answering (see the engine's chat-reply.ts): the
    // conversation view looks up the reply to the user's latest message.
    index("jobs_chat_reply_answering_idx")
      .on(t.botId, sql`(${t.payload}->>'answering')`)
      .where(sql`${t.kind} = 'chat.reply'`),
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
    // One compaction pass queued and one running, instance-wide.
    uniqueIndex("jobs_maintenance_compact_queued")
      .on(t.kind)
      .where(sql`${t.kind} = 'maintenance.compact' and ${t.status} = 'queued'`),
    uniqueIndex("jobs_maintenance_compact_running")
      .on(t.kind)
      .where(
        sql`${t.kind} = 'maintenance.compact' and ${t.status} = 'running'`,
      ),
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
export type ChatTaskUpdateRow = typeof chatTaskUpdates.$inferSelect;
export type NewChatTaskUpdate = typeof chatTaskUpdates.$inferInsert;
export type RuntimeProfileRow = typeof runtimeProfiles.$inferSelect;
export type NewRuntimeProfile = typeof runtimeProfiles.$inferInsert;
export type TaskRow = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type TaskTemplateRow = typeof taskTemplates.$inferSelect;
export type NewTaskTemplate = typeof taskTemplates.$inferInsert;
export type TaskParticipantRow = typeof taskParticipants.$inferSelect;
export type NewTaskParticipant = typeof taskParticipants.$inferInsert;
export type TaskGoalVersionRow = typeof taskGoalVersions.$inferSelect;
export type VerificationCheckRow = typeof verificationChecks.$inferSelect;
export type NewVerificationCheck = typeof verificationChecks.$inferInsert;
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
export type ApprovalRow = typeof approvals.$inferSelect;
export type NewApproval = typeof approvals.$inferInsert;
export type JobRow = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;

/**
 * Instance-wide values the server creates for itself, by key, such as the API
 * token generated on first boot. Infrastructure, like `jobs`: no owner.
 */
export const instanceSettings = pgTable("instance_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  createdAt: createdAt(),
});

export type InstanceSettingRow = typeof instanceSettings.$inferSelect;

/**
 * The job loops alive on this database: each worker, embedded in an API or
 * standalone, records itself here when its claim loop passes and removes its
 * row when it stops. Readiness of an API without an embedded worker reads it.
 * Infrastructure, like `jobs`: no owner.
 */
export const workerHeartbeats = pgTable("worker_heartbeats", {
  workerId: text("worker_id").primaryKey(),
  startedAt: timestamp("started_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
});

export type WorkerHeartbeatRow = typeof workerHeartbeats.$inferSelect;

/**
 * Values entered through settings: provider keys (`name` is the provider id)
 * and sandbox secrets (`name` is the variable), stored as ciphertext:
 * AES-256-GCM under a key derived from the server's `JJ_SECRET_KEY`, which
 * is never stored, so the database alone reveals no value beyond its length
 * and `hint`, the value's last four characters. `key_id` names the key that
 * sealed the row.
 */
export const secrets = pgTable(
  "secrets",
  {
    ownerId: ownerId(),
    kind: text("kind").$type<SecretKind>().notNull(),
    name: text("name").notNull(),
    keyId: text("key_id").notNull(),
    nonce: bytea("nonce").notNull(),
    /** The GCM ciphertext with its 16-byte tag appended. */
    ciphertext: bytea("ciphertext").notNull(),
    hint: text("hint").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.ownerId, t.kind, t.name] }),
    check("secrets_kind_check", oneOf(t.kind, SECRET_KINDS)),
  ],
);

export type SecretRow = typeof secrets.$inferSelect;

/**
 * Values `secrets` no longer holds: replaced or removed, kept only so they
 * are still redacted from what runs persist (a file a task wrote with the
 * old value can be printed after every sandbox holding it is released).
 * Sealed like `secrets`, but bound to this table as associated data, so a
 * retired ciphertext copied into `secrets` does not open: they are never
 * injected nor answered back. Deleted 90 days after `retired_at`.
 */
export const retiredSecrets = pgTable(
  "retired_secrets",
  {
    id: text("id").primaryKey(),
    ownerId: ownerId(),
    kind: text("kind").$type<SecretKind>().notNull(),
    /** The name it was stored under. */
    name: text("name").notNull(),
    keyId: text("key_id").notNull(),
    nonce: bytea("nonce").notNull(),
    /** The GCM ciphertext with its 16-byte tag appended. */
    ciphertext: bytea("ciphertext").notNull(),
    retiredAt: timestamp("retired_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("retired_secrets_owner_retired_idx").on(t.ownerId, t.retiredAt),
    check("retired_secrets_kind_check", oneOf(t.kind, SECRET_KINDS)),
  ],
);

export type RetiredSecretRow = typeof retiredSecrets.$inferSelect;

/**
 * The reviewed tool list of one MCP server of one profile, for one
 * configuration (`mcpToolSnapshotSchema`): written once by a discovery,
 * never updated. A profile's server pins one by id. Deleted with its
 * profile, or once neither the profile pins it nor a kept discovery holds it.
 */
export const mcpToolSnapshots = pgTable(
  "mcp_tool_snapshots",
  {
    id: text("id").primaryKey(),
    ownerId: ownerId(),
    profileId: text("profile_id")
      .notNull()
      .references(() => runtimeProfiles.id, { onDelete: "cascade" }),
    /** The server's name in the profile. */
    server: text("server").notNull(),
    /** SHA-256 of the configuration the tools were discovered with. */
    configHash: text("config_hash").notNull(),
    serverInfo: jsonb("server_info").$type<JsonObject>().notNull(),
    /** Sanitized and redacted tools (`mcpToolSchema`), sorted by name. */
    tools: jsonb("tools").$type<JsonObject[]>().notNull(),
    warnings: jsonb("warnings").$type<string[]>().notNull().default([]),
    discoveredAt: timestamp("discovered_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("mcp_tool_snapshots_profile_idx").on(t.profileId, t.server)],
);

export type McpToolSnapshotRow = typeof mcpToolSnapshots.$inferSelect;
export type NewMcpToolSnapshot = typeof mcpToolSnapshots.$inferInsert;

/**
 * The toolset a session pinned at its first run, kept for its life. `mcp`
 * holds one entry per MCP server it declares tools of: the server's name,
 * the profile and snapshot they came from, and those tools' definitions as
 * the snapshot held them (`mcpToolSchema`), so its declarations never
 * change, whatever happens to the profile or the snapshot later. Written
 * once; deleted with its session.
 */
export const sessionToolsets = pgTable("session_toolsets", {
  sessionId: text("session_id")
    .primaryKey()
    .references(() => sessions.id, { onDelete: "cascade" }),
  ownerId: ownerId(),
  mcp: jsonb("mcp").$type<JsonObject[]>().notNull(),
  pinnedAt: timestamp("pinned_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type SessionToolsetRow = typeof sessionToolsets.$inferSelect;

/**
 * One test of an MCP server configuration (`mcpDiscoverySchema`), run by an
 * `mcp.discover` job: `config` is the configuration tested, saved in the
 * profile or not (secrets by name only). `error` and `stderr_tail` are
 * redacted. Deleted with its profile; a profile keeps its newest ones.
 */
export const mcpDiscoveries = pgTable(
  "mcp_discoveries",
  {
    id: text("id").primaryKey(),
    ownerId: ownerId(),
    profileId: text("profile_id")
      .notNull()
      .references(() => runtimeProfiles.id, { onDelete: "cascade" }),
    server: text("server").notNull(),
    /** The configuration tested (`mcpServerSchema`). */
    config: jsonb("config").$type<JsonObject>().notNull(),
    /** A draft of the profile's sandbox the test runs on (`sandboxSpecSchema`); null: the profile's own. */
    sandbox: jsonb("sandbox").$type<JsonObject>(),
    configHash: text("config_hash").notNull(),
    status: text("status")
      .$type<McpDiscoveryStatus>()
      .notNull()
      .default("queued"),
    error: text("error"),
    stderrTail: text("stderr_tail"),
    snapshotId: text("snapshot_id").references(() => mcpToolSnapshots.id, {
      onDelete: "set null",
    }),
    durationMs: integer("duration_ms"),
    createdAt: createdAt(),
    startedAt: optionalTime("started_at"),
    finishedAt: optionalTime("finished_at"),
  },
  (t) => [
    index("mcp_discoveries_profile_idx").on(t.profileId, t.createdAt),
    // A server of a profile has at most one test queued or running.
    uniqueIndex("mcp_discoveries_one_active")
      .on(t.profileId, t.server)
      .where(sql`${t.status} in ('queued', 'running')`),
    check(
      "mcp_discoveries_status_check",
      oneOf(t.status, MCP_DISCOVERY_STATUSES),
    ),
    // Only a succeeded discovery ever holds a snapshot.
    check(
      "mcp_discoveries_snapshot_check",
      sql`${t.snapshotId} is null or ${t.status} = 'succeeded'`,
    ),
  ],
);

export type McpDiscoveryRow = typeof mcpDiscoveries.$inferSelect;
export type NewMcpDiscovery = typeof mcpDiscoveries.$inferInsert;

/** Every table, for `drizzle(client, { schema: tables })` and the `Db` type. */
export const tables = {
  runtimeProfiles,
  bots,
  botMemory,
  tasks,
  taskTemplates,
  conversationMessages,
  chatTaskUpdates,
  taskParticipants,
  taskGoalVersions,
  sessions,
  runs,
  sessionEntries,
  sessionInbox,
  taskMessages,
  taskEvents,
  artifacts,
  verificationChecks,
  usage,
  approvals,
  jobs,
  instanceSettings,
  workerHeartbeats,
  secrets,
  retiredSecrets,
  mcpToolSnapshots,
  mcpDiscoveries,
  sessionToolsets,
};
