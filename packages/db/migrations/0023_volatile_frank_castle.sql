ALTER TABLE "notifications" ADD COLUMN "message_id" uuid;--> statement-breakpoint
-- Backfill from data->>'messageId' when the referenced message still exists.
UPDATE "notifications" SET "message_id" = ("data"->>'messageId')::uuid
  WHERE "data" ? 'messageId'
    AND "data"->>'messageId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND EXISTS (SELECT 1 FROM "messages" WHERE "id" = ("data"->>'messageId')::uuid);--> statement-breakpoint
-- Clean up orphan mention notifications whose source message was deleted —
-- these were showing up in the sidebar "Menções" filter with no visible cause.
DELETE FROM "notifications"
  WHERE "type" = 'mention'
    AND "message_id" IS NULL
    AND (
      NOT ("data" ? 'messageId')
      OR NOT EXISTS (SELECT 1 FROM "messages" WHERE "id"::text = "data"->>'messageId')
    );--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;