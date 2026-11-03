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
ALTER TABLE "conversation_messages" ADD COLUMN "handled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_task_updates" ADD CONSTRAINT "chat_task_updates_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_task_updates" ADD CONSTRAINT "chat_task_updates_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_task_updates_pending_idx" ON "chat_task_updates" USING btree ("bot_id","created_at") WHERE "chat_task_updates"."message_id" is null;--> statement-breakpoint
CREATE INDEX "conversation_messages_waiting_idx" ON "conversation_messages" USING btree ("bot_id","sequence") WHERE "conversation_messages"."role" = 'user' and "conversation_messages"."handled_at" is null;--> statement-breakpoint
-- User messages from before this column were taken up by a reply unless one
-- is still pending for their bot: a later reply followed them, or no reply
-- job is queued or running for them (a failed reply is not answered again).
UPDATE "conversation_messages" AS "m"
SET "handled_at" = "m"."created_at"
WHERE "m"."role" = 'user'
  AND (
    EXISTS (
      SELECT 1 FROM "conversation_messages" AS "a"
      WHERE "a"."bot_id" = "m"."bot_id"
        AND "a"."role" = 'assistant'
        AND "a"."sequence" > "m"."sequence"
    )
    OR NOT EXISTS (
      SELECT 1 FROM "jobs" AS "j"
      WHERE "j"."bot_id" = "m"."bot_id"
        AND "j"."kind" = 'chat.reply'
        AND "j"."status" IN ('queued', 'running')
    )
  );
