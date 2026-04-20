import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const SHOTS = resolve('tmp/screenshots/email-ui');
mkdirSync(SHOTS, { recursive: true });
const log = (m) => console.log(`[email-ui] ${m}`);

log('seed');
execSync(
  `docker exec blossom-postgres psql -U blossom -d blossom -c "
    DELETE FROM messages; DELETE FROM conversation_tags; DELETE FROM conversations;
    DELETE FROM contact_identities; DELETE FROM contact_tags; DELETE FROM contacts;
    DELETE FROM bots; DELETE FROM inbox_members; DELETE FROM inboxes;
    DELETE FROM tags; DELETE FROM users WHERE role='agent';" > /dev/null`,
  { shell: '/bin/bash' },
);
execSync('docker exec blossom-redis redis-cli FLUSHDB > /dev/null', { shell: '/bin/bash' });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error' && !/status of 401/.test(msg.text())) errors.push(msg.text());
});

log('1. login');
await page.goto('http://localhost:3201/login');
await page.fill('input[type=email]', 'victorfujiyama@gmail.com');
await page.fill('input[type=password]', 'w170598');
await page.click('button[type=submit]');
await page.waitForURL(/\/inbox/);

log('2. settings → inboxes → novo');
await page.goto('http://localhost:3201/settings/inboxes');
await page.waitForSelector('[data-testid="inboxes-new-btn"]');
await page.click('[data-testid="inboxes-new-btn"]');
await page.waitForSelector('[data-testid="inbox-name-input"]');

log('3. trocar tipo → email → fields aparecem');
await page.fill('[data-testid="inbox-name-input"]', 'Suporte Email');
await page.selectOption('[data-testid="inbox-channel-select"]', 'email');
await page.waitForSelector('[data-testid="inbox-from-email-input"]');
await page.waitForSelector('[data-testid="inbox-server-token-input"]');
await page.waitForSelector('[data-testid="inbox-webhook-secret-input"]');
await page.screenshot({ path: `${SHOTS}/01-email-form-fields.png` });
log('   ✅ campos email aparecem ao trocar tipo');

log('4. preencher e salvar');
await page.fill('[data-testid="inbox-from-email-input"]', 'suporte@empresa.com.br');
await page.fill('[data-testid="inbox-from-name-input"]', 'Suporte Empresa');
await page.fill('[data-testid="inbox-server-token-input"]', 'pm_token_xyz');
await page.fill('[data-testid="inbox-webhook-secret-input"]', 'wsecret_abc');
await page.screenshot({ path: `${SHOTS}/02-email-form-filled.png` });
await page.click('[data-testid="inbox-submit-btn"]');
await page.waitForTimeout(2000);
await page.screenshot({ path: `${SHOTS}/02b-after-submit.png` });
console.log('errors after submit:', errors);
await page.waitForSelector('[data-testid^="inbox-item-"]');
await page.screenshot({ path: `${SHOTS}/03-email-inbox-created.png` });

log('5. abrir edição → confirmar campos persistiram');
await page.locator('[data-testid^="inbox-item-"]').first().locator('button').nth(1).click(); // edit
await page.waitForSelector('[data-testid="inbox-from-email-input"]');
const fromEmailVal = await page.locator('[data-testid="inbox-from-email-input"]').inputValue();
const fromNameVal = await page.locator('[data-testid="inbox-from-name-input"]').inputValue();
const webhookSecretVal = await page.locator('[data-testid="inbox-webhook-secret-input"]').inputValue();
const serverTokenVal = await page.locator('[data-testid="inbox-server-token-input"]').inputValue();
if (fromEmailVal !== 'suporte@empresa.com.br') throw new Error(`fromEmail: ${fromEmailVal}`);
if (fromNameVal !== 'Suporte Empresa') throw new Error(`fromName: ${fromNameVal}`);
if (webhookSecretVal !== 'wsecret_abc') throw new Error(`webhookSecret: ${webhookSecretVal}`);
if (serverTokenVal !== '') throw new Error(`serverToken NÃO deve voltar (write-only): ${serverTokenVal}`);
log('   ✅ config persistido (fromEmail, fromName, webhookSecret); serverToken write-only confirmado');

log('6. URL do webhook visível');
const urlVisible = await page.locator('text=/webhooks/email/').count();
if (urlVisible === 0) throw new Error('URL do webhook não aparece');
log('   ✅ URL do webhook exibida no form');
await page.screenshot({ path: `${SHOTS}/04-email-edit-with-url.png` });

log(`---`);
log(`console errors: ${errors.length}`);
errors.forEach((e) => log(`  ✗ ${e}`));

await browser.close();
if (errors.length > 0) process.exit(2);
log('🎉 email UI smoke OK');
