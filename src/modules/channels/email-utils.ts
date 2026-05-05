export type ParsedAddress = { name: string | undefined; email: string };

const ANGLE_RE = /^\s*"?(.*?)"?\s*<([^>]+)>\s*$/;
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+$/;

/**
 * Parse a single RFC 5322-ish address. Handles the common forms emitted by
 * mail clients: `"Display Name" <user@host>`, `Display Name <user@host>`,
 * `<user@host>`, and bare `user@host`. Returns `null` for malformed input
 * (including non-strings). The email is always returned lowercased.
 */
export function parseRfc5322Address(raw: unknown): ParsedAddress | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const angle = trimmed.match(ANGLE_RE);
  if (angle) {
    const name = (angle[1] ?? '').trim();
    const email = (angle[2] ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return null;
    return { name: name || undefined, email };
  }

  if (EMAIL_RE.test(trimmed)) {
    return { name: undefined, email: trimmed.toLowerCase() };
  }

  return null;
}

/** Strip HTML tags to produce a crude plaintext fallback — no sanitizer lib yet. */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
