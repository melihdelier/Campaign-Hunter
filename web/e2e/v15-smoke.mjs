// v1.5.0 tarayıcı testi: kapsam farkındalığı (rozetler, kartsız banka, Hangi Kart? notu, Uygulama Bilgisi tablosu)
// ve "Bankam listede yok" isteği. Supabase SAHTE sunucudur (e2e/mock-supabase.mjs); gerçek RLS: server/tests.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

let chromium;
try { ({ chromium } = await import('playwright')); }
catch {
  if (process.env.CI) throw new Error('playwright is required in CI');
  console.log('v15-smoke: playwright not installed — skipped');
  process.exit(0);
}
const { SUPA, makeMock, handle } = await import('./mock-supabase.mjs');
const { BUNDLED_PROFILE_CATALOG: CAT } = await import('../profile-catalog.js');

const root = fileURLToPath(new URL('..', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
  const p = rel ? normalize(rel) : 'index.html';
  try { const body = await readFile(join(root, p)); res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }); res.end(body); }
  catch { res.writeHead(404); res.end('not found'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
async function newPage(mock) {
  const ctx = await browser.newContext({ serviceWorkers: 'block', timezoneId: 'Europe/Istanbul', viewport: { width: 390, height: 844 } });
  await ctx.route(`${SUPA}/**`, r => handle(r, mock));
  await ctx.addInitScript(([u]) => { window.BKA_CONFIG = { supabaseUrl: u, supabaseAnonKey: 'sb_publishable_test', localApi: false }; }, [SUPA]);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(String(e)));
  return { ctx, page };
}
async function signup(page, email) {
  await page.waitForSelector('#authView.view.active');
  if ((await page.textContent('#authSubmitBtn')).includes('Giriş')) await page.click('#authModeToggle');
  await page.fill('#authEmail', email); await page.fill('#authPassword', 'parola123!');
  await page.click('#authSubmitBtn');
  await page.waitForSelector('#onboardingView.view.active');
}
const bankRowText = (page, code) => page.textContent(`#onboardingBody [data-action="bank"][data-code="${code}"]`);

let failure = null;
try {
  // 1) Kapsam rozetleri + yalnız kartsız banka seçen kullanıcı onboarding'i tamamlayabilir
  {
    const mock = makeMock();
    const { ctx, page } = await newPage(mock);
    await page.goto(`${base}/index.html`);
    await signup(page, 'g@example.com');
    assert.match(await bankRowText(page, 'garanti'), /Kart listesi hazırlanıyor · Kampanyalar yakında/);
    assert.match(await bankRowText(page, 'denizbank'), /Henüz desteklenmiyor/);
    assert.match(await bankRowText(page, 'teb'), /1 kart ürünü/);
    assert.ok(!/Henüz desteklenmiyor|Kampanyalar yakında/.test(await bankRowText(page, 'teb')));
    await page.click('#onboardingBody [data-action="bank"][data-code="garanti"]');
    await page.click('#onbNext');
    assert.match(await page.textContent('#onboardingBody [data-bank="garanti"] .no-cards'), /kart listesi henüz hazırlanmadı/);
    // kartlar adımından devam edilebilir (boyut yok → inceleme)
    await page.click('#onbNext');
    await page.waitForSelector('#onbFinish:not([hidden])');
    assert.equal(await page.isDisabled('#onbFinish'), false);
    await page.click('#onbFinish');
    await page.waitForSelector('#recommend.view.active');
    const uid = mock.users[0].id;
    assert.equal(mock.t.user_cards.filter(r => r.user_id === uid).length, 0, 'no card invented for a card-less bank');
    assert.deepEqual(mock.t.user_banks.filter(r => r.user_id === uid).map(r => r.bank_id), ['b-garanti']);
    await page.fill('#merchant', 'Da Mario'); await page.fill('#amount', '5000'); await page.selectOption('#category', 'restoran');
    await page.click('#recommendForm button[type=submit]');
    await page.waitForSelector('#recommendResults .coverage-note');
    assert.match(await page.textContent('#recommendResults .coverage-note'), /Garanti BBVA için kart ve kampanya desteği henüz hazır değil/);
    assert.equal(await page.locator('#recommendResults .result-card:not(.info-card)').count(), 0, 'no unowned card in the ranking');
    assert.deepEqual(page.errors, []);
    await ctx.close();
  }
  // 2) Kısmi destekli + kartsız banka birlikte: TEB sonucu aynı, kısa not görünür; Uygulama Bilgisi'nde kapsam tablosu
  {
    const mock = makeMock();
    const { ctx, page } = await newPage(mock);
    await page.goto(`${base}/index.html`);
    await signup(page, 't@example.com');
    await page.click('#onboardingBody [data-action="bank"][data-code="teb"]');
    await page.click('#onboardingBody [data-action="bank"][data-code="ziraat"]');
    await page.click('#onbNext');
    await page.click('#onboardingBody [data-action="card"][data-code="teb-infinite"]');
    await page.click('#onbNext');
    await page.click('#onboardingBody [data-action="attr"][data-dim="teb_tier"][data-code="ultra"]');
    assert.equal((await page.textContent('#onboardingBody [data-action="attr"][data-dim="teb_tier"][data-code="ultra"]')).trim(), 'Ultra', 'clean tier label');
    await page.click('#onbNext'); await page.click('#onbFinish');
    await page.waitForSelector('#recommend.view.active');
    await page.fill('#merchant', 'Da Mario'); await page.fill('#amount', '5000'); await page.selectOption('#category', 'restoran');
    await page.click('#recommendForm button[type=submit]');
    await page.waitForSelector('#recommendResults .result-card');
    assert.ok((await page.textContent('#recommendResults')).includes('₺1.000'), 'TEB Ultra core benefit unchanged');
    assert.match(await page.textContent('#recommendResults .coverage-note'), /Ziraat Bankası/);
    assert.ok(!/TEB için/.test(await page.textContent('#recommendResults .coverage-note')), 'partial support is not flagged in the normal flow');
    await page.goto(`${base}/index.html#/profil/info`);
    await page.waitForSelector('#coverageInfo table');
    assert.equal(await page.locator('#coverageInfo tbody tr').count(), CAT.banks.length);
    assert.equal(await page.getAttribute('#coverageInfo tr[data-bank="ziraat"]', 'data-level'), 'coming');
    assert.equal(await page.getAttribute('#coverageInfo tr[data-bank="teb"]', 'data-level'), 'partial');
    assert.equal(await page.getAttribute('#coverageInfo tr[data-bank="denizbank"]', 'data-level'), 'unsupported');
    assert.ok(!(await page.textContent('#coverageInfo')).includes('Tam destek'), 'no bank shown as fully supported');
    // 3) "Bankam listede yok": yalnız istek; ana veri değişmez; aynı banka tekrar istenirse çift kayıt yok
    const banksBefore = JSON.stringify(mock.master.banks);
    await page.goto(`${base}/index.html#/profil/kartlar`);
    await page.waitForSelector('#profileCardsEditor .bank-request');
    await page.click('#profileCardsEditor .bank-request summary');
    await page.fill('#profileCardsEditor .bank-request-name', 'ING Bank');
    await page.click('#profileCardsEditor [data-action="bank-request-send"]');
    await page.waitForFunction(() => /isteğin kaydedildi/.test(document.querySelector('#profileCardsEditor .bank-request-status')?.textContent || ''));
    await page.fill('#profileCardsEditor .bank-request-name', 'ING');
    await page.click('#profileCardsEditor [data-action="bank-request-send"]');
    await page.waitForTimeout(300);
    const uid = mock.users[0].id;
    const reqs = mock.t.bank_support_requests.filter(r => r.user_id === uid);
    assert.equal(reqs.length, 1, 'duplicate request aggregated'); assert.equal(reqs[0].normalized_key, 'ing'); assert.equal(reqs[0].requested_name, 'ING Bank');
    assert.equal(JSON.stringify(mock.master.banks), banksBefore, 'canonical banks untouched');
    assert.equal(await page.locator('#profileCardsEditor [data-action="bank"][data-code="ing"]').count(), 0, 'no bank created');
    assert.deepEqual(page.errors, []);
    await ctx.close();
  }
  console.log('v1.5 coverage / bank request browser tests: OK');
} catch (e) { failure = e; }
await browser.close(); server.close();
if (failure) { console.error(failure); process.exit(1); }
