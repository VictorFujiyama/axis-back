ALTER TABLE "notifications" ADD COLUMN "conversation_id" uuid;--> statement-breakpoint
UPDATE "notifications" SET "conversation_id" = ("data"->>'conversationId')::uuid
  WHERE "data" ? 'conversationId'
    AND "data"->>'conversationId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND EXISTS (SELECT 1 FROM "conversations" WHERE "id" = ("data"->>'conversationId')::uuid);--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_user_type_conv_idx" ON "notifications" USING btree ("user_id","type","conversation_id");