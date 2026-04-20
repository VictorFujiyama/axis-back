CREATE TYPE "public"."canned_visibility" AS ENUM('personal', 'inbox', 'global');--> statement-breakpoint
CREATE TABLE "canned_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"visibility" "canned_visibility" NOT NULL,
	"owner_id" uuid,
	"inbox_id" uuid,
	"name" text NOT NULL,
	"shortcut" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "canned_shortcut_unique" UNIQUE("visibility","owner_id","inbox_id","shortcut")
);
--> statement-breakpoint
ALTER TABLE "canned_responses" ADD CONSTRAINT "canned_responses_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canned_responses" ADD CONSTRAINT "canned_responses_inbox_id_inboxes_id_fk" FOREIGN KEY ("inbox_id") REFERENCES "public"."inboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "canned_owner_idx" ON "canned_responses" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "canned_inbox_idx" ON "canned_responses" USING btree ("inbox_id");--> statement-breakpoint
CREATE INDEX "canned_visibility_idx" ON "canned_responses" USING btree ("visibility");