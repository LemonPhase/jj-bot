DROP INDEX "approvals_one_pending";--> statement-breakpoint
ALTER TABLE "approvals" ALTER COLUMN "tool_call_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ALTER COLUMN "tool" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ALTER COLUMN "summary" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ALTER COLUMN "args" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ALTER COLUMN "rule" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ALTER COLUMN "goal_version" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "kind" text DEFAULT 'tool' NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "spend" jsonb;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "approve_spend_past_threshold" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_one_pending_spend" ON "approvals" USING btree ("task_id",("spend" ->> 'scope'),(case when "spend" ->> 'scope' = 'bot' then "bot_id" else '' end),(("spend" ->> 'capUsd')::numeric)) WHERE "approvals"."kind" = 'spend' and "approvals"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_one_pending" ON "approvals" USING btree ("session_id") WHERE "approvals"."kind" = 'tool' and "approvals"."status" = 'pending';--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_kind_check" CHECK ("approvals"."kind" in ('tool', 'spend'));--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_kind_columns_check" CHECK (case when "approvals"."kind" = 'tool' then "approvals"."tool_call_id" is not null and "approvals"."tool" is not null and "approvals"."summary" is not null and "approvals"."args" is not null and "approvals"."rule" is not null and "approvals"."goal_version" is not null and "approvals"."spend" is null else "approvals"."spend" is not null and "approvals"."tool_call_id" is null and "approvals"."tool" is null and "approvals"."args" is null and "approvals"."rule" is null and "approvals"."spend" ->> 'scope' in ('task', 'bot') end);