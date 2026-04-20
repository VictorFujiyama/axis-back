import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const SHOTS = resolve('tmp/screenshots');
mkdirSync(SHOTS, { recursive: true });

const log = (msg) => console.log(`[smoke] ${msg}`);

log('0. seeding test data');
execSync(
  `docker exec blossom-postgres psql -U blossom -d blossom -c "
    DELETE FROM messages; DELETE FROM conversation_tags; DELETE FROM conversations;
    DELETE FROM contact_identities; DELETE FROM contact_tags; DELETE FROM contacts;
    DELETE FROM inbox_members; DELETE FROM inboxes; DELETE FROM tags;
    DELETE FROM users WHERE role='agent';" > /dev/null`,
  { shell: '/bin/bash' },
);
execSync('docker exec blossom-redis redis-cli FLUSHDB > /dev/null', { shell: '/bin/bash' });

const BASE = 'http://localhost:3200';
const loginRes = await fetch(`${BASE}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'victorfujiyama@gmail.com', password: 'w170598' }),
});
const { accessToken } = await loginRes.json();
const inboxRes = await fetch(`${BASE}/api/v1/inboxes`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
  body: JSON.stringify({
    name: 'Canal Site',
    channelType: 'api',
    config: {},
    secrets: { apiToken: 'webtoken' },
  }),
});
const inbox = await inboxRes.json();
// Admin needs to be inbox member to be assignable (validation added in review #2)
const meRes = await fetch(`${BASE}/api/v1/auth/me`, {
  headers: { Authorization: `Bearer ${accessToken}` },
});
const me = await meRes.json();
await fetch(`${BASE}/api/v1/inboxes/${inbox.id}/members`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
  body: JSON.stringify({ userIds: [me.id] }),
});
const inboundMsg = (body, channelMsgId) =>
  fetch(`${BASE}/webhooks/api/${inbox.id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer webtoken' },
    body: JSON.stringify({ ...body, channelMsgId }),
  });
await inboundMsg(
  { from: { identifier: 'joao_v', name: 'João Silva', email: 'joao@cli.com' }, content: 'Oi, queria saber sobre o produto X' },
  'm1',
);
await inboundMsg({ from: { identifier: 'joao_v' }, content: 'Vocês fazem entrega no DF?' }, 'm2');
await inboundMsg(
  { from: { identifier: 'maria_v', name: 'Maria Lima', phone: '+5511988887777' }, content: 'Bom dia! Recebi pedido errado' },
  'm3',
);

const errors = [];
const warnings = [];

// Re-define log inside run scope (above usage) — declared at top already.
async function run() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  const allMessages = [];
  page.on('console', (msg) => {
    const t = msg.type();
    const text = msg.text();
    allMessages.push({ type: t, text });
    // 401 from intentional wrong-password step is expected
    if (t === 'error' && /status of 401/.test(text)) return;
    if (t === 'error') errors.push(text);
    else if (t === 'warning') warnings.push(text);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

  log('1. login page');
  await page.goto('http://localhost:3201/login');
  await page.waitForSelector('[data-testid="login-form"]');
  await page.screenshot({ path: `${SHOTS}/01-login.png` });

  log('2. fill credentials and submit');
  await page.fill('input[type=email]', 'victorfujiyama@gmail.com');
  await page.fill('input[type=password]', 'w170598');
  await page.click('button[type=submit]');

  log('3. wait for inbox redirect');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${SHOTS}/02b-after-submit.png` });
  log(`   current url: ${page.url()}`);
  log(`   errors so far: ${errors.length}`);
  errors.forEach((e) => log(`     ${e}`));
  await page.waitForURL(/\/inbox/, { timeout: 5_000 });
  await page.waitForSelector('[data-testid="conversation-list"]');
  await page.screenshot({ path: `${SHOTS}/02-inbox-loaded.png` });

  log('4. count conversations');
  const conversations = await page.locator('[data-testid^="conversation-item-"]').count();
  if (conversations < 2) throw new Error(`expected >= 2 conversations, got ${conversations}`);
  log(`   ${conversations} conversations visible`);

  log('5. open first conversation');
  await page.locator('[data-testid^="conversation-item-"]').first().click();
  await page.waitForSelector('[data-testid="messages-list"]');
  await page.waitForSelector('[data-testid^="message-"]');
  await page.screenshot({ path: `${SHOTS}/03-conversation-open.png` });

  log('6. assign to me');
  const assignBtn = page.locator('[data-testid="assign-me-btn"]');
  if (await assignBtn.count()) {
    await assignBtn.click();
    await page.waitForTimeout(500);
  }

  log('7. send a reply');
  await page.fill('[data-testid="message-input"]', 'Olá! Recebi sua mensagem, vou verificar.');
  await page.click('[data-testid="send-btn"]');
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid^="message-"]').length >= 3,
    { timeout: 5_000 },
  );
  await page.screenshot({ path: `${SHOTS}/04-reply-sent.png` });
  log('   reply visible in chat');

  log('8. send a private note');
  await page.check('[data-testid="private-note-toggle"]');
  await page.fill('[data-testid="message-input"]', 'Possível upsell, anotar pra retorno');
  await page.click('[data-testid="send-btn"]');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/05-private-note.png` });

  log('9. resolve conversation');
  await page.click('[data-testid="resolve-btn"]');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/06-resolved.png` });

  log('10. logout');
  // Remove Next.js dev overlay portal so it doesn't intercept clicks
  await page.evaluate(() => {
    document.querySelectorAll('nextjs-portal').forEach((el) => el.remove());
  });
  await page.click('[data-testid="logout-button"]');
  await page.waitForURL(/\/login/, { timeout: 5_000 });
  await page.screenshot({ path: `${SHOTS}/07-logged-out.png` });

  log('11. wrong password attempt');
  await page.fill('input[type=email]', 'victorfujiyama@gmail.com');
  await page.fill('input[type=password]', 'errada');
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid="login-error"]');
  await page.screenshot({ path: `${SHOTS}/08-login-error.png` });

  log('---');
  log(`console errors:   ${errors.length}`);
  errors.forEach((e) => log(`  ✗ ${e}`));
  log(`console warnings: ${warnings.length}`);
  warnings.slice(0, 10).forEach((w) => log(`  ⚠ ${w}`));
  log('all messages:');
  allMessages.slice(-15).forEach((m) => log(`  [${m.type}] ${m.text.slice(0, 200)}`));

  await browser.close();

  if (errors.length > 0) {
    process.exit(2);
  }
  log('✅ smoke OK');
}

run().catch((err) => {
  console.error('[smoke] ✗', err);
  process.exit(1);
});
