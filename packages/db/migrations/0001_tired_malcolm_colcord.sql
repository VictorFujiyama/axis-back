ALTER TABLE "messages" DROP CONSTRAINT "messages_channel_msg_id_unique";--> statement-breakpoint
ALTER TABLE "inboxes" ADD COLUMN "secrets" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "inbox_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_inbox_id_inboxes_id_fk" FOREIGN KEY ("inbox_id") REFERENCES "public"."inboxes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_inbox_channel_msg_unique" UNIQUE("inbox_id","channel_msg_id");