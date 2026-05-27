CREATE TABLE "atlas_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"atlas_account_id" uuid NOT NULL,
	"atlas_org_id" uuid NOT NULL,
	"secrets_enc" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "atlas_connections_account_unique" UNIQUE("atlas_account_id")
);
--> statement-breakpoint
ALTER TABLE "atlas_connections" ADD CONSTRAINT "atlas_connections_atlas_account_id_accounts_id_fk" FOREIGN KEY ("atlas_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "atlas_connections_org_idx" ON "atlas_connections" USING btree ("atlas_org_id");