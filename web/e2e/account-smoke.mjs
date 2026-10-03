// v1.4 tarayıcı akış testi: hesap → onboarding → Hangi Kart? → yeniden açılış → profil düzenleme → çıkış → başka kullanıcı.
// Supabase Auth + PostgREST burada SAHTE bir sunucu ile taklit edilir (RLS benzeri sahiplik filtresiyle).
// Gerçek RLS güvenliği server/tests/test_supabase_rls.py ile gerçek PostgreSQL'de ayrıca doğrulanır.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

let chromium;
try { ({ chromium } = await import('playwright')); }
catch {
  if (process.env.CI) throw new Error('playwright is required in CI');
  console.log('account-smoke: playwright not installed — skipped');
  process.exit(0);
}
const { BUNDLED_PROFILE_CATALOG: CAT } = await import('../profile-catalog.js');

// ------------------------------------------------------------------ statik sunucu
const root = fileURLToPath(new URL('..', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  const p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
  try { const body = await readFile(join(root, p || 'index.html')); res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }); res.end(body); }
  catch { res.writeHead(404); res.end('not found'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// ------------------------------------------------------------------ sahte Supabase
const SUPA = 'https://mock.supabase.test';
const criteriaRows = list => list.map(r => ({ dimension_code: r.dimensionCode, option_code: r.optionCode, criteria_version: r.criteriaVersion,
  effective_from: r.effectiveFrom, effective_to: r.effectiveTo, display_label: r.displayLabel, lower_bound: r.lowerBound, upper_bound: r.upperBound,
  bound_unit: r.boundUnit, source_url: r.sourceUrl, source_reference: r.sourceReference, verified_at: r.verifiedAt }));
function makeMock() {
  const m = { users: [], refresh: new Map(), revoked: [], fail: null, schemaMissing: false, t: {} };
  const banks = CAT.banks.map((b, i) => ({ id: `b-${b.code}`, code: b.code, name: b.name, sort_order: b.sortOrder, active: true }));
  const cards = CAT.cardProducts.map(c => ({ id: `c-${c.code}`, code: c.code, name: c.name, family: c.family, sort_order: c.sortOrder, active: true, bank_id: `b-${c.bankCode}` }));
  m.master = {
    banks, card_products: cards,
    profile_dimensions: CAT.dimensions.map(d => ({ code: d.code, label: d.label, kind: d.kind, bank_id: d.bankCode ? `b-${d.bankCode}` : null, engine_binding: d.engineBinding, setting_key: d.settingKey, sort_order: d.sortOrder, active: true })),
    profile_dimension_cards: CAT.dimensions.flatMap(d => d.cardCodes.map(c => ({ dimension_code: d.code, card_product_id: `c-${c}` }))),
    profile_dimension_options: CAT.dimensions.flatMap(d => d.options.map(o => ({ dimension_code: d.code, code: o.code, label: o.label, engine_label: o.engineLabel, sort_order: o.sortOrder, active: true }))),
    profile_option_criteria: criteriaRows(CAT.optionCriteria),
    catalog_snapshots: [],
  };
  for (const t of ['profiles', 'user_banks', 'user_cards', 'user_profile_attributes', 'user_preferences', 'user_app_state']) m.t[t] = [];
  const jwt = u => `h.${Buffer.from(JSON.stringify({ sub: u.id, email: u.email, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.s`;
  m.session = u => { const rt = `rt-${u.id}-${Math.random().toString(36).slice(2)}`; m.refresh.set(rt, u.id); return { access_token: jwt(u), refresh_token: rt, expires_in: 3600, token_type: 'bearer', user: { id: u.id, email: u.email } }; };
  m.uidFromAuth = h => { try { return JSON.parse(Buffer.from(String(h || '').split(' ')[1].split('.')[1], 'base64url').toString()).sub; } catch { return null; } };
  return m;
}

async function handle(route, mock) {
  const req = route.request();
  const url = new URL(req.url());
  const method = req.method();
  const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: body === undefined ? '' : JSON.stringify(body) });
  const body = req.postData() ? JSON.parse(req.postData()) : null;
  if (url.pathname === '/auth/v1/signup') {
    if (mock.users.some(u => u.email === body.email)) return json(400, { msg: 'User already registered' });
    const u = { id: `00000000-0000-4000-8000-${String(mock.users.length + 1).padStart(12, '0')}`, email: body.email, password: body.password };
    mock.users.push(u); return json(200, mock.session(u));
  }
  if (url.pathname === '/auth/v1/token') {
    if (url.searchParams.get('grant_type') === 'password') {
      const u = mock.users.find(x => x.email === body.email && x.password === body.password);
      return u ? json(200, mock.session(u)) : json(400, { error_description: 'Invalid login credentials' });
    }
    const uid = mock.refresh.get(body.refresh_token); const u = mock.users.find(x => x.id === uid);
    return u ? json(200, mock.session(u)) : json(400, { error_description: 'Invalid Refresh Token' });
  }
  if (url.pathname === '/auth/v1/logout') { const uid = mock.uidFromAuth(req.headers().authorization); mock.revoked.push(uid); for (const [k, v] of mock.refresh) if (v === uid) mock.refresh.delete(k); return route.fulfill({ status: 204, body: '' }); }
  if (!url.pathname.startsWith('/rest/v1/')) return json(404, {});
  const table = url.pathname.slice('/rest/v1/'.length);
  if (mock.fail && table !== 'catalog_snapshots') return route.abort('internetdisconnected');
  if (mock.schemaMissing && ['profiles', 'profile_dimensions', 'banks', 'card_products', 'profile_dimension_cards', 'profile_dimension_options', 'profile_option_criteria', 'user_banks', 'user_cards', 'user_profile_attributes', 'user_preferences'].includes(table)) {
    return json(404, { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` });
  }
  if (mock.master[table]) return method === 'GET' ? json(200, mock.master[table]) : json(403, { code: '42501', message: 'permission denied' });
  const uid = mock.uidFromAuth(req.headers().authorization);
  if (!uid) return json(401, { message: 'JWT required' });
  const rows = mock.t[table];
  if (!rows) return json(404, { code: 'PGRST205', message: 'no table' });
  // RLS benzeri: yalnız kendi satırların
  const filters = [...url.searchParams.entries()].filter(([k]) => !['select', 'order', 'on_conflict', 'limit'].includes(k));
  const match = r => r.user_id === uid && filters.every(([k, v]) => {
    if (v.startsWith('eq.')) return String(r[k]) === decodeURIComponent(v.slice(3));
    if (v.startsWith('in.(')) return v.slice(4, -1).split(',').map(decodeURIComponent).includes(String(r[k]));
    return true;
  });
  if (method === 'GET') return json(200, rows.filter(match));
  if (method === 'DELETE') { mock.t[table] = rows.filter(r => !match(r)); return route.fulfill({ status: 204, body: '' }); }
  if (method === 'POST') {
    const conflict = (url.searchParams.get('on_conflict') || '').split(',').filter(Boolean);
    const ignore = /ignore-duplicates/.test(req.headers().prefer || '');
    for (const row of [].concat(body)) {
      if (row.user_id !== uid) return json(403, { code: '42501', message: 'new row violates row-level security policy' });
      const i = rows.findIndex(r => conflict.length && conflict.every(c => r[c] === row[c]));
      if (i >= 0) { if (!ignore) rows[i] = { ...rows[i], ...row }; } else rows.push({ ...row });
    }
    return route.fulfill({ status: 201, body: '' });
  }
  return json(405, {});
}

// ------------------------------------------------------------------ yardımcılar
const browser = await chromium.launch();
async function newPage(mock, { tz = 'Europe/Istanbul' } = {}) {
  const ctx = await browser.newContext({ serviceWorkers: 'block', timezoneId: tz, viewport: { width: 390, height: 844 } });
  await ctx.route(`${SUPA}/**`, r => handle(r, mock));
  await ctx.addInitScript(([u]) => { window.BKA_CONFIG = { supabaseUrl: u, supabaseAnonKey: 'sb_publishable_test', localApi: false }; }, [SUPA]);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(String(e)));
  return { ctx, page };
}
const hashOf = page => new URL(page.url()).hash;
async function authenticate(page, email, mode = 'signin') {
  await page.waitForSelector('#authView.view.active');
  if (mode === 'signup' && (await page.textContent('#authSubmitBtn')).includes('Giriş')) await page.click('#authModeToggle');
  if (mode === 'signin' && (await page.textContent('#authSubmitBtn')).includes('oluştur')) await page.click('#authModeToggle');
  await page.fill('#authEmail', email); await page.fill('#authPassword', 'parola123!');
  await page.click('#authSubmitBtn');
}
async function onboard(page, { bank, cards, attrs = {} }) {
  await page.waitForSelector('#onboardingView.view.active');
  assert.equal(await page.isVisible('nav.nav'), false, 'nav hidden during onboarding');
  await page.click(`#onboardingBody [data-action="bank"][data-code="${bank}"]`);
  await page.click('#onbNext');
  for (const c of cards) await page.click(`#onboardingBody [data-action="card"][data-code="${c}"]`);
  await page.click('#onbNext');
  for (const [dim, opt] of Object.entries(attrs)) await page.click(`#onboardingBody [data-action="attr"][data-dim="${dim}"][data-code="${opt}"]`);
  if (await page.isVisible('#onbNext')) await page.click('#onbNext');
  await page.waitForSelector('#onbFinish:not([hidden])');
  await page.click('#onbFinish');
  await page.waitForSelector('#recommend.view.active');
}
async function recommendCards(page, merchant = 'Da Mario', amount = '5000', category = 'restoran') {
  await page.fill('#merchant', merchant); await page.fill('#amount', amount); await page.selectOption('#category', category);
  await page.click('#recommendForm button[type=submit]');
  await page.waitForSelector('#recommendResults .result-card');
  return page.$$eval('#recommendResults .result-card:not(.potential-card):not(.info-card) .result-body > strong', els => els.map(e => e.textContent.trim()));
}

let failure = null;
try {
  const mock = makeMock();
  // 1) İlk kullanım: hesap → onboarding → Hangi Kart?
  let { ctx, page } = await newPage(mock);
  await page.goto(`${base}/index.html`);
  await page.waitForSelector('#authView.view.active');
  assert.equal(hashOf(page), '#/giris'); assert.equal(await page.isVisible('nav.nav'), false);
  assert.equal(await page.locator('#recommendResults .result-card').count(), 0, 'no personal data before sign-in');
  await authenticate(page, 'a@example.com', 'signup');
  await onboard(page, { bank: 'teb', cards: ['teb-infinite'], attrs: { teb_tier: 'ultra' } });
  assert.equal(hashOf(page), '#/hangi-kart'); assert.equal(await page.isVisible('nav.nav'), true);
  let shown = await recommendCards(page);
  assert.deepEqual(shown, ['TEB — TEB Özel Infinite'], 'only the user’s own cards are compared');
  assert.ok((await page.textContent('#recommendResults')).includes('₺1.000'), 'TEB Ultra core benefit computed');
  const A = mock.users[0].id;
  assert.equal(mock.t.profiles.find(r => r.user_id === A).onboarding_completed_at !== null, true);
  assert.deepEqual(mock.t.user_cards.filter(r => r.user_id === A).map(r => r.card_product_id), ['c-teb-infinite']);
  assert.deepEqual(mock.t.user_profile_attributes.filter(r => r.user_id === A).map(r => [r.dimension_code, r.option_code]), [['teb_tier', 'ultra']]);

  // 2) Yeniden açılış: oturum geri yüklenir, profil gelir, onboarding TEKRARLANMAZ
  await page.reload();
  await page.waitForSelector('#recommend.view.active');
  assert.equal(hashOf(page), '#/hangi-kart');
  await page.goto(`${base}/index.html#/kurulum`);
  await page.waitForSelector('#recommend.view.active');
  assert.equal(hashOf(page), '#/hangi-kart', 'completed onboarding cannot be re-entered');

  // 3) Profil düzenleme: Wings Black ekle, segment seç, kaydet
  await page.goto(`${base}/index.html#/profil/kartlar`);
  await page.waitForSelector('#profileCards.view.active');
  assert.equal(await page.getAttribute('#profileCardsEditor [data-action="bank"][data-code="teb"]', 'aria-checked'), 'true');
  assert.equal(await page.locator('#profileCardsEditor [data-action="card"][data-code="akbank-wings-black"]').count(), 0, 'cards of unselected banks are hidden');
  await page.click('#profileCardsEditor [data-action="bank"][data-code="akbank"]');
  await page.click('#profileCardsEditor [data-action="card"][data-code="akbank-wings-black"]');
  assert.match(await page.textContent('#profileCardsStatus'), /Kaydedilmemiş/);
  await page.click('#profileCardsSave');
  await page.waitForFunction(() => document.querySelector('#profileCardsStatus').textContent.includes('Kaydedildi'));
  assert.deepEqual(mock.t.user_banks.filter(r => r.user_id === A).map(r => r.bank_id).sort(), ['b-akbank', 'b-teb']);
  await page.goto(`${base}/index.html#/profil/musteri`);
  await page.waitForSelector('#profileAttributesEditor [data-dim="wings_tier"]');
  await page.click('#profileAttributesEditor [data-action="attr"][data-dim="wings_tier"][data-code="black"]');
  await page.click('#profileAttributesSave');
  await page.waitForFunction(() => document.querySelector('#profileAttributesStatus').textContent.includes('Kaydedildi'));
  assert.ok(mock.t.user_profile_attributes.some(r => r.user_id === A && r.dimension_code === 'wings_tier' && r.option_code === 'black'));
  await page.goto(`${base}/index.html#/hangi-kart`);
  shown = await recommendCards(page);
  assert.deepEqual(shown.sort(), ['Akbank — Wings Black', 'TEB — TEB Özel Infinite'].sort());

  // 4) Bankayı kaldırmak kartını da kaldırır
  await page.goto(`${base}/index.html#/profil/kartlar`);
  await page.waitForSelector('#profileCardsEditor [data-action="bank"][data-code="akbank"]');
  await page.click('#profileCardsEditor [data-action="bank"][data-code="akbank"]');
  assert.equal(await page.locator('#profileCardsEditor [data-action="card"][data-code="akbank-wings-black"]').count(), 0);
  await page.click('#profileCardsSave');
  await page.waitForFunction(() => document.querySelector('#profileCardsStatus').textContent.includes('Kaydedildi'));
  assert.deepEqual(mock.t.user_cards.filter(r => r.user_id === A).map(r => r.card_product_id), ['c-teb-infinite']);
  assert.ok(!mock.t.user_profile_attributes.some(r => r.user_id === A && r.dimension_code === 'wings_tier'));

  // 5) Info doğru sürüm
  await page.goto(`${base}/index.html#/profil/info`);
  await page.waitForSelector('#profileInfo.view.active');
  const { APP_VERSION } = await import('../version.js');
  assert.equal((await page.textContent('#runtimeVersion')).trim(), APP_VERSION);

  // 6) Çıkış: sunucuda oturum sonlandırılır, oturum anahtarı silinir, kişisel veri gösterilmez
  await page.goto(`${base}/index.html#/profil/hesap`);
  await page.waitForSelector('#accountSummaryCard:not([hidden])');
  assert.ok((await page.textContent('#accountSummary')).includes('a@example.com'));
  await page.click('#accountSignOutBtn');
  await page.waitForSelector('#authView.view.active');
  assert.deepEqual(mock.revoked, [A]);
  assert.equal(await page.evaluate(() => localStorage.getItem('bka-supabase-session-v1')), null);
  assert.equal(await page.evaluate(() => localStorage.getItem('banka-kampanya-avcisi-last-query-debug')), null);

  // 7) Başka kullanıcı aynı cihazda: kendi onboarding'i, A'nın kartları görünmez
  await authenticate(page, 'b@example.com', 'signup');
  await page.waitForSelector('#onboardingView.view.active');
  assert.equal(await page.locator('#onboardingBody [aria-checked="true"]').count(), 0, 'B starts with an empty profile');
  await onboard(page, { bank: 'qnb', cards: ['qnb-ms-private'], attrs: { qnb_segment: 'private', thy_status: 'classic' } });
  shown = await recommendCards(page);
  assert.deepEqual(shown, ['QNB — Miles&Smiles QNB Private']);
  const B = mock.users[1].id;
  assert.ok(!mock.t.user_cards.some(r => r.user_id === B && r.card_product_id === 'c-teb-infinite'));

  // 8) A tekrar giriş: onboarding yok, A'nın profili
  await page.goto(`${base}/index.html#/profil/hesap`);
  await page.click('#accountSignOutBtn');
  await authenticate(page, 'a@example.com', 'signin');
  await page.waitForSelector('#recommend.view.active');
  shown = await recommendCards(page);
  assert.deepEqual(shown, ['TEB — TEB Özel Infinite']);

  // 9) Sunucuya ulaşılamazsa: önbellekteki profil kullanılır, onboarding açılmaz
  mock.fail = true;
  await page.reload();
  await page.waitForSelector('#recommend.view.active');
  assert.equal(hashOf(page), '#/hangi-kart');
  mock.fail = null;
  assert.deepEqual(page.errors, []);
  await ctx.close();

  // 10) Önbelleği olmayan cihazda sunucu hatası: hata ekranı (onboarding DEĞİL)
  ({ ctx, page } = await newPage(mock, { tz: 'UTC' }));
  await page.goto(`${base}/index.html`);
  await authenticate(page, 'a@example.com', 'signin');
  await page.waitForSelector('#recommend.view.active');
  await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('bka-profile-cache-v1:')) localStorage.removeItem(k); });
  mock.fail = true;
  await page.reload();
  await page.waitForSelector('#accountStatusView.view.active');
  assert.match(await page.textContent('#accountStatusText'), /Profil yüklenemedi/);
  assert.equal(await page.isVisible('#accountRetryBtn'), true);
  mock.fail = null;
  await page.click('#accountRetryBtn');
  await page.waitForSelector('#recommend.view.active');
  await ctx.close();

  // 11) Migration 008 uygulanmamış sunucu: eski moda düşer, onboarding açmaz, uygulama kullanılabilir
  const legacyMock = makeMock(); legacyMock.schemaMissing = true;
  ({ ctx, page } = await newPage(legacyMock));
  await page.goto(`${base}/index.html`);
  await authenticate(page, 'c@example.com', 'signup');
  await page.waitForSelector('#recommend.view.active');
  assert.equal(await page.locator('#onboardingView.view.active').count(), 0);
  await ctx.close();
  // 12) Mevcut cihaz (v1.3 hesapsız veri): ilk giriş yapan hesap, eski veriyi ÖN-DOLDURMA olarak görür ve onaylar;
  //     bu dönem doğrulanmış kalan limit/katılım durumu korunur. İkinci hesap bu veriyi devralmaz.
  const ownerMock = makeMock();
  ({ ctx, page } = await newPage(ownerMock));
  const { initialCards } = await import('../bootstrap-data.js');
  await ctx.addInitScript(([cards]) => {
    if (localStorage.getItem('seeded-legacy')) return;
    localStorage.setItem('seeded-legacy', '1');
    localStorage.setItem('banka-kampanya-avcisi-v10', JSON.stringify({
      cards, campaigns: [], meta: { version: 13 },
      settings: { staleAfterDays: 3, thyStatus: 'elite', qnbSegment: 'private', wingsTier: 'black_plus', maximilesBand: '4m_8m', crystalBand: 'under_1m', crystalCardType: 'crystal', tebTier: 'ultra' },
      states: { 'official-teb-infinite-restoran-ultra': { campaignId: 'official-teb-infinite-restoran-ultra', periodKey: '2026-10', enrollmentStatus: 'not_required', remainingLimit: 1234, valueSource: 'user_confirmed', confirmedAt: new Date().toISOString() } }
    }));
  }, [initialCards]);
  await page.goto(`${base}/index.html`);
  await authenticate(page, 'owner@example.com', 'signup');
  await page.waitForSelector('#onboardingView.view.active');
  assert.equal(await page.getAttribute('#onboardingBody [data-action="bank"][data-code="teb"]', 'aria-checked'), 'true', 'legacy data pre-fills banks');
  await page.click('#onbNext');
  assert.equal(await page.locator('#onboardingBody [data-action="card"][aria-checked="true"]').count(), 6);
  await page.click('#onboardingBody [data-action="card"][data-code="akbank-wings-elite"]'); // kullanıcı düzeltebilir
  await page.click('#onbNext');
  assert.equal(await page.getAttribute('#onboardingBody [data-action="attr"][data-dim="teb_tier"][data-code="ultra"]', 'aria-pressed'), 'true');
  assert.equal(await page.getAttribute('#onboardingBody [data-action="attr"][data-dim="thy_status"][data-code="elite"]', 'aria-pressed'), 'true');
  // v1.4.3: cihazdaki eski eşik kodlu bant seçimi nötr koda çevrilmiş olarak ön-doldurulur; etiket tarihli ölçütten gelir
  assert.equal(await page.getAttribute('#onboardingBody [data-action="attr"][data-dim="maximiles_band"][data-code="band_3"]', 'aria-pressed'), 'true');
  assert.equal((await page.textContent('#onboardingBody [data-action="attr"][data-dim="maximiles_band"][data-code="band_3"]')).trim(), '4–8 milyon TL arası');
  assert.equal(await page.getAttribute('#onboardingBody [data-action="attr"][data-dim="crystal_band"][data-code="band_1"]', 'aria-pressed'), 'true');
  await page.click('#onbNext'); await page.click('#onbFinish');
  await page.waitForSelector('#recommend.view.active');
  const owner = ownerMock.users[0].id;
  assert.equal(ownerMock.t.user_cards.filter(r => r.user_id === owner).length, 5);
  const band = ownerMock.t.user_profile_attributes.find(r => r.user_id === owner && r.dimension_code === 'maximiles_band');
  assert.equal(band.option_code, 'band_3'); assert.equal(band.criteria_version, 'v1', 'onboarding review confirms under the current criteria version');
  assert.ok(band.confirmed_at && !('amount' in band), 'confirmation time stored; no asset amount');
  shown = await recommendCards(page);
  assert.ok(!shown.includes('Akbank — Wings Elite') && shown.includes('TEB — TEB Özel Infinite'));
  assert.ok((await page.textContent('#recommendResults')).includes('1.234'), 'verified remaining limit carried over for this period');
  await page.goto(`${base}/index.html#/profil/hesap`); await page.click('#accountSignOutBtn');
  await authenticate(page, 'other@example.com', 'signup');
  await page.waitForSelector('#onboardingView.view.active');
  assert.equal(await page.locator('#onboardingBody [aria-checked="true"]').count(), 0, 'second account does not inherit device legacy data');
  await ctx.close();

  // 13) Banka eşikleri değişti (ölçüt v2 bugünden itibaren). Kullanıcının v1 onayı sessizce güncel sayılmaz:
  //     Profil › Müşteri Profili yeniden onay ister; onaylayınca v2 altında kaydedilir.
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());
  const staleMock = makeMock();
  const v1 = CAT.optionCriteria.map(r => (r.dimensionCode === 'maximiles_band' ? { ...r, effectiveFrom: '2026-01-01', effectiveTo: today } : r));
  const v2 = CAT.optionCriteria.filter(r => r.dimensionCode === 'maximiles_band').map(r => ({ ...r, criteriaVersion: 'v2', effectiveFrom: today, effectiveTo: null, displayLabel: `${r.displayLabel} (yeni)` }));
  staleMock.master.profile_option_criteria = criteriaRows([...v1, ...v2]);
  const su = { id: '00000000-0000-4000-8000-0000000000aa', email: 'stale@example.com', password: 'parola123!' };
  staleMock.users.push(su);
  staleMock.t.profiles.push({ user_id: su.id, display_name: null, onboarding_completed_at: '2026-09-01T00:00:00Z', profile_version: 1 });
  staleMock.t.user_banks.push({ user_id: su.id, bank_id: 'b-isbank' });
  staleMock.t.user_cards.push({ user_id: su.id, card_product_id: 'c-is-maximiles-black', active: true });
  staleMock.t.user_profile_attributes.push({ user_id: su.id, dimension_code: 'maximiles_band', option_code: 'band_2', criteria_version: 'v1', confirmed_at: '2026-09-01T00:00:00Z' });
  ({ ctx, page } = await newPage(staleMock));
  await page.goto(`${base}/index.html`);
  await authenticate(page, su.email, 'signin');
  await page.waitForSelector('#recommend.view.active');
  await page.goto(`${base}/index.html#/profil/musteri`);
  await page.waitForSelector('#profileAttributesEditor [data-dim="maximiles_band"]');
  assert.equal(await page.getAttribute('#profileAttributesEditor fieldset[data-status]', 'data-status'), 'stale');
  assert.equal(await page.locator('#profileAttributesEditor [data-action="confirm-attr"][data-dim="maximiles_band"]').count(), 1, 'reconfirmation prompt shown');
  assert.equal(staleMock.t.user_profile_attributes[0].criteria_version, 'v1', 'nothing rewritten silently');
  await page.click('#profileAttributesEditor [data-action="confirm-attr"][data-dim="maximiles_band"]');
  await page.click('#profileAttributesSave');
  await page.waitForFunction(() => document.querySelector('#profileAttributesStatus')?.textContent.includes('Kaydedildi'));
  const row = staleMock.t.user_profile_attributes.find(r => r.user_id === su.id);
  assert.equal(row.option_code, 'band_2'); assert.equal(row.criteria_version, 'v2');
  assert.equal(await page.getAttribute('#profileAttributesEditor fieldset[data-status]', 'data-status'), 'confirmed');
  assert.deepEqual(page.errors, []);
  await ctx.close();
  console.log('v1.4 account / onboarding / profile browser tests: OK');
} catch (e) { failure = e; }
await browser.close(); server.close();
if (failure) { console.error(failure); process.exit(1); }
