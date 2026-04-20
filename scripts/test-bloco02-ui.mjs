import { chromium } from '/home/navi/programas/blossom-inbox/node_modules/.pnpm/playwright-core@1.59.1/node_modules/playwright-core/index.mjs';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

try {
  await page.goto('http://localhost:3201/login');
  await page.fill('input[type=email]', 'victorfujiyama@gmail.com');
  await page.fill('input[type=password]', 'w170598');
  await page.click('button[type=submit]');
  await page.waitForURL(/\/inbox/, { timeout: 30000 });

  // Sidebar: Busca link visible
  await page.waitForSelector('text=Busca', { timeout: 3000 });
  console.log('OK: sidebar has search link');

  // Go to search
  await page.click('text=Busca');
  await page.waitForURL(/\/search/);
  await page.waitForSelector('[data-testid="search-input"]');
  console.log('OK: search page loaded');
  await page.fill('[data-testid="search-input"]', 'felipe');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  console.log('OK: search executed');

  // Go to settings/canned and create one
  await page.goto('http://localhost:3201/settings/canned');
  await page.waitForSelector('[data-testid="new-canned-btn"]');
  await page.click('[data-testid="new-canned-btn"]');
  const shortcut = `uitest${Date.now()}`;
  await page.fill('[data-testid="canned-name-input"]', 'UI Test');
  await page.fill('[data-testid="canned-shortcut-input"]', shortcut);
  await page.fill('[data-testid="canned-content-input"]', 'Olá {{contato.nome}}!');
  await page.click('[data-testid="canned-save-btn"]');
  await page.waitForSelector(`[data-testid="canned-${shortcut}"]`, { timeout: 5000 });
  console.log('OK: canned response created via UI');

  const errors = logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'));
  if (errors.length > 0) {
    console.log('\nCONSOLE ERRORS:');
    for (const e of errors) console.log('  ', e);
    process.exit(1);
  }
  console.log('\nALL GREEN');
} catch (err) {
  console.error('FAIL:', err.message);
  console.log('logs:', logs);
  process.exit(1);
} finally {
  await browser.close();
}
