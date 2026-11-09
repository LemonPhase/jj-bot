CREATE TABLE "staged_uploads" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text DEFAULT 'local' NOT NULL,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"content" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "upload_message_id" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "upload_state" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "placed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "upload_error" text;--> statement-breakpoint
CREATE INDEX "staged_uploads_expires_idx" ON "staged_uploads" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "artifacts_pending_uploads_idx" ON "artifacts" USING btree ("task_id","created_at") WHERE "artifacts"."upload_state" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_pending_upload_path_unique" ON "artifacts" USING btree ("task_id",lower("path")) WHERE "artifacts"."upload_state" = 'pending';--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_upload_state_check" CHECK (("artifacts"."upload_message_id" is null and "artifacts"."upload_state" is null) or ("artifacts"."upload_message_id" is not null and "artifacts"."upload_state" in ('pending', 'placed', 'failed') and "artifacts"."kind" = 'file'));