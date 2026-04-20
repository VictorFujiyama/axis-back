// Dummy bot: echo + handoff on "humano"/"atendente".
// Usage: BOT_ID=... BOT_SECRET=... BLOSSOM_API=http://localhost:3200 PORT=4100 node scripts/dummy-bot.mjs
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 4100);
const BOT_ID = process.env.BOT_ID;
const BOT_SECRET = process.env.BOT_SECRET;
const API = process.env.BLOSSOM_API ?? 'http://localhost:3200';

if (!BOT_ID || !BOT_SECRET) {
  console.error('Missing env: BOT_ID, BOT_SECRET');
  process.exit(1);
}

const HANDOFF_KEYWORDS = /\b(humano|atendente|pessoa|gerente)\b/i;

function verifySignature(rawBody, header) {
  if (!header || typeof header !== 'string') return false;
  const expected = `sha256=${createHmac('sha256', BOT_SECRET).update(rawBody).digest('hex')}`;
  // Constant-time compare
  if (expected.length !== header.length) return false;
  let ok = 0;
  for (let i = 0; i < expected.length; i++) {
    ok |= expected.charCodeAt(i) ^ header.charCodeAt(i);
  }
  return ok === 0;
}

async function callBack(payload, idemKey) {
  const res = await fetch(`${API}/api/v1/bots/${BOT_ID}/respond`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${BOT_SECRET}`,
      ...(idemKey ? { 'X-Idempotency-Key': idemKey } : {}),
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`[bot] callback ${payload.type} failed:`, res.status, text);
  } else {
    console.log(`[bot] callback ${payload.type} OK (${res.status})`);
  }
}

const server = createServer((req, res) => {
  let chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!verifySignature(raw, req.headers['x-blossom-signature'])) {
      console.warn('[bot] invalid signature');
      res.writeHead(401);
      res.end('invalid signature');
      return;
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      res.writeHead(400);
      res.end('invalid json');
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));

    // Process async
    const { conversation, contact, message, eventId } = payload;
    if (!message || message.senderType !== 'contact') return;

    const text = String(message.content ?? '');
    const contactName = contact?.name || 'amigo(a)';

    if (HANDOFF_KEYWORDS.test(text)) {
      await callBack(
        {
          type: 'message',
          conversationId: conversation.id,
          content: `Sem problema, ${contactName}. Estou te encaminhando para um atendente humano. Aguarde um instante.`,
        },
        `${eventId}-msg`,
      );
      await callBack(
        {
          type: 'handoff',
          conversationId: conversation.id,
          note: `Cliente pediu humano. Última msg: "${text.slice(0, 100)}"`,
        },
        `${eventId}-handoff`,
      );
    } else {
      await callBack(
        {
          type: 'message',
          conversationId: conversation.id,
          content: `Olá ${contactName}! Recebi: "${text}". Como posso ajudar? (digite "humano" se preferir falar com um atendente)`,
        },
        `${eventId}-msg`,
      );
    }
  });
});

server.listen(PORT, () => {
  console.log(`[bot] dummy bot listening on http://localhost:${PORT}`);
  console.log(`[bot] BOT_ID=${BOT_ID}`);
  console.log(`[bot] callback API=${API}`);
});
