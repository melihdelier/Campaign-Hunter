// v1.4.4 regresyon: kimlik doğrulama e-postası yönlendirmesi (kayıt + şifre sıfırlama) ve Supabase dönüş işleme.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const mem = new Map();
globalThis.localStorage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
globalThis.window = { BKA_CONFIG: { supabaseUrl: 'https://proj.supabase.co', supabaseAnonKey: 'sb_publishable_x' } };
const cs = await import('./cloud-sync.js');

const PROD_MODULE = 'https://melihdelier.github.io/Campaign-Hunter/cloud-sync.js';
const PROD_APP = 'https://melihdelier.github.io/Campaign-Hunter/';
const ACCOUNT_ROOT = 'https://melihdelier.github.io/';

// ---------------------------------------------------------------- 1) tek kanonik uygulama kökü
{
  assert.equal(cs.getAuthRedirectUrl(PROD_MODULE), PROD_APP, 'GitHub Pages project path preserved');
  assert.notEqual(cs.getAuthRedirectUrl(PROD_MODULE), ACCOUNT_ROOT, 'never the GitHub Pages account root');
  assert.equal(cs.getAuthRedirectUrl(`${PROD_MODULE}?v=build123#x`), PROD_APP, 'query/hash dropped');
  assert.equal(cs.getAuthRedirectUrl('http://localhost:8080/cloud-sync.js'), 'http://localhost:8080/', 'local development');
  assert.equal(cs.getAuthRedirectUrl('http://127.0.0.1:5500/web/cloud-sync.js'), 'http://127.0.0.1:5500/web/', 'local dev in a subfolder');
  assert.equal(cs.getAuthRedirectUrl('https://kampanya.example.com/cloud-sync.js'), 'https://kampanya.example.com/', 'future custom domain at root');
  assert.equal(cs.getAuthRedirectUrl('file:///C:/app/web/cloud-sync.js'), undefined, 'non-http origins fall back to Supabase Site URL');
  // Varsayılan: modülün kendi konumu (index.html ile aynı dizin). Node'da file:// → undefined (tarayıcıda e2e test eder).
  assert.equal(cs.getAuthRedirectUrl(), undefined);
  console.log('canonical auth redirect URL tests: OK');
}

// ---------------------------------------------------------------- 2) kayıt ve şifre sıfırlama AYNI kökü ister
{
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ id: 'u1', email: 'a@b.co' }) }; };
  await cs.signUp('a@b.co', 'parola123!', { moduleUrl: PROD_MODULE });
  await cs.requestPasswordReset('a@b.co', { moduleUrl: PROD_MODULE });
  const expected = PROD_APP;
  const [signup, recover] = calls.map(c => new URL(c.url));
  assert.equal(signup.pathname, '/auth/v1/signup'); assert.equal(signup.searchParams.get('redirect_to'), expected, 'signup sends redirect_to explicitly');
  assert.equal(recover.pathname, '/auth/v1/recover'); assert.equal(recover.searchParams.get('redirect_to'), expected, 'password reset uses the same canonical root');
  assert.deepEqual(JSON.parse(calls[0].init.body), { email: 'a@b.co', password: 'parola123!' });
  assert.deepEqual(JSON.parse(calls[1].init.body), { email: 'a@b.co' });
  assert.ok(calls.every(c => !c.url.includes(encodeURIComponent(ACCOUNT_ROOT) + '&') && !c.url.endsWith(encodeURIComponent(ACCOUNT_ROOT))), 'never the account root');
  // yerel geliştirme
  calls.length = 0;
  await cs.signUp('a@b.co', 'parola123!', { moduleUrl: 'http://localhost:8080/cloud-sync.js' });
  assert.equal(new URL(calls[0].url).searchParams.get('redirect_to'), 'http://localhost:8080/');
  // http(s) olmayan konum: redirect_to gönderilmez (Supabase Site URL kullanılır), istek yine yapılır
  calls.length = 0;
  await cs.signUp('a@b.co', 'parola123!');
  assert.equal(new URL(calls[0].url).searchParams.get('redirect_to'), null);
  // Tek mantık: cloud-sync.js içinde location.pathname'den yönlendirme üretilmez
  const src = readFileSync(new URL('./cloud-sync.js', import.meta.url), 'utf8');
  assert.ok(!/location\.(origin|pathname)/.test(src), 'no page-path-based redirect logic remains');
  assert.equal((src.match(/redirect_to=/g) || []).length, 1, 'redirect_to built in exactly one place');
  console.log('signup / password reset redirect tests: OK');
}

// ---------------------------------------------------------------- 3) Supabase dönüş biçimleri
{
  const jwt = (sub, exp) => `h.${Buffer.from(JSON.stringify({ sub, exp })).toString('base64url')}.s`;
  const exp = Math.floor(Date.now() / 1000) + 3600;
  mem.clear();
  let r = cs.captureAuthCallback({ hash: `#access_token=${jwt('u1', exp)}&expires_at=${exp}&expires_in=3600&refresh_token=rt1&token_type=bearer&type=signup`, search: '' });
  assert.deepEqual(r, { kind: 'session', type: 'signup' });
  assert.equal(JSON.parse(mem.get('bka-supabase-session-v1')).refresh_token, 'rt1');
  r = cs.captureAuthCallback({ hash: `#access_token=${jwt('u1', exp)}&refresh_token=rt2&expires_in=3600&type=recovery`, search: '' });
  assert.equal(r.type, 'recovery');
  mem.clear();
  r = cs.captureAuthCallback({ hash: '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired', search: '' });
  assert.equal(r.kind, 'error'); assert.equal(r.code, 'otp_expired'); assert.match(r.description, /expired/);
  assert.equal(mem.get('bka-supabase-session-v1'), undefined, 'no session from an error callback');
  r = cs.captureAuthCallback({ hash: '#/giris', search: '?error=access_denied&error_code=otp_expired&error_description=x' });
  assert.equal(r.kind, 'error');
  assert.equal(cs.captureAuthCallback({ hash: '', search: '?code=abc' }).kind, 'signin_required');
  assert.equal(cs.captureAuthCallback({ hash: '', search: '?token_hash=abc&type=signup' }).kind, 'signin_required');
  assert.equal(cs.captureAuthCallback({ hash: '#/hangi-kart', search: '' }), null, 'normal routes are not callbacks');
  assert.equal(cs.captureAuthCallback({ hash: '#/profil/hesap', search: '?v=1' }), null);
  console.log('auth callback parsing tests: OK');
}

// ---------------------------------------------------------------- 4) açılış sırası, temel yol ve service worker
{
  const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  const boot = app.slice(app.lastIndexOf('const authCallback = captureAuthCallback(location)'));
  assert.ok(boot.indexOf('captureAuthCallback(location)') < boot.indexOf('wireNav();'), 'callback captured before the hash router runs');
  assert.ok(boot.indexOf('wireNav();') < boot.indexOf('initAccount()'));
  assert.match(app, /history\.replaceState\(null, '', `\$\{location\.pathname\}\$\{target\}`\)/, 'URL cleanup keeps the current base path');
  assert.ok(!/history\.replaceState\(null, '', '\/[^#]/.test(app), 'no absolute-root replaceState');
  const sw = readFileSync(new URL('./sw.js', import.meta.url), 'utf8');
  const assets = sw.match(/const ASSETS=\[([\s\S]*?)\];/)[1];
  assert.ok(!/'\/(?!\/)/.test(assets), 'service worker assets are relative (base path preserved)');
  assert.match(app, /serviceWorker\.register\('\.\/sw\.js'\)/, 'SW registered relative → scope is the app directory');
  const manifest = JSON.parse(readFileSync(new URL('./manifest.webmanifest', import.meta.url), 'utf8'));
  assert.equal(manifest.scope, './'); assert.equal(manifest.start_url, './index.html');
  console.log('boot order / base path / service worker tests: OK');
}
