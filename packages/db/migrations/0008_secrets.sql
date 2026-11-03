CREATE TABLE "secrets" (
	"owner_id" text DEFAULT 'local' NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"key_id" text NOT NULL,
	"nonce" "bytea" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"hint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "secrets_owner_id_kind_name_pk" PRIMARY KEY("owner_id","kind","name"),
	CONSTRAINT "secrets_kind_check" CHECK ("secrets"."kind" in ('provider', 'sandbox'))
);
--> statement-breakpoint
ALTER TABLE "runtime_profiles" ADD COLUMN "secrets" jsonb DEFAULT '[]'::jsonb NOT NULL;