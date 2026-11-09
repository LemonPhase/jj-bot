CREATE TABLE "mcp_discoveries" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text DEFAULT 'local' NOT NULL,
	"profile_id" text NOT NULL,
	"server" text NOT NULL,
	"config" jsonb NOT NULL,
	"sandbox" jsonb,
	"config_hash" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"stderr_tail" text,
	"snapshot_id" text,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "mcp_discoveries_status_check" CHECK ("mcp_discoveries"."status" in ('queued', 'running', 'succeeded', 'failed')),
	CONSTRAINT "mcp_discoveries_snapshot_check" CHECK ("mcp_discoveries"."snapshot_id" is null or "mcp_discoveries"."status" = 'succeeded')
);
--> statement-breakpoint
CREATE TABLE "mcp_tool_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text DEFAULT 'local' NOT NULL,
	"profile_id" text NOT NULL,
	"server" text NOT NULL,
	"config_hash" text NOT NULL,
	"server_info" jsonb NOT NULL,
	"tools" jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" DROP CONSTRAINT "jobs_kind_check";--> statement-breakpoint
ALTER TABLE "runtime_profiles" ADD COLUMN "mcp_servers" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_discoveries" ADD CONSTRAINT "mcp_discoveries_profile_id_runtime_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."runtime_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_discoveries" ADD CONSTRAINT "mcp_discoveries_snapshot_id_mcp_tool_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."mcp_tool_snapshots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tool_snapshots" ADD CONSTRAINT "mcp_tool_snapshots_profile_id_runtime_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."runtime_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_discoveries_profile_idx" ON "mcp_discoveries" USING btree ("profile_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_discoveries_one_active" ON "mcp_discoveries" USING btree ("profile_id","server") WHERE "mcp_discoveries"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "mcp_tool_snapshots_profile_idx" ON "mcp_tool_snapshots" USING btree ("profile_id","server");--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_kind_check" CHECK ("jobs"."kind" in ('session.run', 'chat.reply', 'maintenance.compact', 'mcp.discover'));