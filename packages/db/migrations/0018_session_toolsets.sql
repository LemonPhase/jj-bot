CREATE TABLE "session_toolsets" (
	"session_id" text PRIMARY KEY NOT NULL,
	"owner_id" text DEFAULT 'local' NOT NULL,
	"mcp" jsonb NOT NULL,
	"pinned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_toolsets" ADD CONSTRAINT "session_toolsets_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- A session that already ran pinned no MCP tool: it never gains one.
INSERT INTO "session_toolsets" ("session_id", "owner_id", "mcp") SELECT "id", "owner_id", '[]'::jsonb FROM "sessions" WHERE "run_count" > 0;
