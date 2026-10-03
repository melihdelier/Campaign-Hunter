// v1.3 tarayıcı smoke testi (Playwright/Chromium). Üretim modunu taklit eder: localApi kapalı, Supabase yok.
// Çalıştırma:  cd web && npm i --no-save playwright && npx playwright install chromium && node e2e/ui-smoke.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

let chromium;
try { ({ chromium } = await import('playwright')); }
catch {
  if (process.env.CI) throw new Error('playwright is required in CI');
  console.log('ui-smoke: playwright not installed — skipped (npm i --no-save playwright)');
  process.exit(0);
}
const { APP_VERSION } = await import('../version.js');

const root = fileURLToPath(new URL('..', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  const p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
  try { const body = await readFile(join(root, p || 'index.html')); res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }); res.end(body); }
  catch { res.writeHead(404); res.end('not found'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const failures = [];
try {
  for (const tz of ['Europe/Istanbul', 'UTC']) {
    const ctx = await browser.newContext({ serviceWorkers: 'block', timezoneId: tz, viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    const errors = [], api = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('request', r => { if (new URL(r.url()).pathname.includes('/api/')) api.push(r.url()); });
    await ctx.route(/supabase\.co/, r => r.abort());
    await page.addInitScript(() => { window.BKA_CONFIG = { localApi: false, supabaseUrl: '', supabaseAnonKey: '' }; });

    // 1) Hangi Kart? varsayılan ana ekran
    await page.goto(`${base}/index.html`);
    await page.waitForSelector('#recommend.view.active');
    assert.equal(new URL(page.url()).hash, '#/hangi-kart');
    assert.equal(await page.textContent('#pageTitle'), 'Hangi Kart?');
    assert.equal(await page.locator('.view.active').count(), 1);

    // 2) Ana menü: 3 sekme, Özet / Ekle yok
    const tabs = await page.$$eval('nav.nav .nav-btn span', els => els.map(e => e.textContent.trim()));
    assert.deepEqual(tabs, ['Hangi Kart?', 'Kampanyalar', 'Profil']);
    const box = await page.locator('nav.nav').boundingBox();
    assert.ok(box.y > 700, 'mobile: bottom navigation');
    for (const a of await page.$$('nav.nav .nav-btn')) { const b = await a.boundingBox(); assert.ok(b.height >= 44, 'touch target >= 44px'); }

    // 3) Hesaplama akışı hâlâ çalışıyor
    await page.fill('#merchant', 'Da Mario'); await page.fill('#amount', '5000'); await page.selectOption('#category', 'restoran');
    await page.click('#recommendForm button[type=submit]');
    await page.waitForSelector('#recommendResults .result-card');
    assert.ok((await page.locator('#recommendResults .result-card').count()) >= 1);

    // 4) Kampanyalar + → mevcut ekleme akışı
    await page.click('nav.nav a[data-tab="campaigns"]');
    await page.waitForSelector('#campaigns.view.active');
    await page.click('#addCampaignBtn');
    await page.waitForSelector('#privateCampaign.view.active');
    assert.equal(new URL(page.url()).hash, '#/kampanyalar/ekle');
    assert.ok(await page.isVisible('#privateCampaignForm'));
    assert.equal(await page.getAttribute('nav.nav a[data-tab="campaigns"]', 'aria-current'), 'page');
    await page.click('#privateCampaign .back-link');
    await page.waitForSelector('#campaigns.view.active');

    // 5) Profil → Veriler ve Özet (eski Özet), Info sürümü, Android geri
    await page.click('nav.nav a[data-tab="profile"]');
    await page.waitForSelector('#profile.view.active');
    await page.click('a.menu-item[href="#/profil/veriler"]');
    await page.waitForSelector('#dashboard.view.active');
    assert.ok(await page.isVisible('#catalogHealth'));
    await page.goBack();
    await page.waitForSelector('#profile.view.active');
    await page.click('a.menu-item[href="#/profil/info"]');
    await page.waitForSelector('#profileInfo.view.active');
    assert.equal((await page.textContent('#runtimeVersion')).trim(), APP_VERSION);
    const info = await page.textContent('#infoRows');
    assert.ok(info.includes(APP_VERSION) && info.includes('Build') && info.includes('Katalog son tarama'));
    assert.ok((await page.textContent('#releaseNotes')).includes(APP_VERSION));
    await page.click('a.menu-item[href="#/profil/info"]').catch(() => {});

    // 6) Hesap ve Müşteri Profili alt sayfaları
    await page.goto(`${base}/index.html#/profil/hesap`);
    await page.waitForSelector('#profileAccount.view.active');
    assert.ok(await page.isVisible('#cloudSignInBtn'));
    await page.goto(`${base}/index.html#/profil/musteri`);
    await page.waitForSelector('#profileSegments.view.active');
    assert.ok(await page.isVisible('#tebTier'));

    // 7) Eski yer imi uyumluluğu
    await page.goto(`${base}/index.html#dashboard`);
    await page.waitForSelector('#dashboard.view.active');
    assert.equal(new URL(page.url()).hash, '#/profil/veriler');

    assert.deepEqual(errors, [], `page errors (${tz})`);
    assert.deepEqual(api, [], `production must not call /api (${tz})`);
    console.log(`  ui-smoke (${tz}): OK`);
    await ctx.close();
  }
} catch (e) { failures.push(e); }
await browser.close(); server.close();
if (failures.length) { console.error(failures[0]); process.exit(1); }
console.log('v1.3 UI smoke tests: OK');
