// v1.4.4 tarayıcı testi: e-posta doğrulama / şifre sıfırlama yönlendirmesi ve dönüş (callback) işleme.
// GitHub Pages proje yolu taklit edilir: uygulama YALNIZ /Campaign-Hunter/ altında yayınlanır; hesap kökü (/) 404 döner
// (üretimdeki hatanın aynısı). Supabase SAHTE sunucudur (e2e/mock-supabase.mjs); gerçek e-posta gönderilmez.
// Bu test, Supabase'in doğrulama sonrası uygulamaya döndüğü URL biçimlerini (implicit akış: #access_token=…&type=signup,
// hata: #error=…&error_code=otp_expired) doğrudan açarak uygulamanın davranışını doğrular.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

let chromium;
try { ({ chromium } = await import('playwright')); }
catch {
  if (process.env.CI) throw new Error('playwright is required in CI');
  console.log('auth-callback-smoke: playwright not installed — skipped');
  process.exit(0);
}
const { SUPA, makeMock, handle } = await import('./mock-supabase.mjs');

const BASE_PATH = '/Campaign-Hunter/';
const root = fileURLToPath(new URL('..', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (!path.startsWith(BASE_PATH)) { res.writeHead(404, { 'content-type': 'text/html' }); res.end('<h1>404 — There isn\'t a GitHub Pages site here.</h1>'); return; }
  const rel = decodeURIComponent(path.slice(BASE_PATH.length));
  const p = rel ? normalize(rel).replace(/^([/\\])+/, '') : '';
  try { const body = await readFile(join(root, p || 'index.html')); res.writeHead(200, { 'content-type': TYPES[extname(p || 'index.html')] || 'application/octet-stream' }); res.end(body); }
  catch { res.writeHead(404); res.end('not found'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const APP = `${origin}${BASE_PATH}`;

const browser = await chromium.launch();
async function newPage(mock, { serviceWorkers = 'block' } = {}) {
  const ctx = await browser.newContext({ serviceWorkers, timezoneId: 'Europe/Istanbul', viewport: { width: 390, height: 844 } });
  await ctx.route(`${SUPA}/**`, r => handle(r, mock));
  await ctx.addInitScript(([u]) => { window.BKA_CONFIG = { supabaseUrl: u, supabaseAnonKey: 'sb_publishable_test', localApi: false }; }, [SUPA]);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(String(e)));
  return { ctx, page };
}
const tokenFor = (mock, u) => mock.session(u);
function seedCompletedProfile(mock, u) {
  mock.t.profiles.push({ user_id: u.id, display_name: null, onboarding_completed_at: '2026-10-01T00:00:00Z', profile_version: 1 });
  mock.t.user_banks.push({ user_id: u.id, bank_id: 'b-teb' });
  mock.t.user_cards.push({ user_id: u.id, card_product_id: 'c-teb-infinite', active: true });
  mock.t.user_profile_attributes.push({ user_id: u.id, dimension_code: 'teb_tier', option_code: 'ultra', criteria_version: null, confirmed_at: '2026-10-01T00:00:00Z' });
}
const addUser = (mock, email) => { const u = { id: `00000000-0000-4000-8000-${String(900 + mock.users.length).padStart(12, '0')}`, email, password: 'parola123!' }; mock.users.push(u); return u; };
const implicitHash = (s, type) => `#access_token=${s.access_token}&expires_at=${Math.floor(Date.now() / 1000) + 3600}&expires_in=3600&refresh_token=${s.refresh_token}&token_type=bearer&type=${type}`;

let failure = null;
try {
  // 1) Kayıt: doğrulama e-postası için yönlendirme ADRESİ açıkça uygulama köküdür (hesap kökü değil)
  {
    const mock = makeMock(); mock.requireEmailConfirmation = true;
    const { ctx, page } = await newPage(mock);
    await page.goto(APP);
    await page.waitForSelector('#authView.view.active');
    await page.click('#authModeToggle');
    await page.fill('#authEmail', 'new@example.com'); await page.fill('#authPassword', 'parola123!');
    await page.click('#authSubmitBtn');
    await page.waitForFunction(() => /E-postana gelen bağlantıyla doğrula/.test(document.querySelector('#authStatus')?.textContent || ''));
    const signup = mock.authRequests.find(r => r.path === '/auth/v1/signup');
    assert.equal(signup.redirectTo, APP, 'signup requests the app root as email redirect');
    assert.notEqual(signup.redirectTo, `${origin}/`, 'never the account root');
    assert.ok(!('redirect_to' in (signup.body || {})) && signup.body.email === 'new@example.com');
    // 2) Şifre sıfırlama: aynı kanonik kök — /index.html veya alt rota ile açılmış olsa bile
    await page.goto(`${APP}index.html#/giris`);
    await page.waitForSelector('#authView.view.active');
    await page.fill('#authEmail', 'new@example.com');
    await page.click('#authForgotBtn');
    await page.waitForFunction(() => /Şifre sıfırlama bağlantısı e-postana gönderildi/.test(document.querySelector('#authStatus')?.textContent || ''));
    const recover = mock.authRequests.find(r => r.path === '/auth/v1/recover');
    assert.equal(recover.redirectTo, APP, 'password reset uses the same canonical app root (not .../index.html)');
    await ctx.close();
  }
  // 3) Doğrulama dönüşü, profili TAMAMLANMIŞ kullanıcı: oturum kurulur, Hangi Kart? açılır, onboarding YENİDEN AÇILMAZ, URL temizlenir
  {
    const mock = makeMock();
    const u = addUser(mock, 'done@example.com'); seedCompletedProfile(mock, u);
    const { ctx, page } = await newPage(mock);
    await page.goto(`${APP}${implicitHash(tokenFor(mock, u), 'signup')}`);
    await page.waitForSelector('#recommend.view.active');
    const url = new URL(page.url());
    assert.equal(url.pathname, BASE_PATH, 'base path preserved');
    assert.equal(url.hash, '#/hangi-kart'); assert.ok(!/access_token|refresh_token/.test(page.url()), 'tokens removed from the address bar');
    assert.equal(await page.locator('#onboardingView.view.active').count(), 0, 'completed profile does not reopen onboarding');
    assert.ok(await page.evaluate(() => Boolean(JSON.parse(localStorage.getItem('bka-supabase-session-v1') || 'null')?.access_token)), 'session stored');
    // yeniden yükleme: döngü yok, aynı ekran
    await page.reload(); await page.waitForSelector('#recommend.view.active');
    assert.deepEqual(page.errors, []);
    await ctx.close();
  }
  // 4) Doğrulama dönüşü, YENİ kullanıcı (profil yok): oturumla onboarding açılır
  {
    const mock = makeMock();
    const u = addUser(mock, 'fresh@example.com');
    const { ctx, page } = await newPage(mock);
    await page.goto(`${APP}${implicitHash(tokenFor(mock, u), 'signup')}`);
    await page.waitForSelector('#onboardingView.view.active');
    assert.equal(new URL(page.url()).pathname, BASE_PATH);
    assert.ok(!/access_token/.test(page.url()));
    await ctx.close();
  }
  // 5) Süresi dolmuş / kullanılmış bağlantı: anlaşılır giriş ekranı (boş sayfa, döngü, 404 yok), URL temizlenir
  {
    const mock = makeMock();
    const { ctx, page } = await newPage(mock);
    await page.goto(`${APP}#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired`);
    await page.waitForSelector('#authView.view.active');
    const status = await page.textContent('#authStatus');
    assert.match(status, /bağlantı(sı)? geçersiz|süresi dolmuş/i);
    assert.match(status, /giriş yap/i);
    assert.ok(!/error_code|error=/.test(page.url()), 'error params removed from the address bar');
    assert.equal(new URL(page.url()).pathname, BASE_PATH);
    // sorgu dizesiyle gelen hata da aynı şekilde işlenir
    await page.goto(`${APP}?error=access_denied&error_code=otp_expired&error_description=expired#/giris`);
    await page.waitForSelector('#authView.view.active');
    assert.match(await page.textContent('#authStatus'), /süresi dolmuş|geçersiz/i);
    assert.equal(new URL(page.url()).search, '');
    await ctx.close();
  }
  // 6) Şifre sıfırlama dönüşü: oturum + Profil › Hesap (yeni şifre)
  {
    const mock = makeMock();
    const u = addUser(mock, 'reset@example.com'); seedCompletedProfile(mock, u);
    const { ctx, page } = await newPage(mock);
    await page.goto(`${APP}${implicitHash(tokenFor(mock, u), 'recovery')}`);
    await page.waitForSelector('#profileAccount.view.active');
    assert.equal(new URL(page.url()).hash, '#/profil/hesap');
    assert.match(await page.textContent('#changePasswordStatus'), /Yeni şifreni/);
    await ctx.close();
  }
  // 7) Service worker AÇIKKEN: kayıt kapsamı /Campaign-Hunter/ ve dönüş URL'si yine uygulamayı açar (yol kırpılmaz)
  {
    const mock = makeMock();
    const u = addUser(mock, 'sw@example.com'); seedCompletedProfile(mock, u);
    const { ctx, page } = await newPage(mock, { serviceWorkers: 'allow' });
    await page.goto(APP);
    await page.waitForSelector('#authView.view.active');
    const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
    assert.equal(scope, APP, 'service worker scope keeps the project base path');
    await page.goto(`${APP}${implicitHash(tokenFor(mock, u), 'signup')}`);
    await page.waitForSelector('#recommend.view.active');
    assert.equal(new URL(page.url()).pathname, BASE_PATH);
    await ctx.close();
  }
  console.log('v1.4.4 auth redirect / callback browser tests: OK');
} catch (e) { failure = e; }
await browser.close(); server.close();
if (failure) { console.error(failure); process.exit(1); }
