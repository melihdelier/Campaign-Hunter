// v1.4 regresyon: kişisel profil modeli, Supabase profil deposu (istek biçimleri), onboarding kapısı, çıkış.
import assert from 'node:assert/strict';
import { BUNDLED_PROFILE_CATALOG as CAT } from './profile-catalog.js';
import { emptyProfile, normalizeProfile, applicableDimensions, toggleBank, toggleCard, setAttribute, isProfileComplete, canCompleteOnboarding,
  profileToEngineCards, profileToLegacySettings, legacyToProfilePrefill, diffProfiles, banksAffectedByAttributeChange, nextOnboardingStep, previousOnboardingStep } from './profile-model.js';
import { createProfileStore, SchemaMissingError, readProfileCache, writeProfileCache } from './profile-store.js';
import { resolveRoute, guardRoute, DEFAULT_ROUTE } from './router.js';
import { recommend } from './engine.js';
import { calculateLoyalty } from './loyalty.js';
import { initialCampaigns, initialCards } from './bootstrap-data.js';

const NOW = new Date('2026-10-05T12:00:00+03:00');

// ---------------------------------------------------------------- profil modeli
{
  let p = emptyProfile();
  assert.deepEqual(profileToEngineCards(p, CAT), [], 'empty profile → no cards (no hard-coded owner portfolio)');
  for (const v of Object.values(profileToLegacySettings(p, CAT))) assert.equal(v, null);

  // Kart seçmek bankasını da ekler; banka-kart ilerleyişi
  p = toggleCard(p, 'teb-infinite', true, CAT);
  assert.deepEqual(p.banks, ['teb']); assert.deepEqual(p.cards, ['teb-infinite']);
  assert.deepEqual(applicableDimensions(p, CAT).map(d => d.code), ['teb_tier']);
  p = setAttribute(p, 'teb_tier', 'ultra', CAT);
  p = toggleCard(p, 'qnb-ms-private', true, CAT);
  assert.deepEqual(applicableDimensions(p, CAT).map(d => d.code), ['qnb_segment', 'thy_status', 'teb_tier']);
  p = setAttribute(p, 'qnb_segment', 'private', CAT);
  p = setAttribute(p, 'thy_status', 'elite', CAT);

  // Geçersiz seçenek / uygulanamaz boyut kabul edilmez
  assert.equal(setAttribute(p, 'teb_tier', 'galaxy', CAT).attributes.teb_tier, undefined);
  assert.equal(setAttribute(p, 'wings_tier', 'black', CAT).attributes.wings_tier, undefined);
  // "Bilmiyorum" = özniteliği kaldır
  assert.equal(setAttribute(p, 'teb_tier', null, CAT).attributes.teb_tier, undefined);

  // Motor kartları: yalnız sahip olunanlar, segment etiketleri ana veriden
  const cards = profileToEngineCards(p, CAT);
  assert.deepEqual(cards.map(c => c.cardProductId).sort(), ['qnb-ms-private', 'teb-infinite']);
  assert.equal(cards.find(c => c.cardProductId === 'teb-infinite').segment, 'Ultra');
  assert.equal(cards.find(c => c.cardProductId === 'qnb-ms-private').segment, 'Private');
  const settings = profileToLegacySettings(p, CAT);
  assert.equal(settings.tebTier, 'ultra'); assert.equal(settings.thyStatus, 'elite'); assert.equal(settings.wingsTier, null);

  // Kart çıkarınca ona bağlı (bankasız) boyut da düşer; banka kalır
  const noQnbCard = toggleCard(p, 'qnb-ms-private', false, CAT);
  assert.deepEqual(noQnbCard.banks.sort(), ['qnb', 'teb']);
  assert.equal(noQnbCard.attributes.thy_status, undefined); assert.equal(noQnbCard.attributes.qnb_segment, undefined);
  // Banka çıkarınca kartları ve bankaya bağlı segmentleri düşer
  const noTeb = toggleBank(p, 'teb', false, CAT);
  assert.deepEqual(noTeb.cards, ['qnb-ms-private']); assert.equal(noTeb.attributes.teb_tier, undefined);
  assert.equal(noTeb.attributes.qnb_segment, 'private');

  // Crystal kart tipi ayrı boyut (card_type)
  let y = toggleCard(emptyProfile(), 'ykb-crystal', true, CAT);
  y = setAttribute(setAttribute(y, 'crystal_band', 'band_2', CAT), 'crystal_card_type', 'crystal_and_metal', CAT);
  const yc = profileToEngineCards(y, CAT)[0];
  assert.equal(yc.segment, 'band_2'); assert.equal(yc.segmentLabel, '1–6 milyon TL'); assert.equal(yc.cardType, 'crystal_and_metal');
  // Segment seçilmemiş kart: segment null (motor segmente özel kampanyayı kesin saymaz)
  assert.equal(profileToEngineCards(toggleCard(emptyProfile(), 'is-maximiles-black', true, CAT), CAT)[0].segment, null);

  // normalize: bilinmeyen kod, bankasız kart, geçersiz seçenek atılır
  const n = normalizeProfile({ banks: ['teb', 'nope'], cards: ['teb-infinite', 'ykb-crystal', 'mercedes'], attributes: { teb_tier: 'ultra', crystal_band: 'band_1', x: 'y' } }, CAT);
  assert.deepEqual(n.banks, ['teb']); assert.deepEqual(n.cards, ['teb-infinite']); assert.deepEqual(n.attributes, { teb_tier: 'ultra' });

  // Onboarding kuralları
  assert.equal(isProfileComplete(p), false); assert.equal(canCompleteOnboarding(p), true);
  assert.equal(canCompleteOnboarding(emptyProfile()), false);
  assert.equal(isProfileComplete({ ...p, onboardingCompletedAt: NOW.toISOString() }), true);
  assert.equal(nextOnboardingStep('banks', emptyProfile(), CAT).error, 'En az bir banka seç.');
  assert.equal(nextOnboardingStep('banks', toggleBank(emptyProfile(), 'teb', true, CAT), CAT).step, 'cards');
  assert.equal(nextOnboardingStep('cards', toggleBank(emptyProfile(), 'teb', true, CAT), CAT).error, 'En az bir kart seç.');
  assert.equal(nextOnboardingStep('cards', p, CAT).step, 'attributes');
  assert.equal(previousOnboardingStep('review', p, CAT), 'attributes');

  // Fark: satır bazlı
  const before = normalizeProfile({ banks: ['teb', 'qnb'], cards: ['teb-infinite', 'qnb-ms-private'], attributes: { teb_tier: 'plus', qnb_segment: 'private' } }, CAT);
  const after = normalizeProfile({ banks: ['teb', 'akbank'], cards: ['teb-infinite', 'akbank-wings-black'], attributes: { teb_tier: 'ultra', wings_tier: 'black' }, preferences: { staleAfterDays: 5 } }, CAT);
  const d = diffProfiles(before, after);
  assert.deepEqual(d.banksAdd, ['akbank']); assert.deepEqual(d.banksRemove, ['qnb']);
  assert.deepEqual(d.cardsAdd, ['akbank-wings-black']); assert.deepEqual(d.cardsRemove, ['qnb-ms-private']);
  assert.deepEqual(d.attrsUpsert.map(([k, v]) => [k, v]), [['teb_tier', 'ultra'], ['wings_tier', 'black']]); assert.deepEqual(d.attrsRemove, ['qnb_segment']);
  assert.equal(d.prefsChanged, true);
  assert.deepEqual(banksAffectedByAttributeChange(before, after, CAT).sort(), ['Akbank', 'QNB', 'TEB']);
  // THY statüsü (yalnız kazanım) değişimi kampanya limitlerini sıfırlatmaz
  assert.deepEqual(banksAffectedByAttributeChange(p, setAttribute(p, 'thy_status', 'classic', CAT), CAT), []);

  // Eski tek-kullanıcı verisinden ÖN-DOLDURMA (onaysız tamamlanmaz)
  const pre = legacyToProfilePrefill({ settings: { tebTier: 'ultra', wingsTier: 'black_plus', qnbSegment: 'private', thyStatus: 'classic', maximilesBand: 'band_3', crystalBand: 'band_1', crystalCardType: 'crystal' }, cards: initialCards }, CAT);
  assert.equal(pre.onboardingCompletedAt, null);
  assert.equal(pre.cards.length, 6); assert.equal(pre.attributes.teb_tier, 'ultra'); assert.equal(pre.attributes.wings_tier, 'black_plus');
  console.log('profile model tests: OK');
}

// ---------------------------------------------------------------- Hangi Kart? + profil (motor değişmeden)
{
  const restaurantCore = initialCampaigns.filter(c => c.coreBenefit);
  // Kullanıcı yalnız TEB Infinite (Ultra) sahibi
  let p = setAttribute(toggleCard(emptyProfile(), 'teb-infinite', true, CAT), 'teb_tier', 'ultra', CAT);
  const cards = profileToEngineCards(p, CAT);
  const r = recommend({ cards, campaigns: restaurantCore, states: {}, merchant: 'Da Mario', category: 'restoran', amount: 5000, now: NOW });
  assert.deepEqual(r.map(x => x.card.cardProductId), ['teb-infinite'], 'only owned cards are recommended');
  assert.ok(r[0].best, 'owned card stays eligible for calculation');
  assert.equal(r[0].best.theoreticalReward, 1000);
  // Kampanya eşleşmese de normal kazanım hesaplanır (sahip olunan kart için)
  let w = setAttribute(toggleCard(emptyProfile(), 'akbank-wings-black', true, CAT), 'wings_tier', 'black', CAT);
  const wc = profileToEngineCards(w, CAT);
  const wr = recommend({ cards: wc, campaigns: [], states: {}, merchant: 'Teknosa', category: 'elektronik', amount: 1000, now: NOW });
  assert.equal(wr.length, 1); assert.equal(wr[0].best, null);
  const base = calculateLoyalty({ card: wc[0], amount: 1000, merchant: 'Teknosa', category: 'elektronik', settings: profileToLegacySettings(w, CAT) });
  assert.equal(base.known, true); assert.equal(base.amount, 500);
  // Kampanya + normal kazanım birlikte: Wings Black restoran programı + Mil Puan
  w = profileToEngineCards(w, CAT);
  const both = recommend({ cards: w, campaigns: restaurantCore, states: { 'official-wings-program-restoran-2026': { campaignId: 'official-wings-program-restoran-2026', periodKey: '2026-10', enrollmentStatus: 'joined', remainingLimit: 1250, valueSource: 'user_confirmed', confirmedAt: NOW.toISOString() } }, merchant: 'Da Mario', category: 'restoran', amount: 4000, now: NOW });
  assert.equal(both[0].best.actualReward, 400); // %10 Black
  const loyal = calculateLoyalty({ card: w[0], amount: 4000, merchant: 'Da Mario', category: 'restoran', settings: { wingsTier: 'black' } });
  assert.equal(loyal.amount, 4000); // 100 Mil Puan / 100 TL (restoran, Black)
  // Segment seçilmemişse: segmente özel çekirdek ayrıcalık kesin sayılmaz, normal kazanım oran uydurmaz
  const unknownSeg = profileToEngineCards(toggleCard(emptyProfile(), 'akbank-wings-black', true, CAT), CAT);
  const ur = recommend({ cards: unknownSeg, campaigns: restaurantCore, states: {}, merchant: 'Da Mario', category: 'restoran', amount: 4000, now: NOW });
  assert.equal(ur[0].best, null);
  assert.ok(ur[0].rejected.some(e => e.inspection.reasons.some(x => /segment seçilmemiş/.test(x))));
  const ul = calculateLoyalty({ card: unknownSeg[0], amount: 4000, merchant: 'x', category: 'restoran', settings: profileToLegacySettings(toggleCard(emptyProfile(), 'akbank-wings-black', true, CAT), CAT) });
  assert.equal(ul.known, false); assert.equal(ul.sourceStatus, 'profile_incomplete');
  console.log('profile → Hangi Kart? tests: OK');
}

// ---------------------------------------------------------------- Supabase profil deposu (sahte fetch)
{
  const ids = { teb: 'b-teb', qnb: 'b-qnb', 'teb-infinite': 'c-teb', 'qnb-ms-private': 'c-qnb' };
  const master = {
    banks: [{ id: 'b-teb', code: 'teb', name: 'TEB', sort_order: 40, active: true }, { id: 'b-qnb', code: 'qnb', name: 'QNB', sort_order: 30, active: true }],
    card_products: [{ id: 'c-teb', code: 'teb-infinite', name: 'TEB Özel Infinite', family: 'teb-infinite', sort_order: 10, active: true, bank_id: 'b-teb' },
      { id: 'c-qnb', code: 'qnb-ms-private', name: 'Miles&Smiles QNB Private', family: 'x', sort_order: 10, active: true, bank_id: 'b-qnb' }],
    profile_dimensions: [{ code: 'teb_tier', label: 'TEB', kind: 'segment', bank_id: 'b-teb', engine_binding: 'card_segment', setting_key: 'tebTier', sort_order: 50, active: true }],
    profile_dimension_cards: [{ dimension_code: 'teb_tier', card_product_id: 'c-teb' }],
    profile_dimension_options: [{ dimension_code: 'teb_tier', code: 'ultra', label: 'Ultra', engine_label: 'Ultra', sort_order: 40, active: true }],
  };
  const calls = [];
  let userRows = { profiles: [], user_banks: [], user_cards: [], user_profile_attributes: [], user_preferences: [] };
  const fakeFetch = async (url, opts) => {
    calls.push({ url, method: opts.method, headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : undefined });
    const table = url.split('/rest/v1/')[1].split('?')[0];
    const body = opts.method === 'GET' ? (master[table] || userRows[table] || []) : null;
    return { ok: true, status: opts.method === 'GET' ? 200 : 201, text: async () => body ? JSON.stringify(body) : '' };
  };
  const store = createProfileStore({ fetchImpl: fakeFetch, baseUrl: 'https://x.supabase.co/', apiKey: 'sb_publishable_test', getAccessToken: async () => 'jwt-A' });
  const m = await store.loadMaster();
  assert.equal(m.catalog.source, 'supabase');
  assert.deepEqual(m.catalog.dimensions[0].cardCodes, ['teb-infinite']);
  assert.equal(m.ids.cardId.get('teb-infinite'), 'c-teb'); assert.equal(m.ids.bankCode.get('b-qnb'), 'qnb');
  for (const c of calls) { assert.equal(c.headers.Authorization, 'Bearer jwt-A'); assert.equal(c.headers.apikey, 'sb_publishable_test'); }

  // Profil satırı yok → null (onboarding)
  calls.length = 0;
  assert.equal(await store.loadProfile('user-A', m), null);
  for (const c of calls) assert.match(c.url, /user_id=eq\.user-A/, 'client only queries its own user_id');

  userRows = { profiles: [{ user_id: 'user-A', display_name: null, onboarding_completed_at: '2026-10-04T10:00:00Z' }], user_banks: [{ bank_id: 'b-teb' }],
    user_cards: [{ card_product_id: 'c-teb', active: true }], user_profile_attributes: [{ dimension_code: 'teb_tier', option_code: 'ultra' }], user_preferences: [{ preferences: { staleAfterDays: 4 } }] };
  const prof = await store.loadProfile('user-A', m);
  assert.deepEqual(prof.banks, ['teb']); assert.deepEqual(prof.cards, ['teb-infinite']); assert.deepEqual(prof.attributes, { teb_tier: 'ultra' });
  assert.equal(prof.preferences.staleAfterDays, 4); assert.equal(isProfileComplete(prof), true);

  // Kaydetme: sıra, gövde, on_conflict, silme filtreleri
  calls.length = 0;
  const before = { banks: ['teb'], cards: ['teb-infinite'], attributes: { teb_tier: 'ultra' }, preferences: {} };
  const after = { banks: ['qnb'], cards: ['qnb-ms-private'], attributes: {}, preferences: { staleAfterDays: 2 }, onboardingCompletedAt: '2026-10-05T09:00:00Z' };
  await store.saveProfile('user-A', diffProfiles(before, after), after, m);
  const seq = calls.map(c => `${c.method} ${c.url.split('/rest/v1/')[1].split('?')[0]}`);
  assert.deepEqual(seq, ['POST profiles', 'POST user_banks', 'POST user_cards', 'DELETE user_profile_attributes', 'DELETE user_cards', 'DELETE user_banks', 'POST user_preferences']);
  assert.match(calls[0].url, /on_conflict=user_id/); assert.equal(calls[0].body.onboarding_completed_at, '2026-10-05T09:00:00Z');
  assert.deepEqual(calls[1].body, [{ user_id: 'user-A', bank_id: 'b-qnb' }]);
  assert.deepEqual(calls[2].body, [{ user_id: 'user-A', card_product_id: 'c-qnb', active: true }]);
  assert.match(calls[4].url, /user_cards\?user_id=eq\.user-A&card_product_id=in\.\(c-teb\)/);
  assert.match(calls[5].url, /user_banks\?user_id=eq\.user-A&bank_id=in\.\(b-teb\)/);
  for (const c of calls.filter(c => c.body)) for (const row of [].concat(c.body)) assert.equal(row.user_id, 'user-A');

  // Şema yoksa (migration 008 uygulanmamış) özel hata → uygulama eski moda düşer, onboarding açmaz
  const missing = createProfileStore({ fetchImpl: async () => ({ ok: false, status: 404, text: async () => JSON.stringify({ code: 'PGRST205', message: "Could not find the table 'public.profiles' in the schema cache" }) }), baseUrl: 'https://x', apiKey: 'k', getAccessToken: async () => 't' });
  await assert.rejects(() => missing.loadMaster(), SchemaMissingError);
  // Oturum yoksa istek atılmaz
  const noSession = createProfileStore({ fetchImpl: async () => { throw new Error('should not be called'); }, baseUrl: 'https://x', apiKey: 'k', getAccessToken: async () => null });
  await assert.rejects(() => noSession.loadMaster(), /Oturum yok/);

  // Cihaz önbelleği kullanıcıya göre ayrılır
  const mem = new Map(); const storage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)) };
  writeProfileCache(storage, 'user-A', { profile: { cards: ['teb-infinite'] } });
  assert.equal(readProfileCache(storage, 'user-B'), null);
  assert.deepEqual(readProfileCache(storage, 'user-A').profile.cards, ['teb-infinite']);
  console.log('profile store tests: OK');
}

// ---------------------------------------------------------------- onboarding kapısı (router)
{
  const R = h => resolveRoute(h);
  const P = state => ({ mode: 'profile', state });
  for (const h of ['#/hangi-kart', '#/kampanyalar', '#/profil/info', '#/kurulum']) assert.equal(guardRoute(R(h), P('signed_out')).hash, '#/giris');
  assert.equal(guardRoute(R('#/hangi-kart'), P('needs_onboarding')).hash, '#/kurulum');
  assert.equal(guardRoute(R('#/profil/kartlar'), P('needs_onboarding')).hash, '#/kurulum');
  // Profil tamamlandıktan sonra onboarding yeniden başlamaz
  assert.equal(guardRoute(R('#/kurulum'), P('ready')).hash, DEFAULT_ROUTE);
  assert.equal(guardRoute(R('#/giris'), P('ready')).hash, DEFAULT_ROUTE);
  assert.equal(guardRoute(R('#/profil/kartlar'), P('ready')).hash, '#/profil/kartlar');
  // Yükleme/hata onboarding'e düşmez (ağ hatası profili yeniden oluşturtmaz)
  assert.equal(guardRoute(R('#/hangi-kart'), P('error')).hash, '#/durum');
  assert.equal(guardRoute(R('#/hangi-kart'), P('loading')).hash, '#/durum');
  // Eski mod (bulut yok / şema yok): hesap ekranlarına gidilmez, uygulama eskisi gibi çalışır
  assert.equal(guardRoute(R('#/giris'), { mode: 'legacy' }).hash, DEFAULT_ROUTE);
  assert.equal(guardRoute(R('#/kampanyalar'), { mode: 'legacy' }).hash, '#/kampanyalar');
  console.log('onboarding gate tests: OK');
}

// ---------------------------------------------------------------- çıkış sunucuda oturumu sonlandırır
{
  const mem = new Map();
  globalThis.localStorage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
  globalThis.window = { BKA_CONFIG: { supabaseUrl: 'https://proj.supabase.co', supabaseAnonKey: 'sb_publishable_x' } };
  const cs = await import('./cloud-sync.js');
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const jwt = `h.${Buffer.from(JSON.stringify({ sub: 'user-A', email: 'a@x', exp })).toString('base64url')}.s`;
  mem.set('bka-supabase-session-v1', JSON.stringify({ access_token: jwt, refresh_token: 'r1', expires_at: exp }));
  assert.equal((await cs.sessionInfo()).userId, 'user-A'); // oturum yeniden açılışta geri yüklenir
  const seen = [];
  const out = await cs.signOut({ fetchImpl: async (url, opts) => { seen.push({ url, opts }); return { ok: true, status: 204 }; } });
  assert.equal(out.serverRevoked, true);
  assert.equal(seen[0].url, 'https://proj.supabase.co/auth/v1/logout?scope=local');
  assert.equal(seen[0].opts.method, 'POST'); assert.equal(seen[0].opts.headers.Authorization, `Bearer ${jwt}`);
  assert.equal(mem.get('bka-supabase-session-v1'), undefined);
  assert.equal((await cs.sessionInfo()).signedIn, false);
  // Ağ hatasında da yerel oturum silinir
  mem.set('bka-supabase-session-v1', JSON.stringify({ access_token: jwt, refresh_token: 'r1', expires_at: exp }));
  const off = await cs.signOut({ fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(off.serverRevoked, false); assert.equal(mem.get('bka-supabase-session-v1'), undefined);
  // E-posta doğrulama / şifre sıfırlama dönüşü oturumu kaydeder
  const r = cs.consumeAuthRedirect(`#access_token=${jwt}&refresh_token=r2&expires_in=3600&type=recovery`);
  assert.equal(r.type, 'recovery'); assert.equal(JSON.parse(mem.get('bka-supabase-session-v1')).refresh_token, 'r2');
  assert.equal(cs.consumeAuthRedirect('#/hangi-kart'), null);
  console.log('auth session / logout tests: OK');
}
