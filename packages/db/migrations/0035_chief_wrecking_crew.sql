CREATE TABLE "bots_config_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"system_prompt" text NOT NULL,
	"model" text NOT NULL,
	"provider" text NOT NULL,
	"temperature" text,
	"max_tokens" integer,
	"etag" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid
);
--> statement-breakpoint
ALTER TABLE "inboxes" ADD COLUMN "qualifier_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "bots_config_versions" ADD CONSTRAINT "bots_config_versions_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bots_config_versions" ADD CONSTRAINT "bots_config_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bots_config_versions_bot_version_uniq" ON "bots_config_versions" USING btree ("bot_id","version");