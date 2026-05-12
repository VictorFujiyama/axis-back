# Changelog

## Phase D.1 — Atlas connector envelope (Phase 12 §12.1) — 2026-05-12

- AtlasEventJob expanded to the `kind`/`action` discriminator envelope (`conversation_turn` | `conversation_summary` | `contact`). Listeners in `src/modules/atlas-events/enqueue.ts` now build envelopes via the pure helpers in `src/modules/atlas-events/build-envelope.ts` (`buildConversationTurnEnvelope` / `buildHandoffEnvelope` / `buildResolvedEnvelope`), populating `actors[]` / `participants[]` / `viewableBy` / `accountId` and capping `summary` to 200 chars. Phase B legacy variants stay in the union to drain in-flight queue jobs during deploy.
- Worker (`src/modules/atlas-events/worker.ts`) gained a dual-shape serializer: new envelopes are POSTed as snake_case (`source_ref`, `occurred_at`, `account_id`, `viewable_by`, `actors[].app_user_id`) while legacy Phase B jobs keep their existing wire shape. Endpoint is now configurable via `ATLAS_EVENTS_ENDPOINT` (default `/api/connectors/messaging/events` — Phase 12 receiver; rollback to `/api/messaging/events` by env override without redeploy).
- Idempotency uses `sourceRef` as BullMQ `jobId` (`<conversationId>:<event>:<messageId|timestamp>`), so retries and duplicate emits dedupe deterministically at enqueue time.
