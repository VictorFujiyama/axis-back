// Mock external system that handles a custom action webhook.
// Validates HMAC, returns success with optional privateNote and contactUpdate.
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 4200);
const SECRET = process.env.ACTION_SECRET;
if (!SECRET) {
  console.error('Missing ACTION_SECRET env');
  process.exit(1);
}

function verify(raw, sigHeader, tsHeader) {
  if (!sigHeader || typeof sigHeader !== 'string') return false;
  if (!tsHeader || typeof tsHeader !== 'string') return false;
  const tsNum = Number(tsHeader);
  if (!Number.isFinite(tsNum)) return false;
  // Reject skew > 5 min (replay protection)
  if (Math.abs(Math.floor(Date.now() / 1000) - tsNum) > 300) return false;
  const m = sigHeader.match(/v1=([a-f0-9]+)/i);
  if (!m) return false;
  const provided = m[1];
  const expected = createHmac('sha256', SECRET).update(`${tsHeader}.${raw}`).digest('hex');
  if (expected.length !== provided.length) return false;
  let ok = 0;
  for (let i = 0; i < expected.length; i++) ok |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  return ok === 0;
}

createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end();
    return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!verify(raw, req.headers['x-blossom-signature'], req.headers['x-blossom-timestamp'])) {
      console.warn('[mock-action] invalid signature');
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

    const motivo = payload.formData?.motivo ?? 'sem motivo';
    const observacao = payload.formData?.observacao ?? '';

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'success',
        message: `Pedido cancelado (mock). Motivo: ${motivo}`,
        privateNote: `Cancelamento processado. Motivo: ${motivo}. Obs: ${observacao || '—'}.`,
        contactUpdate: {
          customFields: { ultimo_cancelamento: new Date().toISOString(), motivo },
        },
      }),
    );
    console.log(`[mock-action] action=${payload.action} executed by ${payload.executedBy?.email}`);
  });
}).listen(PORT, () => {
  console.log(`[mock-action] listening on http://localhost:${PORT}`);
});
