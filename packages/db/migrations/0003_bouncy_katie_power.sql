CREATE INDEX "conversations_resolved_at_idx" ON "conversations" USING btree ("resolved_at");--> statement-breakpoint
CREATE INDEX "conversations_created_at_idx" ON "conversations" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "messages_inbox_created_idx" ON "messages" USING btree ("inbox_id","created_at");