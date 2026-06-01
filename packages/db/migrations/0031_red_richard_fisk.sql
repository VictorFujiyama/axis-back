CREATE TABLE "inbox_playbooks" (
	"inbox_id" uuid PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"etag" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inbox_playbooks" ADD CONSTRAINT "inbox_playbooks_inbox_id_inboxes_id_fk" FOREIGN KEY ("inbox_id") REFERENCES "public"."inboxes"("id") ON DELETE cascade ON UPDATE no action;