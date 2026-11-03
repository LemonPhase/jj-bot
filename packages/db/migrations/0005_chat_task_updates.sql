CREATE TABLE "chat_task_updates" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text DEFAULT 'local' NOT NULL,
	"bot_id" text NOT NULL,
	"task_id" text NOT NULL,
	"event" text NOT NULL,
	"task_event_seq" integer NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"message_id" text,
	"answered_at" timestamp with time zone,
	CONSTRAINT "chat_task_updates_task_event" UNIQUE("task_id","task_event_seq"),
	CONSTRAINT "chat_task_updates_event_check" CHECK ("chat_task_updates"."event" in ('completed', 'failed', 'waiting'))
);
--> statement-breakpoint
ALTER TABLE "chat_task_updates" ADD CONSTRAINT "chat_task_updates_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_task_updates" ADD CONSTRAINT "chat_task_updates_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_task_updates_pending_idx" ON "chat_task_updates" USING btree ("bot_id","created_at") WHERE "chat_task_updates"."message_id" is null;