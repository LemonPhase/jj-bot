CREATE TABLE "artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text DEFAULT 'local' NOT NULL,
	"task_id" text NOT NULL,
	"session_id" text,
	"run_id" text,
	"kind" text NOT NULL,
	"path" text NOT NULL,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"content" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifacts_kind_check" CHECK ("artifacts"."kind" in ('file', 'output'))
);
--> statement-breakpoint
CREATE TABLE "bot_memory" (
	"bot_id" text PRIMARY KEY NOT NULL,
	"owner_id" text DEFAULT 'local' NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bots" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text DEFAULT 'local' NOT NULL,
	"name" text NOT NULL,
	"role" text DEFAULT '' NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"model" text,
	"runtime_profile_id" text,
	"appearance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"conversation_seq" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "conversation_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text DEFAULT 'local' NOT NULL,
	"bot_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"role" text NOT NULL,
	"text" text NOT NULL,
	"task_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_messages_bot_sequence" UNIQUE("bot_id","sequence"),
	CONSTRAINT "conversation_messages_role_check" CHECK ("conversation_messages"."role" in ('user', 'assistant'))
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"task_id" text,
	"session_id" text,
	"bot_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_session_run_session_check" CHECK ("jobs"."kind" <> 'session.run' or "jobs"."session_id" is not null),
	CONSTRAINT "jobs_chat_reply_bot_check" CHECK ("jobs"."kind" <> 'chat.reply' or "jobs"."bot_id" is not null),
	CONSTRAINT "jobs_max_attempts_check" CHECK ("jobs"."max_attempts" >= 1),
	CONSTRAINT "jobs_kind_check" CHECK ("jobs"."kind" in ('session.run', 'chat.reply')),
	CONSTRAINT "jobs_status_check" CHECK ("jobs"."status" in ('queued', 'running', 'done', 'failed', 'cancelled')),
	CONSTRAINT "jobs_running_lease_check" CHECK ("jobs"."status" <> 'running' or ("jobs"."lease_owner" is not null and "jobs"."lease_until" is not null))
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text DEFAULT 'local' NOT NULL,
	"session_id" text NOT NULL,
	"task_id" text NOT NULL,
	"number" integer NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "runs_session_number" UNIQUE("session_id","number"),
	CONSTRAINT "runs_reason_check" CHECK ("runs"."reason" in ('start', 'wake', 'recovery')),
	CONSTRAINT "runs_status_check" CHECK ("runs"."status" in ('running', 'completed', 'waiting', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "runtime_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text DEFAULT 'local' NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"sandbox" jsonb NOT NULL,
	"tools" jsonb NOT NULL,
	"budgets" jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_entries" (
	"session_id" text NOT NULL,
	"seq" integer NOT NULL,
	"owner_id" text DEFAULT 'local' NOT NULL,
	"run_id" text NOT NULL,
	"entry" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_entries_session_id_seq_pk" PRIMARY KEY("session_id","seq")
);
--> statement-breakpoint
CREATE TABLE "session_inbox" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text DEFAULT 'local' NOT NULL,
	"session_id" text NOT NULL,
	"task_id" text NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"source_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "session_inbox_kind_check" CHECK ("session_inbox"."kind" in ('brief', 'result', 'steering', 'message'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text DEFAULT 'local' NOT NULL,
	"task_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"parent_session_id" text,
	"role" text NOT NULL,
	"brief" text NOT NULL,
	"goal_version" integer NOT NULL,
	"depth" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"waiting_for" text,
	"result" text,
	"error" text,
	"activity" jsonb,
	"run_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"completion_requested" jsonb,
	CONSTRAINT "sessions_role_check" CHECK ("sessions"."role" in ('coordinator', 'worker')),
	CONSTRAINT "sessions_status_check" CHECK ("sessions"."status" in ('queued', 'running', 'waiting', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "sessions_waiting_for_check" CHECK (("sessions"."waiting_for" is null or "sessions"."waiting_for" in ('delegations', 'user')) and (("sessions"."status" = 'waiting') = ("sessions"."waiting_for" is not null)))
);
--> statement-breakpoint
CREATE TABLE "task_events" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text DEFAULT 'local' NOT NULL,
	"task_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"type" text NOT NULL,
	"bot_id" text,
	"session_id" text,
	"run_id" text,
	"caused_by" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "task_events_task_sequence" UNIQUE("task_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "task_goal_versions" (
	"task_id" text NOT NULL,
	"version" integer NOT NULL,
	"owner_id" text DEFAULT 'local' NOT NULL,
	"goal" text NOT NULL,
	"reason" text,
	"author" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_goal_versions_task_id_version_pk" PRIMARY KEY("task_id","version")
);
--> statement-breakpoint
CREATE TABLE "task_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text DEFAULT 'local' NOT NULL,
	"task_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"author_kind" text NOT NULL,
	"author_bot_id" text,
	"session_id" text,
	"intent" text NOT NULL,
	"text" text NOT NULL,
	"recipient_bot_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "task_messages_task_sequence" UNIQUE("task_id","sequence"),
	CONSTRAINT "task_messages_author_kind_check" CHECK ("task_messages"."author_kind" in ('user', 'bot', 'system')),
	CONSTRAINT "task_messages_intent_check" CHECK ("task_messages"."intent" in ('discussion', 'assignment', 'result', 'steering', 'notification'))
);
--> statement-breakpoint
CREATE TABLE "task_participants" (
	"task_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"owner_id" text DEFAULT 'local' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_participants_task_id_bot_id_pk" PRIMARY KEY("task_id","bot_id")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text DEFAULT 'local' NOT NULL,
	"title" text NOT NULL,
	"goal" text NOT NULL,
	"goal_version" integer DEFAULT 1 NOT NULL,
	"coordinator_bot_id" text NOT NULL,
	"created_by_bot_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"result" text,
	"error" text,
	"cancel_reason" text,
	"cancel_requested_at" timestamp with time zone,
	"event_seq" integer DEFAULT 0 NOT NULL,
	"message_seq" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "tasks_status_check" CHECK ("tasks"."status" in ('queued', 'running', 'waiting', 'completed', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "usage" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text DEFAULT 'local' NOT NULL,
	"task_id" text,
	"session_id" text,
	"run_id" text,
	"bot_id" text,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_memory" ADD CONSTRAINT "bot_memory_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bots" ADD CONSTRAINT "bots_runtime_profile_id_runtime_profiles_id_fk" FOREIGN KEY ("runtime_profile_id") REFERENCES "public"."runtime_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_entries" ADD CONSTRAINT "session_entries_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_inbox" ADD CONSTRAINT "session_inbox_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_inbox" ADD CONSTRAINT "session_inbox_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_parent_session_id_sessions_id_fk" FOREIGN KEY ("parent_session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_goal_versions" ADD CONSTRAINT "task_goal_versions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_messages" ADD CONSTRAINT "task_messages_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_participants" ADD CONSTRAINT "task_participants_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_participants" ADD CONSTRAINT "task_participants_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_coordinator_bot_id_bots_id_fk" FOREIGN KEY ("coordinator_bot_id") REFERENCES "public"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_bot_id_bots_id_fk" FOREIGN KEY ("created_by_bot_id") REFERENCES "public"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage" ADD CONSTRAINT "usage_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifacts_task_path_idx" ON "artifacts" USING btree ("task_id","path");--> statement-breakpoint
CREATE UNIQUE INDEX "bots_owner_name_unique" ON "bots" USING btree ("owner_id",lower("name")) WHERE "bots"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "bots_runtime_profile_idx" ON "bots" USING btree ("runtime_profile_id");--> statement-breakpoint
CREATE INDEX "jobs_queued_idx" ON "jobs" USING btree ("status","run_after") WHERE "jobs"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "jobs_running_lease_idx" ON "jobs" USING btree ("lease_until") WHERE "jobs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "jobs_task_idx" ON "jobs" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "jobs_session_idx" ON "jobs" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "jobs_bot_idx" ON "jobs" USING btree ("bot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_session_run_queued" ON "jobs" USING btree ("session_id") WHERE "jobs"."kind" = 'session.run' and "jobs"."status" = 'queued';--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_session_run_running" ON "jobs" USING btree ("session_id") WHERE "jobs"."kind" = 'session.run' and "jobs"."status" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_chat_reply_queued" ON "jobs" USING btree ("bot_id") WHERE "jobs"."kind" = 'chat.reply' and "jobs"."status" = 'queued';--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_chat_reply_running" ON "jobs" USING btree ("bot_id") WHERE "jobs"."kind" = 'chat.reply' and "jobs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "runs_task_idx" ON "runs" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_profiles_one_default" ON "runtime_profiles" USING btree ("owner_id") WHERE "runtime_profiles"."is_default";--> statement-breakpoint
CREATE INDEX "session_inbox_session_idx" ON "session_inbox" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "session_inbox_task_idx" ON "session_inbox" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "sessions_task_idx" ON "sessions" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "sessions_parent_idx" ON "sessions" USING btree ("parent_session_id");--> statement-breakpoint
CREATE INDEX "sessions_bot_status_idx" ON "sessions" USING btree ("bot_id","status");--> statement-breakpoint
CREATE INDEX "task_participants_bot_idx" ON "task_participants" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "tasks_coordinator_idx" ON "tasks" USING btree ("coordinator_bot_id");--> statement-breakpoint
CREATE INDEX "tasks_created_by_created_idx" ON "tasks" USING btree ("created_by_bot_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_task_idx" ON "usage" USING btree ("task_id");