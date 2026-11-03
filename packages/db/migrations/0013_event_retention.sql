ALTER TABLE "jobs" DROP CONSTRAINT "jobs_kind_check";--> statement-breakpoint
ALTER TABLE "task_events" ADD COLUMN "payload_artifact_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "events_compacted_through" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_maintenance_compact_queued" ON "jobs" USING btree ("kind") WHERE "jobs"."kind" = 'maintenance.compact' and "jobs"."status" = 'queued';--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_maintenance_compact_running" ON "jobs" USING btree ("kind") WHERE "jobs"."kind" = 'maintenance.compact' and "jobs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "tasks_finished_idx" ON "tasks" USING btree ("finished_at") WHERE "tasks"."status" in ('completed', 'failed', 'cancelled');--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_kind_check" CHECK ("jobs"."kind" in ('session.run', 'chat.reply', 'maintenance.compact'));