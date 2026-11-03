ALTER TABLE "tasks" ADD COLUMN "spend_cap_usd" double precision;--> statement-breakpoint
ALTER TABLE "usage" ADD COLUMN "priced" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX "usage_bot_created_idx" ON "usage" USING btree ("bot_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_created_idx" ON "usage" USING btree ("created_at");--> statement-breakpoint
-- Tasks from before spend caps take the default per-task cap, so none can run
-- up unbounded cost when continued. Raise or clear it with PATCH /api/tasks/:id.
UPDATE "tasks" SET "spend_cap_usd" = 5;
--> statement-breakpoint
-- Calls recorded at no cost but with tokens were on models with no listed
-- price: their cost is unknown, not zero.
UPDATE "usage" SET "priced" = false
WHERE "cost_usd" = 0
  AND "input_tokens" + "output_tokens" + "cache_read_tokens" + "cache_write_tokens" > 0;
