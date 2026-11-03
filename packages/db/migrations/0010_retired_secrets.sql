CREATE TABLE "retired_secrets" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text DEFAULT 'local' NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"key_id" text NOT NULL,
	"nonce" "bytea" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"retired_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retired_secrets_kind_check" CHECK ("retired_secrets"."kind" in ('provider', 'sandbox'))
);
--> statement-breakpoint
CREATE INDEX "retired_secrets_owner_retired_idx" ON "retired_secrets" USING btree ("owner_id","retired_at");