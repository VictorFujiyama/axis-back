/**
 * Structured error codes for the journey-outbound-messaging MCP tools
 * (`messaging.list_inboxes`, `messaging.upsert_conversation_and_send`).
 *
 * These codes ride on `MessagingToolError.errCode` so the Atlas-side journey
 * handlers can map each failure onto a per-error retry policy (spec D14):
 *   - INBOX_NOT_FOUND / INBOX_DISABLED / INBOX_NOT_CONFIGURED → fail (non-retriable)
 *   - CONTACT_RESOLUTION_FAILED                               → skipped
 *   - PROVIDER_RATE_LIMITED / PROVIDER_TRANSIENT             → fail (retriable)
 *   - PROVIDER_REJECTED / OUTSIDE_24H_WINDOW                 → fail (non-retriable, clear reason)
 *   - CHANNEL_NOT_IMPLEMENTED (axis sender missing)         → fail (non-retriable)
 *
 * Distinct from the transport-level `MessagingToolErrorCode`
 * (`not_found | forbidden | bad_request | conflict`) which maps to MCP
 * protocol error shapes. `errCode` is the domain-level structured reason.
 */
export const ERR = {
  INBOX_NOT_FOUND: 'INBOX_NOT_FOUND',
  INBOX_DISABLED: 'INBOX_DISABLED',
  INBOX_NOT_CONFIGURED: 'INBOX_NOT_CONFIGURED',
  CONTACT_RESOLUTION_FAILED: 'CONTACT_RESOLUTION_FAILED',
  PROVIDER_RATE_LIMITED: 'PROVIDER_RATE_LIMITED',
  PROVIDER_TRANSIENT: 'PROVIDER_TRANSIENT',
  PROVIDER_REJECTED: 'PROVIDER_REJECTED',
  OUTSIDE_24H_WINDOW: 'OUTSIDE_24H_WINDOW',
  CHANNEL_NOT_IMPLEMENTED: 'CHANNEL_NOT_IMPLEMENTED',
} as const;

export type ErrCode = (typeof ERR)[keyof typeof ERR];
