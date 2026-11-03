CREATE TABLE "approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text DEFAULT 'local' NOT NULL,
	"task_id" text NOT NULL,
	"session_id" text NOT NULL,
	"run_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"tool_call_id" text NOT NULL,
	"tool" text NOT NULL,
	"summary" text NOT NULL,
	"args" jsonb NOT NULL,
	"rule" jsonb NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"goal_version" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"outcome" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"started_run_id" text,
	"started_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "approvals_session_call" UNIQUE("session_id","tool_call_id"),
	CONSTRAINT "approvals_status_check" CHECK ("approvals"."status" in ('pending', 'approved', 'denied', 'expired', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "chat_task_updates" DROP CONSTRAINT "chat_task_updates_event_check";--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_waiting_for_check";--> statement-breakpoint
ALTER TABLE "chat_task_updates" ADD COLUMN "approval_id" text;--> statement-breakpoint
ALTER TABLE "runtime_profiles" ADD COLUMN "approvals" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_one_pending" ON "approvals" USING btree ("session_id") WHERE "approvals"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "approvals_task_idx" ON "approvals" USING btree ("task_id","created_at");--> statement-breakpoint
ALTER TABLE "chat_task_updates" ADD CONSTRAINT "chat_task_updates_event_check" CHECK ("chat_task_updates"."event" in ('completed', 'failed', 'waiting', 'approval'));--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_waiting_for_check" CHECK (("sessions"."waiting_for" is null or "sessions"."waiting_for" in ('delegations', 'user', 'approval')) and (("sessions"."status" = 'waiting') = ("sessions"."waiting_for" is not null)));