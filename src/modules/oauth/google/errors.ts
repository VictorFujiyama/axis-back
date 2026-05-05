/**
 * Thrown when a Gmail inbox needs the user to reauthorize via OAuth.
 *
 * Raised by `getValidAccessToken` after Google rejects the refresh token with
 * `error: 'invalid_grant'`. The inbox row's `config.needsReauth` has already
 * been flipped to `true` before this error surfaces, so the caller (sync
 * worker or outbound dispatcher) only needs to log and bail — the UI banner
 * picks the inbox up on the next render.
 */
export class GmailReauthRequiredError extends Error {
  constructor(public readonly inboxId: string) {
    super(`gmail inbox ${inboxId} requires reauthorization`);
    this.name = 'GmailReauthRequiredError';
  }
}
