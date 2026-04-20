CREATE TABLE "csat_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"score" integer NOT NULL,
	"kind" text DEFAULT 'csat' NOT NULL,
	"comment" text,
	"responded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "csat_responses" ADD CONSTRAINT "csat_responses_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "csat_responses" ADD CONSTRAINT "csat_responses_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "csat_conversation_idx" ON "csat_responses" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "csat_contact_idx" ON "csat_responses" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "csat_responded_idx" ON "csat_responses" USING btree ("responded_at");