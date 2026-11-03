CREATE TABLE "task_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text DEFAULT 'local' NOT NULL,
	"title" text NOT NULL,
	"goal" text NOT NULL,
	"coordinator_bot_id" text NOT NULL,
	"participant_bot_ids" jsonb NOT NULL,
	"verification_plan" jsonb,
	"spend_cap_usd" double precision,
	"spend_cap_inherit" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_templates_cap_check" CHECK (not ("task_templates"."spend_cap_inherit" and "task_templates"."spend_cap_usd" is not null))
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "template_id" text;--> statement-breakpoint
CREATE INDEX "task_templates_owner_created_idx" ON "task_templates" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "task_templates_coordinator_idx" ON "task_templates" USING btree ("coordinator_bot_id");--> statement-breakpoint
CREATE INDEX "tasks_template_idx" ON "tasks" USING btree ("template_id");