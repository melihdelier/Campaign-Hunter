// v1.5.0 tarayıcı testi — "önce tara, sonra kişiselleştir":
//   * gerçek tarayıcı çıktısı (web/fixtures/giyim-regression.v1.json) statik katalog olarak sunulur;
//   * Hangi Kart? İŞYERİ BOŞ + 10.000 TL + Giyim + yurt içi + POS: TEB 1.200 TL kampanyası (Bonus üye işyeri ağı) KOŞULLU bölümde işlem başına 120 TL,
//     QNB Giyim 2.000 Mil işlem başına (500 Mil); MercedesCard Maximiles Black'te YOK; "İşyeri adı girilmedi" YOK;
//   * manuel kategori yetkili (Migros + Giyim → Giyim);
//   * Kampanyalar: varsayılan yalnız kesin uygulanabilir; uygunluğu belirsiz / diğer kart kampanyaları ayrı bölümde.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

let chromium;
try { ({ chromium } = await import('playwright')); }
catch {
  if (process.env.CI) throw new Error('playwright is required in CI');
  console.log('discovery-smoke: playwright not installed — skipped');
  process.exit(0);
}
const { SUPA, makeMock, handle } = await import('./mock-supabase.mjs');
const root = fileURLToPath(new URL('..', import.meta.url));
const FIX = JSON.parse(await readFile(join(root, 'fixtures', 'giyim-regression.v1.json'), 'utf8'));
const CATALOG = JSON.stringify({ version: 1, generatedAt: '2026-10-04T06:00:00Z', campaigns: FIX.campaigns, meta: { partial: false } });

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
  if (rel === 'data/catalog.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(CATALOG); return; }
  const p = rel ? normalize(rel) : 'index.html';
  try { const body = await readFile(join(root, p)); res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }); res.end(body); }
  catch { res.writeHead(404); res.end('not found'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

let failure = null;
try {
  const mock = makeMock();
  const ctx = await browser.newContext({ serviceWorkers: 'block', timezoneId: 'Europe/Istanbul', viewport: { width: 1280, height: 900 } });
  await ctx.route(`${SUPA}/**`, r => handle(r, mock));
  await ctx.addInitScript(([u]) => { window.BKA_CONFIG = { supabaseUrl: u, supabaseAnonKey: 'sb_publishable_test', localApi: false }; }, [SUPA]);
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date('2026-10-04T12:00:00+03:00'));
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  if (process.env.DEBUG_E2E) { page.on('request', r => { if (/catalog|snapshot/.test(r.url())) console.log('REQ', r.url()); }); page.on('console', m => console.log('CONSOLE', m.text())); }
  page.on('dialog', d => { errors.push(`dialog: ${d.message()}`); d.dismiss(); });

  await page.goto(`${base}/index.html`);
  await page.waitForSelector('#authView.view.active');
  if ((await page.textContent('#authSubmitBtn')).includes('Giriş')) await page.click('#authModeToggle');
  await page.fill('#authEmail', 'giyim@example.com'); await page.fill('#authPassword', 'parola123!');
  await page.click('#authSubmitBtn');
  await page.waitForSelector('#onboardingView.view.active');
  for (const b of ['teb', 'qnb', 'isbank']) await page.click(`#onboardingBody [data-action="bank"][data-code="${b}"]`);
  await page.click('#onbNext');
  for (const c of ['teb-infinite', 'qnb-ms-private', 'is-maximiles-black']) await page.click(`#onboardingBody [data-action="card"][data-code="${c}"]`);
  for (let i = 0; i < 6 && !(await page.isVisible('#onbFinish')); i++) await page.click('#onbNext');
  await page.click('#onbFinish');
  await page.waitForSelector('#recommend.view.active');
  await page.waitForFunction(() => (document.querySelector('#catalogStatus, .catalog-status')?.textContent || '').length >= 0);

  // ---- Hangi Kart?: işyeri BOŞ, 10.000 TL, Giyim, yurt içi, POS
  await page.fill('#merchant', '');
  await page.fill('#amount', '10000');
  await page.selectOption('#category', 'giyim');
  await page.selectOption('#locationScope', 'domestic');
  await page.selectOption('#paymentChannel', 'physical');
  await page.click('#recommendForm button[type=submit]');
  await page.waitForSelector('#recommendResults .result-card');
  const ranked = await page.$$eval('#recommendResults .result-card:not(.potential-card):not(.info-card) .result-body', els => els.map(e => e.textContent));
  const text = await page.textContent('#recommendResults');
  if (process.env.DEBUG_E2E) console.log(JSON.stringify(ranked, null, 1), text.slice(0, 3000));
  const rewards = await page.$$eval('#recommendResults .result-card:not(.potential-card):not(.info-card)', els => els.map(e => ({ body: e.textContent, reward: e.querySelector('.result-reward')?.textContent || '' })));
  if (process.env.DEBUG_E2E) console.log(rewards.map(r => r.reward));
  // TEB giyim (official: 3.000 TL+ → 120 TL, max 1.200 TL, Bonus-member merchants) → conditional merchant section only
  assert.ok(!rewards.some(r => r.body.includes('Giyim Alışverişlerinize Toplam 1.200 TL Bonus!')), 'not a guaranteed ranked winner');
  const tebC = await page.$$eval('#recommendResults .merchant-conditional-section .merchant-conditional-card', els => els.map(e => ({ body: e.textContent, reward: e.querySelector('.result-reward')?.textContent || '' })));
  const tebR = tebC.find(r => r.body.includes('Giyim Alışverişlerinize Toplam 1.200 TL Bonus!'));
  assert.ok(tebR, 'TEB giyim shown in the conditional merchant section');
  assert.match(tebR.reward, /\b120\b/, 'TEB giyim per transaction (120 TL)');
  assert.ok(!/\b300\b|1\.200/.test(tebR.reward), 'neither the old illustrative 300 nor the 1.200 TL total');
  assert.match(await page.textContent('#recommendResults .merchant-conditional-section'), /Bu avantaj ilgili üye işyerinde geçerlidir; işyerinin kampanyaya dahil olduğunu doğrula\./);
  const qnbR = rewards.find(r => /Giyim ve Kozmetik Alışverişinize 2\.000/.test(r.body));
  assert.ok(qnbR, 'QNB giyim found');
  assert.match(qnbR.reward, /\b500\b/, 'QNB giyim per qualifying transaction (500 Mil)');
  assert.ok(!/1\.000/.test(qnbR.reward), 'no 2 × 5.000 split');
  assert.ok(!/MercedesCard/.test(text), 'MercedesCard never shown for Maximiles Black');
  assert.ok(!/İşyeri adı girilmedi/.test(text), 'no hard merchant-missing block');
  assert.ok(!/Yurt Dışı Harcamalarınıza/.test(text), 'international-only is not potential for a domestic query');
  for (const hub of ['MercedesCard Kampanyaları', 'Giyim&Aksesuar Kampanyaları', 'Taksitlendirme&Erteleme']) assert.ok(!text.includes(hub));

  // ---- manuel kategori yetkili
  await page.fill('#merchant', 'Migros');
  await page.click('#recommendForm button[type=submit]');
  await page.waitForSelector('#recommendResults .input-notice');
  assert.match(await page.textContent('#recommendResults .input-notice'), /seçtiğin “giyim” kategorisi kullanıldı/);
  assert.ok((await page.textContent('#recommendResults')).includes('Giyim Alışverişlerinize Toplam 1.200 TL Bonus!'));

  // ---- Kampanyalar: varsayılan yalnız kesin uygulanabilir + ayrı bölümler
  await page.goto(`${base}/index.html#/kampanyalar`);
  await page.waitForSelector('#campaignList .campaign-card-group');
  const groups = await page.$$eval('#campaignList .campaign-card-group', els => els.map(e => ({ head: e.querySelector('.campaign-card-group-head').textContent, items: [...e.querySelectorAll(':scope > .campaign-browser-items .campaign-browser-item')].map(x => x.textContent) })));
  const tebG = groups.find(g => g.head.includes('Infinite'));
  assert.ok(tebG.items.some(t => t.includes('Giyim Alışverişlerinize Toplam 1.200 TL Bonus!')));
  const maxG = groups.find(g => g.head.includes('Maximiles Black'));
  assert.ok(!maxG.items.some(t => /MercedesCard|Kitap/.test(t)), 'Maximiles Black list has no MercedesCard/unknown-card campaign');
  assert.match(await page.textContent('#campaignList .unresolved-secondary summary'), /Kart uygunluğu doğrulanamayan kampanyalar \(1\)/);
  assert.match(await page.textContent('#campaignList .other-cards-secondary'), /MercedesCard/);
  assert.ok(!/Wings Kampanya/.test(await page.textContent('#campaignList')), 'other banks are not listed');
  assert.deepEqual(errors, []);
  await ctx.close();
  console.log('v1.5 discovery / category-only browser tests: OK');
} catch (e) { failure = e; }
await browser.close(); server.close();
if (failure) { console.error(failure); process.exit(1); }
