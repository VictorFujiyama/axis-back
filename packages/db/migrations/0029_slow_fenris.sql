CREATE TABLE "atlas_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" text NOT NULL,
	"kind" text NOT NULL,
	"org_id" text NOT NULL,
	"summary" text,
	"envelope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "atlas_activity_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
CREATE INDEX "atlas_activity_org_received_idx" ON "atlas_activity" USING btree ("org_id","received_at");