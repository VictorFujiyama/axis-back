import type { FastifyBaseLogger } from 'fastify';
import { config as appConfig } from '../../config';

interface TwilioSetupParams {
  accountSid: string;
  authToken: string;
  webhookUrl: string;
  fromNumber?: string;
  messagingServiceSid?: string;
  channel: 'whatsapp' | 'sms';
  log?: FastifyBaseLogger;
}

interface TwilioSetupResult {
  ok: boolean;
  target?: 'messaging-service' | 'phone-number' | 'whatsapp-sender';
  description?: string;
}

function basicAuth(accountSid: string, authToken: string): string {
  return 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');
}

/** Twilio error responses include PII (accountSid, phone_number, uri). Extract
 * only the fields safe to log: numeric code and short message. */
function redactTwilioError(body: string): { code?: number; message?: string } {
  try {
    const j = JSON.parse(body) as { code?: number; message?: string };
    const message = typeof j.message === 'string' ? j.message.slice(0, 200) : undefined;
    return { code: typeof j.code === 'number' ? j.code : undefined, message };
  } catch {
    return {};
  }
}

async function updateMessagingService(params: {
  accountSid: string;
  authToken: string;
  messagingServiceSid: string;
  webhookUrl: string;
}): Promise<{ status: number; body: string }> {
  const { accountSid, authToken, messagingServiceSid, webhookUrl } = params;
  const body = new URLSearchParams({
    InboundRequestUrl: webhookUrl,
    InboundMethod: 'POST',
    UseInboundWebhookOnNumber: 'false',
  });
  const url = `${appConfig.TWILIO_API_URL}/2010-04-01/Services/${encodeURIComponent(messagingServiceSid)}.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(accountSid, authToken),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: res.status, body: await res.text() };
}

async function findPhoneNumberSid(params: {
  accountSid: string;
  authToken: string;
  phoneNumber: string;
}): Promise<string | null> {
  const { accountSid, authToken, phoneNumber } = params;
  const url = `${appConfig.TWILIO_API_URL}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(phoneNumber)}`;
  const res = await fetch(url, {
    headers: { Authorization: basicAuth(accountSid, authToken) },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const data = (await res.json().catch(() => ({}))) as {
    incoming_phone_numbers?: Array<{ sid?: string }>;
  };
  return data.incoming_phone_numbers?.[0]?.sid ?? null;
}

async function updatePhoneNumber(params: {
  accountSid: string;
  authToken: string;
  phoneNumberSid: string;
  webhookUrl: string;
}): Promise<{ status: number; body: string }> {
  const { accountSid, authToken, phoneNumberSid, webhookUrl } = params;
  const body = new URLSearchParams({
    SmsUrl: webhookUrl,
    SmsMethod: 'POST',
  });
  const url = `${appConfig.TWILIO_API_URL}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/IncomingPhoneNumbers/${encodeURIComponent(phoneNumberSid)}.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(accountSid, authToken),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: res.status, body: await res.text() };
}

async function findWhatsAppSenderSid(params: {
  accountSid: string;
  authToken: string;
  whatsAppAddress: string;
}): Promise<string | null> {
  const { accountSid, authToken, whatsAppAddress } = params;
  const url = 'https://messaging.twilio.com/v2/Channels/Senders?Channel=whatsapp';
  const res = await fetch(url, {
    headers: { Authorization: basicAuth(accountSid, authToken) },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const data = (await res.json().catch(() => ({}))) as {
    senders?: Array<{ sid?: string; sender_id?: string }>;
  };
  const match = data.senders?.find((s) => s.sender_id === whatsAppAddress);
  return match?.sid ?? null;
}

async function updateWhatsAppSender(params: {
  accountSid: string;
  authToken: string;
  senderSid: string;
  webhookUrl: string;
}): Promise<{ status: number; body: string }> {
  const { accountSid, authToken, senderSid, webhookUrl } = params;
  const url = `https://messaging.twilio.com/v2/Channels/Senders/${encodeURIComponent(senderSid)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(accountSid, authToken),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      webhook: { callback_url: webhookUrl, callback_method: 'POST' },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: res.status, body: await res.text() };
}

/**
 * Sets the inbound webhook on Twilio for a newly created inbox. Mirrors
 * Chatwoot's Twilio::WebhookSetupService: prefers Messaging Service if present,
 * otherwise looks up the IncomingPhoneNumber by E.164 and updates SmsUrl.
 *
 * Best-effort: never throws. On failure, the finish page still shows the URL
 * for the user to paste manually into the Twilio Console.
 */
export async function setTwilioWebhook(
  params: TwilioSetupParams,
): Promise<TwilioSetupResult> {
  const { accountSid, authToken, webhookUrl, fromNumber, messagingServiceSid, log } =
    params;
  try {
    if (messagingServiceSid) {
      const r = await updateMessagingService({
        accountSid,
        authToken,
        messagingServiceSid,
        webhookUrl,
      });
      if (r.status >= 200 && r.status < 300) {
        return { ok: true, target: 'messaging-service' };
      }
      log?.warn(
        { status: r.status, twilioError: redactTwilioError(r.body) },
        'twilio.setWebhook: messaging service update failed',
      );
      return { ok: false, description: `messaging service HTTP ${r.status}` };
    }

    if (!fromNumber) {
      return { ok: false, description: 'no fromNumber or messagingServiceSid' };
    }

    const cleanNumber = fromNumber.replace(/^whatsapp:/i, '');

    // WhatsApp senders live in the Messaging Channels API, not IncomingPhoneNumbers.
    // Pricing webhook field is on the sender itself — setting SmsUrl on a backing
    // IncomingPhoneNumber does not route WhatsApp traffic.
    if (params.channel === 'whatsapp') {
      const sid = await findWhatsAppSenderSid({
        accountSid,
        authToken,
        whatsAppAddress: `whatsapp:${cleanNumber}`,
      });
      if (!sid) {
        log?.warn(
          { fromNumber: cleanNumber },
          'twilio.setWebhook: WhatsApp sender not found — user must configure webhook manually',
        );
        return { ok: false, description: 'whatsapp sender not found' };
      }
      const r = await updateWhatsAppSender({
        accountSid,
        authToken,
        senderSid: sid,
        webhookUrl,
      });
      if (r.status >= 200 && r.status < 300) {
        return { ok: true, target: 'whatsapp-sender' };
      }
      log?.warn(
        { status: r.status, twilioError: redactTwilioError(r.body) },
        'twilio.setWebhook: whatsapp sender update failed',
      );
      return { ok: false, description: `whatsapp sender HTTP ${r.status}` };
    }

    const sid = await findPhoneNumberSid({
      accountSid,
      authToken,
      phoneNumber: cleanNumber,
    });
    if (!sid) {
      log?.warn(
        { fromNumber: cleanNumber },
        'twilio.setWebhook: phone number not found in IncomingPhoneNumbers — user must configure webhook manually',
      );
      return { ok: false, description: 'phone number sid not found' };
    }
    const r = await updatePhoneNumber({
      accountSid,
      authToken,
      phoneNumberSid: sid,
      webhookUrl,
    });
    if (r.status >= 200 && r.status < 300) {
      return { ok: true, target: 'phone-number' };
    }
    log?.warn(
      { status: r.status, twilioError: redactTwilioError(r.body) },
      'twilio.setWebhook: phone number update failed',
    );
    return { ok: false, description: `phone number HTTP ${r.status}` };
  } catch (err) {
    log?.warn({ err }, 'twilio.setWebhook: network error');
    return { ok: false, description: err instanceof Error ? err.message : 'network error' };
  }
}

/** Builds the public webhook URL Twilio should POST to. Returns null if
 * PUBLIC_API_URL is not configured (Twilio requires a publicly reachable URL). */
export function twilioWebhookUrl(
  channel: 'whatsapp' | 'sms',
  inboxId: string,
): string | null {
  if (!appConfig.PUBLIC_API_URL) return null;
  const base = appConfig.PUBLIC_API_URL.replace(/\/$/, '');
  return `${base}/webhooks/${channel}/${inboxId}`;
}
