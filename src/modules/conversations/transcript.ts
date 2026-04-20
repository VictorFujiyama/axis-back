import type { FastifyBaseLogger } from 'fastify';
import { config } from '../../config';

interface TranscriptContext {
  subject: string;
  html: string;
  text: string;
  to: string;
}

/**
 * Send a conversation transcript by email. Uses SMTP_* env vars via nodemailer.
 * When SMTP is not configured (dev environments), throws so the caller can
 * respond with a 503 instead of silently dropping the message.
 */
export async function sendTranscriptEmail(
  ctx: TranscriptContext,
  log: FastifyBaseLogger,
): Promise<void> {
  if (!config.SMTP_HOST || !config.SMTP_FROM) {
    throw new Error(
      'SMTP not configured — set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM to enable transcript emails',
    );
  }
  const nodemailer = await import('nodemailer').then((m) => m.default ?? m);
  const transporter = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_PORT === 465,
    auth:
      config.SMTP_USER && config.SMTP_PASS
        ? { user: config.SMTP_USER, pass: config.SMTP_PASS }
        : undefined,
  });
  await transporter.sendMail({
    from: config.SMTP_FROM,
    to: ctx.to,
    subject: ctx.subject,
    text: ctx.text,
    html: ctx.html,
  });
  log.info({ to: ctx.to, subject: ctx.subject }, 'transcript email sent');
}

interface TranscriptMessage {
  senderType: string;
  senderName: string;
  content: string | null;
  createdAt: Date;
  isPrivateNote: boolean;
}

export function renderTranscript(opts: {
  contactName: string;
  messages: TranscriptMessage[];
}): { html: string; text: string } {
  const rows = opts.messages
    .filter((m) => !m.isPrivateNote && m.content)
    .map((m) => {
      const date = m.createdAt.toISOString().replace('T', ' ').slice(0, 16);
      return { date, who: m.senderName, content: m.content ?? '' };
    });
  const textBody = rows
    .map((r) => `[${r.date}] ${r.who}: ${r.content}`)
    .join('\n');
  const htmlRows = rows
    .map(
      (r) =>
        `<tr><td style="padding:8px;border-bottom:1px solid #eee;color:#666;white-space:nowrap;vertical-align:top;">${r.date}</td><td style="padding:8px;border-bottom:1px solid #eee;font-weight:600;vertical-align:top;">${escapeHtml(r.who)}</td><td style="padding:8px;border-bottom:1px solid #eee;">${escapeHtml(r.content)}</td></tr>`,
    )
    .join('');
  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,sans-serif;color:#222;background:#fff;"><h2>Transcrição da conversa com ${escapeHtml(opts.contactName)}</h2><table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;max-width:720px;font-size:13px;">${htmlRows}</table></body></html>`;
  return { html, text: textBody };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
