CREATE TYPE "public"."bot_type" AS ENUM('external', 'builtin');--> statement-breakpoint
CREATE TABLE "bot_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"bot_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message_id" uuid,
	"event" text NOT NULL,
	"direction" text NOT NULL,
	"status" text NOT NULL,
	"http_status" integer,
	"latency_ms" integer,
	"attempt" integer DEFAULT 1,
	"payload" jsonb,
	"response" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bots" ALTER COLUMN "webhook_url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "inboxes" ADD COLUMN "default_bot_id" uuid;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "bot_type" "bot_type" DEFAULT 'external' NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "config" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_events" ADD CONSTRAINT "bot_events_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_events" ADD CONSTRAINT "bot_events_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bot_events_bot_created_idx" ON "bot_events" USING btree ("bot_id","created_at");--> statement-breakpoint
CREATE INDEX "bot_events_conversation_idx" ON "bot_events" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "bot_events_status_idx" ON "bot_events" USING btree ("status","created_at");--> statement-breakpoint
ALTER TABLE "inboxes" ADD CONSTRAINT "inboxes_default_bot_id_bots_id_fk" FOREIGN KEY ("default_bot_id") REFERENCES "public"."bots"("id") ON DELETE set null ON UPDATE no action;