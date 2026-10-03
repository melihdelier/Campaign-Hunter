// v1.4.3 regresyon: nötr seçenek kimliği, tarihli/kaynaklı ölçütler, onay sürümü ve yeniden onay,
// Maximiles/Crystal ödül sonuçlarının yeniden adlandırma öncesiyle eşdeğerliği.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNDLED_PROFILE_CATALOG as CAT, PROFILE_OPTION_CRITERIA, PROFILE_CATALOG_SCHEMA } from './profile-catalog.js';
import { currentCriteriaVersion, currentCriteria, optionDisplayLabel, attributeConfirmationStatus, effectiveAttributes,
  attributesNeedingAttention, validateOptionCriteria, REQUIRES_RECONFIRMATION } from './profile-criteria.js';
import { emptyProfile, toggleCard, setAttribute, confirmAttribute, confirmPendingAttributes, normalizeProfile, profileToEngineCards,
  profileToLegacySettings, diffProfiles, legacyToProfilePrefill } from './profile-model.js';
import { normalizeLegacySettings, normalizeLegacyCampaignSegments, LEGACY_OPTION_CODE_ALIASES } from './legacy-option-aliases.js';
import { buildEligibilityContext, evaluateCampaignForCard } from './eligibility.js';
import { evaluateCampaign, resolveSegmentCampaign, applyCombinedCustomerCaps } from './engine.js';
import { calculateLoyalty, MAXIMILES_BANDS, CRYSTAL_BANDS } from './loyalty.js';
import { initialCampaigns } from './bootstrap-data.js';
import { mergeCatalogWithCore } from './catalog-state.js';
import { createProfileStore } from './profile-store.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OCT5 = new Date('2026-10-05T12:00:00+03:00');
const BANDS = ['band_1', 'band_2', 'band_3', 'band_4'];

// Ölçüt sürümü v2: banka 2027'den itibaren eşikleri değiştirdi (seçenek kodları AYNI).
function catalogWithV2(dim = 'maximiles_band') {
  const v1 = CAT.optionCriteria.map(r => (r.dimensionCode === dim ? { ...r, effectiveTo: '2027-01-01' } : r));
  const v2 = CAT.optionCriteria.filter(r => r.dimensionCode === dim).map(r => ({
    ...r, criteriaVersion: 'v2', effectiveFrom: '2027-01-01', effectiveTo: null,
    lowerBound: r.lowerBound == null ? null : r.lowerBound * 2, upperBound: r.upperBound == null ? null : r.upperBound * 2,
    displayLabel: `${r.displayLabel} (2027)`, verifiedAt: '2027-01-02T00:00:00Z',
  }));
  return { ...CAT, optionCriteria: [...v1, ...v2] };
}

// ---------------------------------------------------------------- 1) kanonik kodlarda sayısal eşik kimliği yok
{
  for (const d of CAT.dimensions) for (const o of d.options) {
    assert.match(o.code, /^(?:[a-z_]+|band_\d+)$/, `${d.code}.${o.code}: option code must not embed a numeric threshold`);
  }
  // Varlık bantlarında motor anahtarı da nötr koddur (Wings/TEB'in eski engineLabel'ları ayrı takip edilir: docs §6).
  for (const dim of ['maximiles_band', 'crystal_band']) {
    const d = CAT.dimensions.find(x => x.code === dim);
    assert.deepEqual(d.options.map(o => o.code), BANDS);
    assert.deepEqual(d.options.map(o => o.engineLabel), BANDS);
    assert.ok(d.options.every(o => !/milyon|TL|\d{2,}/.test(o.label)), `${dim}: option label is neutral; thresholds live in criteria`);
  }
  // Boyuta özel: aynı kod iki programda aynı tutar aralığı DEĞİL
  assert.equal(currentCriteria(CAT, 'maximiles_band', 'band_2', OCT5).upperBound, 4000000);
  assert.equal(currentCriteria(CAT, 'crystal_band', 'band_2', OCT5).upperBound, 6000000);
  assert.deepEqual(validateOptionCriteria(CAT), []);
  // Her ölçüt satırı gerekli alanları taşır
  for (const r of PROFILE_OPTION_CRITERIA) {
    for (const k of ['dimensionCode', 'optionCode', 'criteriaVersion', 'effectiveFrom', 'displayLabel', 'boundUnit', 'sourceUrl', 'sourceReference']) assert.ok(r[k], `${r.optionCode}.${k}`);
    assert.ok('effectiveTo' in r && 'lowerBound' in r && 'upperBound' in r && 'verifiedAt' in r);
    assert.match(r.sourceUrl, /^https:\/\//);
  }
  assert.ok(PROFILE_OPTION_CRITERIA.filter(r => r.dimensionCode === 'maximiles_band').every(r => r.verifiedAt));
  // Crystal v1: resmi Crystal Card sayfası, doğrulama zamanı dolu, kaynak ifadesi yayımlanan bant ölçütüyle aynı
  const crystalRows = PROFILE_OPTION_CRITERIA.filter(r => r.dimensionCode === 'crystal_band');
  assert.ok(crystalRows.every(r => r.verifiedAt && /^https:\/\/www\.crystalcard\.com\.tr\//.test(r.sourceUrl)), 'Crystal criteria must cite the official Crystal Card page and be verified');
  const wording = Object.fromEntries(crystalRows.map(r => [r.optionCode, r.sourceReference]));
  assert.match(wording.band_1, /1 milyon TL'nin altında/); assert.match(wording.band_1, /1\.500 TL.*3\.000 TL/);
  assert.match(wording.band_2, /1 milyon TL - 6 milyon TL arasında/); assert.match(wording.band_2, /2\.500 TL.*5\.000 TL/);
  assert.match(wording.band_3, /6 milyon TL - 10 milyon TL arasında/); assert.match(wording.band_3, /3\.000 TL.*7\.500 TL/);
  assert.match(wording.band_4, /10 milyon TL ve üzerinde/); assert.match(wording.band_4, /4\.000 TL.*10\.000 TL/);
  // Kaynakta yayımlanan işlem/aylık limitler, uygulamanın Crystal %20 kampanya kurallarıyla aynı
  const crystalCampaign = initialCampaigns.find(c => c.id === 'official-ykb-crystal-restoran-2026-09');
  const limits = { band_1: [1500, 3000], band_2: [2500, 5000], band_3: [3000, 7500], band_4: [4000, 10000] };
  for (const [b, [tx, month]] of Object.entries(limits)) {
    assert.equal(crystalCampaign.segmentRules[b].rewardRule.perTransactionCap, tx, `${b} tx cap`);
    assert.equal(crystalCampaign.segmentRules[b].periodCap, month, `${b} monthly cap`);
  }
  // KAYNAK doğrulaması (global) ≠ KULLANICI onayı: kullanıcı onayı verifiedAt'i değiştirmez, verifiedAt da onay yerine geçmez
  const unverified = { ...CAT, optionCriteria: CAT.optionCriteria.map(r => (r.dimensionCode === 'crystal_band' ? { ...r, verifiedAt: null } : r)) };
  const py = setAttribute(toggleCard(emptyProfile(), 'ykb-crystal', true, unverified), 'crystal_band', 'band_2', unverified, { now: OCT5 });
  assert.equal(attributeConfirmationStatus(py, unverified, 'crystal_band', OCT5).status, 'confirmed', 'user confirmation is independent of source verification');
  assert.equal(currentCriteria(unverified, 'crystal_band', 'band_2', OCT5).verifiedAt, null, 'confirming does not mark the source as verified');
  const noConf = normalizeProfile({ banks: ['ykb'], cards: ['ykb-crystal'], attributes: { crystal_band: 'band_2' } }, CAT);
  assert.equal(attributeConfirmationStatus(noConf, CAT, 'crystal_band', OCT5).status, 'unconfirmed', 'a verified source does not confirm the user’s choice');
  // Etiketler ölçütten gelir
  assert.equal(optionDisplayLabel(CAT, 'maximiles_band', 'band_3', OCT5), '4–8 milyon TL arası');
  assert.equal(MAXIMILES_BANDS[2].label, '4–8 milyon TL arası'); assert.equal(CRYSTAL_BANDS[3].label, '10 milyon TL ve üzeri');
  // Profil modelinde tutar alanı yok
  assert.deepEqual(Object.keys(emptyProfile()).sort(), ['attributeConfirmations', 'attributes', 'banks', 'cards', 'displayName', 'onboardingCompletedAt', 'preferences']);
  console.log('neutral option identity tests: OK');
}

// ---------------------------------------------------------------- 2) tarihli ölçüt değişir, kod değişmez
{
  const C2 = catalogWithV2();
  assert.deepEqual(validateOptionCriteria(C2), []);
  assert.deepEqual(C2.dimensions.find(d => d.code === 'maximiles_band').options.map(o => o.code), BANDS);
  assert.equal(currentCriteriaVersion(C2, 'maximiles_band', new Date('2026-12-31T20:59:00Z')), 'v1');   // 23:59 İstanbul
  assert.equal(currentCriteriaVersion(C2, 'maximiles_band', new Date('2026-12-31T21:30:00Z')), 'v2');   // 00:30 İstanbul, 1 Ocak
  assert.equal(currentCriteria(C2, 'maximiles_band', 'band_2', '2027-02-01').upperBound, 8000000);
  assert.equal(currentCriteria(C2, 'maximiles_band', 'band_2', '2026-11-01').upperBound, 4000000);
  assert.equal(optionDisplayLabel(C2, 'maximiles_band', 'band_2', '2027-02-01'), '1–4 milyon TL arası (2027)');
  // Crystal etkilenmez (boyuta özel sürüm)
  assert.equal(currentCriteriaVersion(C2, 'crystal_band', '2027-02-01'), 'v1');
  // Çakışan sürümler tespit edilir ve hiçbiri "güncel" sayılmaz
  const overlap = { ...C2, optionCriteria: C2.optionCriteria.map(r => (r.criteriaVersion === 'v1' && r.dimensionCode === 'maximiles_band' ? { ...r, effectiveTo: null } : r)) };
  assert.ok(validateOptionCriteria(overlap).some(e => /overlap/.test(e)));
  assert.equal(currentCriteriaVersion(overlap, 'maximiles_band', '2027-02-01'), null);
  console.log('dated criteria versioning tests: OK');
}

// ---------------------------------------------------------------- 3+4) ölçüt değişimi onayı sessizce değiştirmez; eski onay tespit edilir
{
  const C2 = catalogWithV2();
  let p = toggleCard(emptyProfile(), 'is-maximiles-black', true, C2);
  p = setAttribute(p, 'maximiles_band', 'band_2', C2, { now: new Date('2026-10-10T10:00:00+03:00') });
  assert.deepEqual(p.attributeConfirmations.maximiles_band, { criteriaVersion: 'v1', confirmedAt: '2026-10-10T07:00:00.000Z' });
  const snapshot = JSON.stringify(p);
  const DEC = '2026-12-15'; const FEB = '2027-02-01';
  assert.equal(attributeConfirmationStatus(p, C2, 'maximiles_band', DEC).status, 'confirmed');
  const st = attributeConfirmationStatus(p, C2, 'maximiles_band', FEB);
  assert.equal(st.status, 'stale'); assert.equal(st.confirmedVersion, 'v1'); assert.equal(st.currentVersion, 'v2');
  assert.ok(REQUIRES_RECONFIRMATION.has(st.status));
  // Kalıcı profil değişmedi; seçim korunuyor (tek tıkla yeniden onay için)
  assert.equal(JSON.stringify(p), snapshot); assert.equal(p.attributes.maximiles_band, 'band_2');
  assert.deepEqual(attributesNeedingAttention(p, C2, FEB).map(x => [x.dim, x.status]), [['maximiles_band', 'stale']]);
  // Karar motorunda "bilinmiyor": kart segmenti yok, kazanım hesaplanmaz, segment kuralı belirsiz
  assert.deepEqual(effectiveAttributes(p, C2, FEB), {});
  const [cardFeb] = profileToEngineCards(p, C2, { now: FEB });
  assert.equal(cardFeb.segment, null); assert.deepEqual(cardFeb.profileAttributes, {});
  const [cardDec] = profileToEngineCards(p, C2, { now: DEC });
  assert.equal(cardDec.segment, 'band_2');
  const settingsFeb = profileToLegacySettings(p, C2, { now: FEB });
  assert.equal(settingsFeb.maximilesBand, null);
  assert.equal(calculateLoyalty({ card: cardFeb, amount: 1000, merchant: 'X', category: 'restoran', locationScope: 'domestic', settings: settingsFeb }).known, false);
  const bandRule = { eligibilitySchemaVersion: 1, eligibilityRule: { all: [{ payWith: { cards: ['is-maximiles-black'] } }, { attr: { dim: 'maximiles_band', in: ['band_2'] } }] } };
  assert.equal(evaluateCampaignForCard(bandRule, cardFeb, buildEligibilityContext({ cards: [cardFeb], attributes: effectiveAttributes(p, C2, FEB), catalog: C2 })).value, null);
  assert.equal(evaluateCampaignForCard(bandRule, cardDec, buildEligibilityContext({ cards: [cardDec], attributes: effectiveAttributes(p, C2, DEC), catalog: C2 })).eligible, true);
  // Onboarding'deki toplu onay eski (stale) onayı sessizce yenilemez
  assert.equal(confirmPendingAttributes(p, C2, { now: FEB }).attributeConfirmations.maximiles_band.criteriaVersion, 'v1');
  // Açık yeniden onay → güncel sürüm; sunucuya yazılacak fark onay bilgisini taşır
  const re = confirmAttribute(p, 'maximiles_band', C2, { now: new Date('2027-02-01T09:00:00+03:00') });
  assert.equal(re.attributes.maximiles_band, 'band_2');
  assert.deepEqual(re.attributeConfirmations.maximiles_band, { criteriaVersion: 'v2', confirmedAt: '2027-02-01T06:00:00.000Z' });
  assert.equal(attributeConfirmationStatus(re, C2, 'maximiles_band', FEB).status, 'confirmed');
  assert.deepEqual(diffProfiles(p, re).attrsUpsert, [['maximiles_band', 'band_2', { criteriaVersion: 'v2', confirmedAt: '2027-02-01T06:00:00.000Z' }]]);
  // Onay bilgisi olmayan seçim (ör. eski istemciden) → onaylanmamış, kullanılmaz
  const unconf = normalizeProfile({ banks: ['isbank'], cards: ['is-maximiles-black'], attributes: { maximiles_band: 'band_4' } }, CAT);
  assert.equal(attributeConfirmationStatus(unconf, CAT, 'maximiles_band', OCT5).status, 'unconfirmed');
  assert.deepEqual(effectiveAttributes(unconf, CAT, OCT5), {});
  assert.equal(confirmPendingAttributes(unconf, CAT, { now: OCT5 }).attributeConfirmations.maximiles_band.criteriaVersion, 'v1');
  // Ölçüt kaydı olmayan boyut (teb_tier) sürümsüzdür; davranış değişmedi
  const t = setAttribute(toggleCard(emptyProfile(), 'teb-infinite', true, CAT), 'teb_tier', 'ultra', CAT);
  assert.equal(attributeConfirmationStatus(t, CAT, 'teb_tier', OCT5).status, 'not_versioned');
  assert.equal(profileToEngineCards(t, CAT)[0].segment, 'Ultra');
  // Yürürlükte ölçüt yoksa (ör. sürüm kapatıldı, yenisi yok) seçim kullanılmaz ve onaylanamaz
  const ended = { ...CAT, optionCriteria: CAT.optionCriteria.map(r => (r.dimensionCode === 'crystal_band' ? { ...r, effectiveTo: '2026-11-01' } : r)) };
  let y = setAttribute(toggleCard(emptyProfile(), 'ykb-crystal', true, ended), 'crystal_band', 'band_3', ended, { now: OCT5 });
  assert.equal(attributeConfirmationStatus(y, ended, 'crystal_band', '2026-12-01').status, 'criteria_unavailable');
  assert.deepEqual(effectiveAttributes(y, ended, '2026-12-01'), {});
  assert.equal(confirmAttribute(y, 'crystal_band', ended, { now: '2026-12-01' }).attributeConfirmations.crystal_band.criteriaVersion, 'v1');
  console.log('confirmation staleness / reconfirmation tests: OK');
}

// ---------------------------------------------------------------- 5) ödül sonuçları yeniden adlandırma öncesiyle eşdeğer
{
  const base = JSON.parse(readFileSync(new URL('./fixtures/band-rename-equivalence.v1.json', import.meta.url), 'utf8'));
  assert.ok(base.campaigns.length > 600 && base.loyalty.length === 48);
  const byId = new Map(initialCampaigns.map(c => [c.id, c]));
  for (const row of base.campaigns) {
    const c = byId.get(row.campaignId);
    const card = { id: 'x', bank: c.bank, name: 'x', cardProductId: row.product, active: true, segment: row.band, ...(row.cardType ? { cardType: row.cardType } : {}) };
    const now = new Date(row.date);
    const e = evaluateCampaign({ campaign: c, state: undefined, card, merchant: 'Test Restoran', category: row.category, amount: row.amount, now });
    const r = applyCombinedCustomerCaps(resolveSegmentCampaign(c, card, now), card);
    const got = { eligible: e.eligible, potential: !!e.potential, theoreticalReward: e.theoreticalReward ?? null, periodCap: r.periodCap ?? null,
      rate: r.rewardRule?.rate ?? null, perTransactionCap: r.rewardRule?.perTransactionCap ?? null, minSpend: r.rewardRule?.minSpend ?? null,
      activeCombinedCaps: (r.activeCombinedCaps || []).map(x => x.id) };
    const exp = { eligible: row.eligible, potential: row.potential, theoreticalReward: row.theoreticalReward, periodCap: row.periodCap, rate: row.rate,
      perTransactionCap: row.perTransactionCap, minSpend: row.minSpend, activeCombinedCaps: row.activeCombinedCaps };
    assert.deepEqual(got, exp, `${row.campaignId} ${row.band} ${row.cardType} ${row.date} ${row.amount}`);
  }
  for (const row of base.loyalty) {
    const l = calculateLoyalty({ card: { cardProductId: row.product, bank: 'İş Bankası' }, amount: row.amount, merchant: 'X', category: row.category, locationScope: 'domestic', settings: { maximilesBand: row.band } });
    assert.deepEqual([l.known, l.amount, l.detail], [row.known, row.amountEarned, row.detail], `${row.band} ${row.category} ${row.amount}`);
  }
  // Profil yolu: band seçimi → aynı kart segmenti anahtarı → aynı sonuç
  for (const band of BANDS) {
    const p = setAttribute(toggleCard(emptyProfile(), 'is-maximiles-black', true, CAT), 'maximiles_band', band, CAT, { now: OCT5 });
    assert.equal(profileToEngineCards(p, CAT, { now: OCT5 })[0].segment, band);
  }
  console.log(`reward equivalence tests: OK (${base.campaigns.length} campaign + ${base.loyalty.length} loyalty scenarios vs v1.4.2)`);
}

// ---------------------------------------------------------------- 6) eski veri girişleri (cihaz ayarları, profil önbelleği, eski katalog)
{
  const OLD = Object.fromEntries(Object.entries(LEGACY_OPTION_CODE_ALIASES).map(([d, m]) => [d, Object.keys(m)]));
  // cihazdaki eski ayarlar
  const s = normalizeLegacySettings({ maximilesBand: OLD.maximiles_band[2], crystalBand: OLD.crystal_band[0], tebTier: 'ultra' });
  assert.deepEqual(s, { maximilesBand: 'band_3', crystalBand: 'band_1', tebTier: 'ultra' });
  const pre = legacyToProfilePrefill({ settings: { maximilesBand: OLD.maximiles_band[1] }, cards: [{ cardProductId: 'is-maximiles-black', active: true }] }, CAT);
  assert.equal(pre.attributes.maximiles_band, 'band_2');
  // v1.4.x profil önbelleği: eski kod → nötr kod, v1 altında onaylı (eşikler aynıydı), onay zamanı bilinmiyor
  const cached = normalizeProfile({ banks: ['ykb'], cards: ['ykb-crystal'], attributes: { crystal_band: OLD.crystal_band[3] } }, CAT);
  assert.equal(cached.attributes.crystal_band, 'band_4');
  assert.deepEqual(cached.attributeConfirmations.crystal_band, { criteriaVersion: 'v1', confirmedAt: null });
  assert.equal(attributeConfirmationStatus(cached, CAT, 'crystal_band', OCT5).status, 'confirmed');
  // ama sonraki ölçüt sürümünde o da yeniden onay ister
  assert.equal(attributeConfirmationStatus(cached, catalogWithV2('crystal_band'), 'crystal_band', '2027-02-01').status, 'stale');
  // yayında kalmış eski katalog kaydı (eşik etiketli anahtarlar) → aynı sonuç
  const oldLabels = ['1 milyon TL altı', '1–6 milyon TL', '6–10 milyon TL', '10 milyon TL+'];
  const crystal = initialCampaigns.find(c => c.id === 'official-ykb-crystal-restoran-2026-09');
  const oldStyle = { ...crystal, eligibility: { ...crystal.eligibility, segmentLabels: oldLabels }, segmentRules: Object.fromEntries(BANDS.map((b, i) => [oldLabels[i], crystal.segmentRules[b]])) };
  const norm = normalizeLegacyCampaignSegments(oldStyle);
  assert.deepEqual(norm.eligibility.segmentLabels, BANDS); assert.deepEqual(norm.segmentRules, crystal.segmentRules);
  assert.equal(normalizeLegacyCampaignSegments(crystal), crystal, 'already-neutral records are untouched');
  const merged = mergeCatalogWithCore([oldStyle], { coreBenefits: [], existingCampaigns: [], now: OCT5 });
  assert.deepEqual(Object.keys(merged.find(c => c.id === crystal.id).segmentRules), BANDS);
  // Wings (adlandırılmış kademe) etiketleri dokunulmaz
  const wings = initialCampaigns.find(c => (c.cardProductIds || []).includes('akbank-wings-black') && c.segmentRules);
  if (wings) assert.equal(normalizeLegacyCampaignSegments(wings), wings);
  console.log('legacy input normalization tests: OK');
}

// ---------------------------------------------------------------- 7) profil deposu: ölçüt + onay okunur/yazılır
{
  const calls = [];
  const rows = {
    banks: [{ id: 'b1', code: 'isbank', name: 'İş Bankası', sort_order: 20 }],
    card_products: [{ id: 'c1', code: 'is-maximiles-black', name: 'Maximiles Black', family: 'maximiles', sort_order: 10, bank_id: 'b1' }],
    profile_dimensions: [{ code: 'maximiles_band', label: 'Maximiles Black varlık bandı', kind: 'asset_band', bank_id: 'b1', engine_binding: 'card_segment', setting_key: 'maximilesBand', sort_order: 30 }],
    profile_dimension_cards: [{ dimension_code: 'maximiles_band', card_product_id: 'c1' }],
    profile_dimension_options: BANDS.map((b, i) => ({ dimension_code: 'maximiles_band', code: b, label: `${i + 1}. bant`, engine_label: b, sort_order: (i + 1) * 10 })),
    profile_option_criteria: CAT.optionCriteria.filter(r => r.dimensionCode === 'maximiles_band').map(r => ({ dimension_code: r.dimensionCode, option_code: r.optionCode, criteria_version: r.criteriaVersion,
      effective_from: r.effectiveFrom, effective_to: r.effectiveTo, display_label: r.displayLabel, lower_bound: r.lowerBound == null ? null : String(r.lowerBound), upper_bound: r.upperBound == null ? null : String(r.upperBound),
      bound_unit: r.boundUnit, source_url: r.sourceUrl, source_reference: r.sourceReference, verified_at: r.verifiedAt })),
    profiles: [{ user_id: 'u', display_name: null, onboarding_completed_at: '2026-10-01T00:00:00Z', profile_version: 1 }],
    user_banks: [{ bank_id: 'b1' }], user_cards: [{ card_product_id: 'c1', active: true }],
    user_profile_attributes: [{ dimension_code: 'maximiles_band', option_code: 'band_2', criteria_version: 'v1', confirmed_at: '2026-10-02T09:00:00Z' }],
    user_preferences: [],
  };
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const table = url.split('/rest/v1/')[1].split('?')[0];
    return { ok: true, status: 200, text: async () => (init?.method && init.method !== 'GET' ? '' : JSON.stringify(rows[table] || [])) };
  };
  const store = createProfileStore({ fetchImpl, baseUrl: 'https://x.supabase.co', apiKey: 'k', getAccessToken: async () => 't' });
  const master = await store.loadMaster();
  assert.equal(master.catalog.schema, PROFILE_CATALOG_SCHEMA);
  assert.equal(master.catalog.optionCriteria.length, 4);
  assert.equal(master.catalog.optionCriteria[1].upperBound, 4000000);
  const prof = await store.loadProfile('u', master);
  assert.deepEqual(prof.attributeConfirmations, { maximiles_band: { criteriaVersion: 'v1', confirmedAt: '2026-10-02T09:00:00Z' } });
  const np = normalizeProfile(prof, master.catalog);
  assert.equal(attributeConfirmationStatus(np, master.catalog, 'maximiles_band', OCT5).status, 'confirmed');
  const next = setAttribute(np, 'maximiles_band', 'band_3', master.catalog, { now: OCT5 });
  await store.saveProfile('u', diffProfiles(np, next), next, master);
  const post = calls.find(c => c.url.includes('user_profile_attributes?on_conflict'));
  assert.deepEqual(JSON.parse(post.init.body), [{ user_id: 'u', dimension_code: 'maximiles_band', option_code: 'band_3', criteria_version: 'v1', confirmed_at: OCT5.toISOString() }]);
  assert.ok(!/amount|asset|balance|tutar/i.test(post.init.body));
  console.log('profile store criteria/confirmation tests: OK');
}

// ---------------------------------------------------------------- 8) eski eşik kodlu kimlikler başka yerde kalmadı
{
  const OLD_CODE = /\b(under_1m|1m_4m|4m_8m|8m_plus|1m_6m|6m_10m|10m_plus)\b/;
  // İzin verilen yerler: tek giriş dönüşüm modülü, sunucu dönüşüm migration'ı, değiştirilemez migration GEÇMİŞİ (004/005, 010 ile
  // dönüştürülür) ve onu içeren tek seferlik kurulum betiği, eski veriyi taklit eden testler, tarihsel denetim belgeleri.
  const ALLOW = new Set(['web/legacy-option-aliases.js', 'supabase/migrations/004_reward_profile.sql', 'supabase/migrations/005_all_segment_profiles.sql',
    'supabase/migrations/010_option_criteria.sql', 'supabase/BKA_Supabase_Kurulum_Tek_Sorgu.sql', 'web/e2e/account-smoke.mjs',
    'server/tests/test_supabase_rls.py', 'server/tests/test_band_rename.py', 'web/test-option-criteria.mjs',
    'docs/AUDIT_v1.2.2_MULTIUSER.md']);
  const hits = [];
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      if (['node_modules', '.git', '__pycache__', 'data'].includes(name) && dir.endsWith('server')) continue;
      if (['node_modules', '.git', '__pycache__'].includes(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.(js|mjs|py|sql|json|html|md|yml)$/.test(name)) continue;
      const rel = relative(ROOT, p).split('\\').join('/');
      if (OLD_CODE.test(readFileSync(p, 'utf8')) && !ALLOW.has(rel)) hits.push(rel);
    }
  };
  for (const d of ['web', 'server', 'supabase', 'docs', '.github']) { try { walk(join(ROOT, d)); } catch {} }
  assert.deepEqual(hits, [], `threshold-coded option IDs remain in: ${hits.join(', ')}`);
  // Ödül kuralları (paketli + crawler çıktısı + statik katalog) nötr bant anahtarlı
  const keyed = c => [...(c.eligibility?.segmentLabels || []), ...Object.keys(c.segmentRules || {})];
  for (const c of initialCampaigns.filter(c => (c.cardProductIds || []).some(p => p === 'is-maximiles-black' || p === 'ykb-crystal'))) {
    for (const k of keyed(c)) assert.match(k, /^band_\d$/, `${c.id}: ${k}`);
    for (const v of Object.values(c.segmentRules || {})) for (const vv of v.validityPeriods || []) for (const k of Object.keys(vv.segmentRules || {})) assert.match(k, /^band_\d$/);
  }
  console.log('no residual threshold-coded identity: OK');
}
