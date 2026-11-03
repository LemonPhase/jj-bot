ALTER TABLE "tasks" ADD COLUMN "spend_cap_usd" double precision;--> statement-breakpoint
ALTER TABLE "usage" ADD COLUMN "priced" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX "usage_bot_created_idx" ON "usage" USING btree ("bot_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_created_idx" ON "usage" USING btree ("created_at");--> statement-breakpoint
-- Tasks from before spend caps take the default per-task cap, so none can run
-- up unbounded cost when continued. Raise or clear it with PATCH /api/tasks/:id.
UPDATE "tasks" SET "spend_cap_usd" = 5;
