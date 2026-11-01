ALTER TABLE "task_messages" ADD COLUMN "relayed_from_message_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "created_from_message_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "task_messages_relayed_from_unique" ON "task_messages" USING btree ("task_id","relayed_from_message_id") WHERE "task_messages"."relayed_from_message_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_created_from_message_unique" ON "tasks" USING btree ("created_by_bot_id","created_from_message_id") WHERE "tasks"."created_from_message_id" is not null;