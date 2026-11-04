CREATE TABLE "schedule_fires" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text DEFAULT 'local' NOT NULL,
	"schedule_id" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"outcome" text NOT NULL,
	"reason" text,
	"code" text,
	"details" jsonb,
	"missed_count" integer DEFAULT 0 NOT NULL,
	"task_id" text,
	CONSTRAINT "schedule_fires_schedule_due" UNIQUE("schedule_id","scheduled_for"),
	CONSTRAINT "schedule_fires_outcome_check" CHECK ("schedule_fires"."outcome" in ('started', 'skipped', 'missed', 'refused'))
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text DEFAULT 'local' NOT NULL,
	"name" text NOT NULL,
	"template_id" text NOT NULL,
	"trigger" jsonb NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"overlap" text DEFAULT 'skip' NOT NULL,
	"keep_workspaces" integer DEFAULT 10 NOT NULL,
	"chat_updates" text DEFAULT 'attention' NOT NULL,
	"next_fire_at" timestamp with time zone,
	"paused_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedules_overlap_check" CHECK ("schedules"."overlap" in ('skip')),
	CONSTRAINT "schedules_chat_updates_check" CHECK ("schedules"."chat_updates" in ('all', 'attention')),
	CONSTRAINT "schedules_paused_reason_check" CHECK ("schedules"."paused_reason" is null or "schedules"."paused_reason" in ('template_unusable', 'interval_too_short', 'no_next_fire')),
	CONSTRAINT "schedules_keep_workspaces_check" CHECK ("schedules"."keep_workspaces" between 0 and 50)
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "schedule_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "chat_updates" text DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "workspace_driver" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "workspace_removing_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "workspace_removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "schedule_fires" ADD CONSTRAINT "schedule_fires_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_template_id_task_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."task_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "schedules_due_idx" ON "schedules" USING btree ("enabled","next_fire_at");--> statement-breakpoint
CREATE INDEX "schedules_template_idx" ON "schedules" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "schedules_owner_created_idx" ON "schedules" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "tasks_schedule_idx" ON "tasks" USING btree ("schedule_id","created_at");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_chat_updates_check" CHECK ("tasks"."chat_updates" in ('all', 'attention'));