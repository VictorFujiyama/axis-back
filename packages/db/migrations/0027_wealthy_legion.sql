CREATE TABLE "atlas_user_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"axis_user_id" uuid NOT NULL,
	"atlas_app_user_id" text NOT NULL,
	"atlas_org_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "atlas_user_links_unique" UNIQUE("account_id","atlas_org_id","atlas_app_user_id")
);
--> statement-breakpoint
ALTER TABLE "atlas_user_links" ADD CONSTRAINT "atlas_user_links_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "atlas_user_links" ADD CONSTRAINT "atlas_user_links_axis_user_id_users_id_fk" FOREIGN KEY ("axis_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "atlas_user_links_account_idx" ON "atlas_user_links" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "atlas_user_links_axis_user_idx" ON "atlas_user_links" USING btree ("axis_user_id");