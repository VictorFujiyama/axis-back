export interface ComposeMimeFrom {
  email: string;
  name?: string;
}

export interface ThreadingHints {
  inReplyTo?: string;
  references?: string;
}

export interface ComposeMimeOptions {
  from: ComposeMimeFrom;
  to: string;
  subject: string;
  body: string;
  threadingHints?: ThreadingHints;
}

function escapeQuoted(value: string): string {
  return value.replace(/[\\"]/g, '\\$&');
}

function formatFrom(addr: ComposeMimeFrom): string {
  if (addr.name && addr.name.length > 0) {
    return `"${escapeQuoted(addr.name)}" <${addr.email}>`;
  }
  return addr.email;
}

/**
 * Build an RFC 5322 MIME message for outbound Gmail send.
 * UTF-8 plain text only — sufficient for the auto-quote-on-reply contract; no
 * HTML, no multipart, no attachments. Headers use CRLF line endings as required
 * by RFC 5322 § 2.1.
 */
export function composeMimeRfc5322(opts: ComposeMimeOptions): string {
  const lines: string[] = [
    `From: ${formatFrom(opts.from)}`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
  ];
  if (opts.threadingHints?.inReplyTo) {
    lines.push(`In-Reply-To: ${opts.threadingHints.inReplyTo}`);
  }
  if (opts.threadingHints?.references) {
    lines.push(`References: ${opts.threadingHints.references}`);
  }
  return `${lines.join('\r\n')}\r\n\r\n${opts.body}`;
}
