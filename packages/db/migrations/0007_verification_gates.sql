CREATE TABLE "verification_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text DEFAULT 'local' NOT NULL,
	"task_id" text NOT NULL,
	"goal_version" integer NOT NULL,
	"attempt" integer NOT NULL,
	"position" integer NOT NULL,
	"criterion_id" text NOT NULL,
	"method" text NOT NULL,
	"outcome" text NOT NULL,
	"exit_code" integer,
	"interrupted" text,
	"duration_ms" integer NOT NULL,
	"detail" text NOT NULL,
	"output" text,
	"truncated" boolean DEFAULT false NOT NULL,
	"artifact_id" text,
	"session_id" text,
	"run_id" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	CONSTRAINT "verification_checks_attempt_criterion" UNIQUE("task_id","goal_version","attempt","criterion_id"),
	CONSTRAINT "verification_checks_method_check" CHECK ("verification_checks"."method" in ('command', 'file', 'result')),
	CONSTRAINT "verification_checks_outcome_check" CHECK ("verification_checks"."outcome" in ('passed', 'failed', 'inconclusive')),
	CONSTRAINT "verification_checks_command_pass_check" CHECK ("verification_checks"."method" <> 'command' or "verification_checks"."outcome" <> 'passed' or ("verification_checks"."exit_code" = 0 and "verification_checks"."interrupted" = 'no'))
);
--> statement-breakpoint
ALTER TABLE "task_goal_versions" ADD COLUMN "verification_plan" jsonb;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "verification_plan" jsonb;--> statement-breakpoint
ALTER TABLE "verification_checks" ADD CONSTRAINT "verification_checks_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;