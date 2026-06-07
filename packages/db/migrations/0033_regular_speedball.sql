-- Idempotent (IF NOT EXISTS) so re-running the migrator is safe.
-- PROD (hot `messages` table): apply manually with CREATE UNIQUE INDEX CONCURRENTLY
-- (cannot run inside the transactional drizzle migrator). See spec §8 + Notes finais.
CREATE UNIQUE INDEX IF NOT EXISTS "messages_atlas_journey_dedup_idx" ON "messages" USING btree ("account_id",("metadata"->>'atlas_journey_run_id'),("metadata"->>'atlas_node_id')) WHERE "messages"."metadata"->>'atlas_journey_run_id' IS NOT NULL;