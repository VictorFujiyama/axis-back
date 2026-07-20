CREATE TABLE "inbox_playbook_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inbox_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content" text NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inbox_playbook_versions" ADD CONSTRAINT "inbox_playbook_versions_inbox_id_inboxes_id_fk" FOREIGN KEY ("inbox_id") REFERENCES "public"."inboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_playbook_versions" ADD CONSTRAINT "inbox_playbook_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_playbook_versions_inbox_version_unq" ON "inbox_playbook_versions" USING btree ("inbox_id","version");--> statement-breakpoint
CREATE INDEX "inbox_playbook_versions_inbox_created_idx" ON "inbox_playbook_versions" USING btree ("inbox_id","created_at");