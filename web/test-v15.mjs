// v1.5.0 regresyon: genel ana veri, kapsam modeli, rewardVariants (motor), tek uygunluk/ödül gerçeği,
// ACTUAL vs HYPOTHETICAL altyapısı, "Bankam listede yok", eski mod ana veri türetmesi.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BUNDLED_PROFILE_CATALOG as CAT, PROFILE_CATALOG_SCHEMA } from './profile-catalog.js';
import { bankCoverage, allBankCoverage, sourceFreshness, criteriaFreshness, recommendationCoverageNote, supportBadge, SUPPORT_LEVELS } from './coverage.js';
import { emptyProfile, toggleBank, toggleCard, setAttribute, profileToEngineCards, canCompleteOnboarding, nextOnboardingStep, legacyCardFields, normalizeProfile } from './profile-model.js';
import { effectiveAttributes } from './profile-criteria.js';
import { buildEligibilityContext } from './eligibility.js';
import { recommend, evaluateCampaign, resolveSegmentCampaign } from './engine.js';
import { groupCampaignsByCard } from './campaign-browser.js';
import { initialCampaigns, initialCards } from './bootstrap-data.js';
import { QNB_SEGMENTS, WINGS_TIERS, MAXIMILES_BANDS, CRYSTAL_BANDS, TEB_TIERS } from './loyalty.js';
import { evaluateOpportunity, buildHypotheticalProfile, PROFILE_MODE } from './opportunity.js';
import { normalizeBankRequestName, bankRequestPayload } from './bank-requests.js';
import { createProfileStore } from './profile-store.js';

const NOW = new Date('2026-10-05T12:00:00+03:00');
const NEW_BANKS = ['garanti', 'ziraat', 'halkbank', 'vakifbank', 'denizbank'];
const ORIGINAL_PRODUCTS = ['akbank-wings-elite', 'akbank-wings-black', 'is-maximiles-black', 'qnb-ms-private', 'teb-infinite', 'ykb-crystal'];
const staticCatalog = JSON.parse(readFileSync(new URL('./data/catalog.json', import.meta.url), 'utf8'));
const REGISTRY = staticCatalog.meta.sourceRegistry;
const snapshot = () => JSON.stringify(CAT);

// ---------------------------------------------------------------- 1) genel ana veri
{
  const before = snapshot();
  for (const code of ['akbank', 'isbank', 'qnb', 'teb', 'ykb', ...NEW_BANKS]) assert.ok(CAT.banks.some(b => b.code === code), code);
  for (const code of NEW_BANKS) assert.equal(CAT.cardProducts.filter(p => p.bankCode === code).length, 0, `${code}: no invented card products`);
  for (const code of NEW_BANKS) assert.equal(CAT.dimensions.filter(d => d.bankCode === code).length, 0, `${code}: no invented dimensions`);
  // Programlar: yalnız resmi kaynaklı; DenizBank programı yok (doğrulanmadı)
  for (const p of CAT.cardPrograms) { assert.match(p.sourceUrl, /^https:\/\//); assert.ok(CAT.banks.some(b => b.code === p.bankCode)); }
  assert.deepEqual(CAT.cardPrograms.filter(p => ['garanti', 'ziraat', 'halkbank', 'vakifbank'].includes(p.bankCode)).map(p => [p.bankCode, p.name, Boolean(p.verifiedAt)]),
    [['garanti', 'Bonus', true], ['ziraat', 'Bankkart', true], ['halkbank', 'Paraf', true], ['vakifbank', 'Vakıfkart (VakıfBank Worldcard)', true]]);
  assert.ok(!CAT.cardPrograms.some(p => p.bankCode === 'denizbank'));
  // Orijinal altı ürün aynı genel modelde (özel kod yolu yok); program kodu varsa gerçek bir programa işaret eder
  for (const code of ORIGINAL_PRODUCTS) {
    const p = CAT.cardProducts.find(x => x.code === code);
    assert.ok(p && 'programCode' in p, code);
    if (p.programCode) assert.ok(CAT.cardPrograms.some(g => g.code === p.programCode && g.bankCode === p.bankCode), code);
  }
  // Kullanıcının banka seçmesi ana veriyi değiştirmez; iki kullanıcı aynı bankayı bağımsız seçer
  let a = toggleBank(emptyProfile(), 'garanti', true, CAT);
  let b = toggleBank(emptyProfile(), 'garanti', true, CAT);
  b = toggleCard(b, 'teb-infinite', true, CAT);
  assert.deepEqual(a.banks, ['garanti']); assert.deepEqual(b.banks.sort(), ['garanti', 'teb']);
  a = toggleBank(a, 'garanti', false, CAT);
  assert.deepEqual(a.banks, []); assert.ok(b.banks.includes('garanti'), "A's change does not affect B");
  assert.equal(snapshot(), before, 'selecting/deselecting banks never mutates global master data');
  // Kartsız banka seçen kullanıcı onboarding'i tamamlayabilir; Hangi Kart?'a kart girmez
  const onlyGaranti = toggleBank(emptyProfile(), 'garanti', true, CAT);
  assert.equal(canCompleteOnboarding(onlyGaranti, CAT), true);
  assert.equal(nextOnboardingStep('cards', onlyGaranti, CAT).error, null);
  assert.equal(canCompleteOnboarding(toggleBank(emptyProfile(), 'teb', true, CAT), CAT), false, 'bank WITH products still needs a card');
  assert.deepEqual(profileToEngineCards(onlyGaranti, CAT), []);
  assert.equal(PROFILE_CATALOG_SCHEMA, 3);
  // Wings / TEB: kod kararlı, görünen ad temiz, eski motor anahtarı korunur
  const opt = (dim, code) => CAT.dimensions.find(d => d.code === dim).options.find(o => o.code === code);
  assert.deepEqual([opt('wings_tier', 'black_plus').label, opt('wings_tier', 'black_plus').engineLabel], ['Black Plus', 'Black Plus / 2 milyon TL+']);
  assert.deepEqual([opt('teb_tier', 'ultra').label, opt('teb_tier', 'ultra').engineLabel], ['Ultra', 'Ultra']);
  for (const d of CAT.dimensions) for (const o of d.options) assert.ok(!/\d\s*(milyon|M\b)|TL\+/.test(o.label), `${d.code}.${o.code} display label carries no threshold`);
  console.log('generalized master data tests: OK');
}

// ---------------------------------------------------------------- 2) eski mod: ürüne özel dal yerine ana veri türetmesi (eşdeğer)
{
  // v1.4.4'teki ürüne-özel mantığın birebir kopyası (referans)
  const selectedLabel = (items, value, fb) => { const x = items.find(i => i.value === value) || items.find(i => i.value === fb) || items[0]; return x?.cardLabel || x?.label || ''; };
  const OLD_WINGS = [{ value: 'standard', label: 'Standart / 1 milyon TL altı' }, { value: 'black', label: 'Black / 1–2 milyon TL' }, { value: 'black_plus', label: 'Black Plus / 2 milyon TL+' }];
  const old = (code, s) => {
    if (code === 'qnb-ms-private') return { segment: selectedLabel(QNB_SEGMENTS, s.qnbSegment, 'private') };
    if (code.startsWith('akbank-wings')) return { segment: selectedLabel(OLD_WINGS, s.wingsTier, 'black_plus').replace(/^Standart\s*\//, 'Classic /') };
    if (code === 'is-maximiles-black') return { segment: selectedLabel(MAXIMILES_BANDS, s.maximilesBand, 'band_3') };
    if (code === 'ykb-crystal') return { segment: selectedLabel(CRYSTAL_BANDS, s.crystalBand, 'band_1'), cardType: ['crystal', 'metal_crystal', 'crystal_and_metal'].includes(s.crystalCardType) ? s.crystalCardType : 'crystal' };
    if (code === 'teb-infinite') return { segment: selectedLabel(TEB_TIERS, s.tebTier, 'ultra') };
    return {};
  };
  const defaults = { qnbSegment: 'private', wingsTier: 'black_plus', maximilesBand: 'band_3', crystalBand: 'band_1', crystalCardType: 'crystal', tebTier: 'ultra' };
  let n = 0;
  for (const qnbSegment of [...QNB_SEGMENTS.map(x => x.value), 'bogus']) for (const wingsTier of [...WINGS_TIERS.map(x => x.value), undefined])
    for (const maximilesBand of MAXIMILES_BANDS.map(x => x.value)) for (const crystalBand of CRYSTAL_BANDS.map(x => x.value)) for (const crystalCardType of ['crystal', 'metal_crystal', 'crystal_and_metal', 'x']) for (const tebTier of TEB_TIERS.map(x => x.value)) {
      const s = { qnbSegment, wingsTier, maximilesBand, crystalBand, crystalCardType, tebTier };
      for (const code of ORIGINAL_PRODUCTS) {
        const f = legacyCardFields(code, s, CAT, defaults);
        const o = old(code, s);
        assert.equal(f.segment, o.segment, `${code} ${JSON.stringify(s)}`);
        if (code === 'ykb-crystal') assert.equal(f.cardType, o.cardType);
        n += 1;
      }
    }
  const appSrc = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  assert.ok(!/cardProductId === '(qnb-ms-private|teb-infinite|ykb-crystal|is-maximiles-black|akbank-wings)/.test(appSrc), 'no product-specific branches in app.js');
  console.log(`legacy-mode master-data derivation tests: OK (${n} combinations equal to v1.4.4)`);
}

// ---------------------------------------------------------------- 3) kapsam modeli
{
  assert.deepEqual([...SUPPORT_LEVELS], ['full', 'partial', 'profile_only', 'coming', 'unsupported']);
  const cov = Object.fromEntries(allBankCoverage(CAT, { registry: REGISTRY, now: NOW }).map(c => [c.bankCode, c]));
  for (const code of ['akbank', 'isbank', 'qnb', 'teb', 'ykb']) { assert.equal(cov[code].level, 'partial', code); assert.notEqual(cov[code].level, 'full'); }
  for (const code of ['garanti', 'ziraat', 'halkbank', 'vakifbank']) {
    assert.equal(cov[code].level, 'coming', code);
    assert.equal(cov[code].facets.campaignCrawler, 'none'); assert.equal(cov[code].facets.campaigns, 'coming'); assert.equal(cov[code].facets.cardProducts, 'none');
  }
  assert.equal(cov.denizbank.level, 'unsupported'); assert.equal(cov.denizbank.facets.campaignSources, 'none');
  // Etkin tarayıcısı olmayan banka asla tam/kısmi kampanya kapsamı gösteremez (beyan ne derse desin)
  const lying = { ...CAT, bankCoverage: CAT.bankCoverage.map(c => (c.bankCode === 'garanti' ? { ...c, campaigns: 'full', cardProducts: 'full' } : c)),
    cardProducts: [...CAT.cardProducts, { code: 'garanti-test', bankCode: 'garanti', name: 'T', sortOrder: 1, programCode: 'bonus-garanti' }] };
  const g = bankCoverage('garanti', lying, { registry: REGISTRY, now: NOW });
  assert.equal(g.facets.campaigns, 'coming'); assert.notEqual(g.level, 'full'); assert.equal(g.level, 'profile_only');
  // Kayıt (registry) yüklenmemişse: en fazla kısmi
  assert.equal(bankCoverage('akbank', { ...CAT, bankCoverage: CAT.bankCoverage.map(c => (c.bankCode === 'akbank' ? { ...c, campaigns: 'full' } : c)) }, { registry: null }).facets.campaigns, 'partial');
  // Tam düzey yalnız tüm fasetler tam + kaynak güncel iken
  const fullCat = { ...CAT, bankCoverage: CAT.bankCoverage.map(c => (c.bankCode === 'teb' ? { ...c, cardProducts: 'full', profileDimensions: 'full', coreBenefits: 'full', campaigns: 'full' } : c)) };
  const fresh = REGISTRY.map(r => (r.bankCode === 'teb' ? { ...r, lastSuccessAt: '2026-10-05T05:00:00Z', health: 'ok' } : r));
  assert.equal(bankCoverage('teb', fullCat, { registry: fresh, now: NOW }).level, 'full');
  const staleReg = REGISTRY.map(r => (r.bankCode === 'teb' ? { ...r, lastSuccessAt: '2026-09-20T05:00:00Z', health: 'ok' } : r));
  const st = bankCoverage('teb', fullCat, { registry: staleReg, now: NOW });
  assert.equal(st.freshness, 'stale'); assert.equal(st.level, 'partial', 'stale source → not full');
  // Kaynak tazeliği
  const src = { enabled: true, adapter: 'generic_html_v1' };
  assert.equal(sourceFreshness({ ...src, lastSuccessAt: '2026-10-05T05:00:00Z', health: 'ok' }, NOW), 'verified');
  assert.equal(sourceFreshness({ ...src, lastSuccessAt: '2026-10-04T05:00:00Z', health: 'repaired_from_lkg' }, NOW), 'last_known');
  assert.equal(sourceFreshness({ ...src, lastSuccessAt: '2026-09-01T05:00:00Z', health: 'ok' }, NOW), 'stale');
  assert.equal(sourceFreshness({ ...src, lastSuccessAt: null }, NOW), 'unverified');
  assert.equal(sourceFreshness({ enabled: false, adapter: null, lastSuccessAt: '2026-10-05T05:00:00Z' }, NOW), 'unverified');
  assert.equal(criteriaFreshness({ verifiedAt: '2026-10-03T00:00:00Z' }, NOW), 'verified');
  assert.equal(criteriaFreshness({ verifiedAt: '2025-01-01T00:00:00Z' }, NOW), 'stale');
  assert.equal(criteriaFreshness({ verifiedAt: null }, NOW), 'unverified');
  // Kullanıcıya dönük mesaj: kısmi destek normal akışta sessiz; kartsız/kampanyasız banka için tek satır
  assert.equal(recommendationCoverageNote(['teb', 'akbank'], CAT, { registry: REGISTRY, now: NOW }), null);
  assert.match(recommendationCoverageNote(['teb', 'garanti'], CAT, { registry: REGISTRY, now: NOW }), /Garanti BBVA için kart ve kampanya desteği henüz hazır değil/);
  assert.equal(supportBadge('full'), null); assert.equal(supportBadge('coming'), 'Kampanyalar yakında');
  console.log('coverage model tests: OK');
}

// ---------------------------------------------------------------- 4) rewardVariants motorda (tek ödül gerçeği)
const qnbTerminal = {
  id: 'live-qnb-terminal', bank: 'QNB', title: 'QNB Terminal Kadıköy', sourceUrl: 'https://www.qnbcard.com.tr/kampanyalar/qnb-terminal', sourceKind: 'official_web',
  cardProductIds: ['qnb-ms-private'], eligibility: { segmentLabels: ['Private'] }, categories: ['restoran'], status: 'active',
  merchantScope: { kind: 'contains', category: 'restoran', values: ['Espressolab'], requiresBranchConfirmation: false },
  rewardRule: { kind: 'percent', rate: 0.20, minSpend: 0, perTransactionCap: 1000 }, periodCap: 2000, resetPolicy: 'monthly', rulesComplete: true,
  startDate: '2026-07-01', endDate: '2026-12-31', transactionRules: {}, decisionWarnings: [],
  eligibilitySchemaVersion: 1, eligibilityRule: { payWith: { banks: ['qnb'] } },
  rewardVariants: [
    { when: { attr: { dim: 'qnb_segment', in: ['private'] } }, rewardRule: { kind: 'percent', rate: 0.20, minSpend: 0, perTransactionCap: 1000 }, periodCap: 2000, rulesComplete: true },
    { when: { attr: { dim: 'qnb_segment', in: ['first_plus'] } }, rewardRule: { kind: 'percent', rate: 0.15, minSpend: 0, perTransactionCap: 1000 }, periodCap: 2000, rulesComplete: true },
    { when: { always: true }, rewardRule: { kind: 'percent', rate: 0.10, minSpend: 0, perTransactionCap: 1000 }, periodCap: 2000, rulesComplete: true },
  ],
};
const qnbProfile = (seg) => { let p = toggleCard(emptyProfile(), 'qnb-ms-private', true, CAT); if (seg) p = setAttribute(p, 'qnb_segment', seg, CAT, { now: NOW }); return p; };
const ctxFor = p => { const cards = profileToEngineCards(p, CAT, { now: NOW }); return { cards, ctx: buildEligibilityContext({ cards, banks: p.banks, attributes: effectiveAttributes(p, CAT, NOW), catalog: CAT }) }; };
{
  const expectRate = { private: 0.20, first_plus: 0.15, first: 0.10, other: 0.10, '': 0.10 };
  for (const [seg, rate] of Object.entries(expectRate)) {
    const { cards, ctx } = ctxFor(qnbProfile(seg || null));
    const e = evaluateCampaign({ campaign: qnbTerminal, state: undefined, card: cards[0], merchant: 'Espressolab', category: 'restoran', amount: 3000, now: NOW, eligibilityContext: ctx });
    assert.equal(e.eligible, true, seg); assert.equal(e.theoreticalReward, 3000 * rate, `${seg} actual`);
    assert.deepEqual((e.conditionalRewards || []).map(x => x.rewardRule.rate), seg === '' ? [0.20, 0.15] : [], `${seg} conditional`);
    // Kampanyalar ekranı aynı çözümlemeyi kullanır
    const grouped = groupCampaignsByCard({ campaigns: [qnbTerminal], cards, category: 'all', now: NOW, eligibilityContext: ctx, resolveCampaign: (raw, card, now, c) => resolveSegmentCampaign(raw, card, now, c) });
    assert.equal(grouped[0].campaigns[0].rewardRule.rate, rate, `${seg} browser parity`);
  }
  // Bilinmeyen segment gerçek tutarı ŞİŞİRMEZ: sıralamada %10
  const { cards, ctx } = ctxFor(qnbProfile(null));
  const rec = recommend({ cards, campaigns: [qnbTerminal], states: {}, merchant: 'Espressolab', category: 'restoran', amount: 3000, now: NOW, eligibilityContext: ctx });
  assert.equal(rec[0].best.theoreticalReward, 300);
  // always yoksa + bilinmiyor → tutar yok (bilgi amaçlı), base rewardRule örtük yedek DEĞİL
  const noFloor = { ...qnbTerminal, id: 'nf', rewardVariants: qnbTerminal.rewardVariants.slice(0, 2) };
  const nf = evaluateCampaign({ campaign: noFloor, state: undefined, card: cards[0], merchant: 'Espressolab', category: 'restoran', amount: 3000, now: NOW, eligibilityContext: ctx });
  assert.equal(nf.eligible, false); assert.equal(nf.informational, true); assert.equal(nf.theoreticalReward, undefined);
  assert.equal(resolveSegmentCampaign(noFloor, cards[0], NOW, ctx).rewardVariantUnresolved, true);
  // false atlanır: First → private/first_plus false, always true
  const first = ctxFor(qnbProfile('first'));
  assert.equal(resolveSegmentCampaign(qnbTerminal, first.cards[0], NOW, first.ctx).activeRewardVariant, 2);
  // Kart dışı: TEB kartıyla ödeme → uygun değil (uygunluk ve kademe ayrı)
  const teb = ctxFor(setAttribute(toggleCard(emptyProfile(), 'teb-infinite', true, CAT), 'teb_tier', 'ultra', CAT));
  assert.equal(evaluateCampaign({ campaign: qnbTerminal, state: undefined, card: teb.cards[0], merchant: 'Espressolab', category: 'restoran', amount: 3000, now: NOW, eligibilityContext: teb.ctx }).eligible, false);
  // Geçersiz (sürümsüz) varyantlı kayıt varyantları yorumlamaz ve kapalı başarısız olur
  const bad = { ...qnbTerminal, id: 'bad', eligibilitySchemaVersion: undefined };
  delete bad.eligibilitySchemaVersion;
  assert.equal(evaluateCampaign({ campaign: bad, state: undefined, card: cards[0], merchant: 'Espressolab', category: 'restoran', amount: 3000, now: NOW, eligibilityContext: ctx }).eligible, false);
  console.log('rewardVariants engine integration tests: OK');
}

// ---------------------------------------------------------------- 5) Hangi Kart?: YALNIZ gerçek profil + sahip olunan kartlar
{
  let p = setAttribute(toggleCard(emptyProfile(), 'teb-infinite', true, CAT), 'teb_tier', 'ultra', CAT, { now: NOW });
  p = toggleBank(p, 'garanti', true, CAT); // yeni banka seçildi ama kartı yok
  const cards = profileToEngineCards(p, CAT, { now: NOW });
  assert.deepEqual(cards.map(c => c.cardProductId), ['teb-infinite']);
  const ctx = buildEligibilityContext({ cards, banks: p.banks, attributes: effectiveAttributes(p, CAT, NOW), catalog: CAT });
  const rec = recommend({ cards, campaigns: [...initialCampaigns, qnbTerminal], states: {}, merchant: 'Espressolab', category: 'restoran', amount: 5000, now: NOW, eligibilityContext: ctx });
  assert.deepEqual(rec.map(r => r.card.cardProductId), ['teb-infinite'], 'unowned cards (QNB, new-bank products) never enter the ranking');
  assert.ok(!rec.some(r => r.all.some(e => e.campaign.id === 'live-qnb-terminal')));
  assert.equal(ctx.mode, 'actual');
  console.log('Hangi Kart? actual-profile-only tests: OK');
}

// ---------------------------------------------------------------- 6) HYPOTHETICAL altyapısı
{
  const actual = setAttribute(toggleCard(emptyProfile(), 'teb-infinite', true, CAT), 'teb_tier', 'ultra', CAT, { now: NOW });
  const snap = JSON.stringify(actual);
  const campaigns = [...initialCampaigns, qnbTerminal];
  const args = { merchant: 'Espressolab', category: 'restoran', amount: 3000, now: NOW };
  const actualCtx = ctxFor(actual);
  const before = JSON.stringify(recommend({ cards: actualCtx.cards, campaigns, states: {}, ...args, eligibilityContext: actualCtx.ctx }).map(r => [r.card.cardProductId, r.best?.campaign.id, r.best?.theoreticalReward]));
  const res = evaluateOpportunity({ actualProfile: actual, overlay: { addCards: ['qnb-ms-private'], attributes: { qnb_segment: 'private' } }, catalog: CAT, campaigns, ...args });
  assert.equal(res.mode, PROFILE_MODE.HYPOTHETICAL); assert.equal(res.qualificationClaimed, false);
  assert.equal(res.hypothetical.cardProductId, 'qnb-ms-private'); assert.equal(res.hypothetical.campaignId, 'live-qnb-terminal');
  assert.equal(res.potentialReward, 600); assert.equal(res.delta, 600 - (res.actual?.reward || 0));
  assert.deepEqual(res.missingRequirements, [{ type: 'bank', bankCode: 'qnb' }, { type: 'card', cardProductId: 'qnb-ms-private' }, { type: 'attribute', dim: 'qnb_segment', option: 'private', actual: null }]);
  // Gerçek profil ve gerçek Hangi Kart? DEĞİŞMEDİ
  assert.equal(JSON.stringify(actual), snap);
  const after = JSON.stringify(recommend({ cards: actualCtx.cards, campaigns, states: {}, ...args, eligibilityContext: actualCtx.ctx }).map(r => [r.card.cardProductId, r.best?.campaign.id, r.best?.theoreticalReward]));
  assert.equal(after, before);
  // Yalnız öznitelik değişimi (kart eklemeden): QNB sahibi, segment bilinmiyor → First Plus olsaydı %15
  const qnbOnly = qnbProfile(null);
  const r2 = evaluateOpportunity({ actualProfile: qnbOnly, overlay: { attributes: { qnb_segment: 'first_plus' } }, catalog: CAT, campaigns: [qnbTerminal], ...args });
  assert.equal(r2.actual.reward, 300); assert.equal(r2.potentialReward, 450); assert.equal(r2.delta, 150);
  assert.deepEqual(r2.missingRequirements, [{ type: 'attribute', dim: 'qnb_segment', option: 'first_plus', actual: null }]);
  const hp = buildHypotheticalProfile(qnbOnly, { attributes: { qnb_segment: 'private' } }, CAT, NOW);
  assert.equal(hp.attributeConfirmations.qnb_segment.hypothetical, true); assert.equal(hp.attributeConfirmations.qnb_segment.confirmedAt, null);
  assert.equal(qnbOnly.attributes.qnb_segment, undefined, 'input profile untouched');
  // Uygulama kodu varsayımsal modu normal akışta kullanmaz
  const appSrc = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  assert.ok(!/evaluateOpportunity|buildHypotheticalProfile|withHypotheticalOverlay/.test(appSrc));
  console.log('hypothetical profile infrastructure tests: OK');
}

// ---------------------------------------------------------------- 7) "Bankam listede yok"
{
  assert.equal(normalizeBankRequestName('ING Bank'), 'ing');
  assert.equal(normalizeBankRequestName('  İNG   bankası '), 'ing');
  assert.equal(normalizeBankRequestName('Kuveyt Türk Katılım Bankası A.Ş.'), 'kuveyt-turk-katilim');
  assert.equal(normalizeBankRequestName('x'), null); assert.equal(normalizeBankRequestName(''), null);
  assert.deepEqual(bankRequestPayload('u1', ' ING '), { user_id: 'u1', requested_name: 'ING' }, 'only the name; key/ownership decided by the server');
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 201, text: async () => '' }; };
  const store = createProfileStore({ fetchImpl, baseUrl: 'https://x.supabase.co', apiKey: 'k', getAccessToken: async () => 't' });
  const before = snapshot();
  await store.requestBankSupport('u1', 'ING Bank');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/rest\/v1\/bank_support_requests\?on_conflict=user_id,normalized_key$/);
  assert.equal(calls[0].init.method, 'POST'); assert.match(calls[0].init.headers.Prefer, /ignore-duplicates/);
  assert.ok(!/banks|card_products|card_programs/.test(calls[0].url.split('/rest/v1/')[1].split('?')[0].replace('bank_support_requests', '')), 'never writes canonical tables');
  assert.equal(snapshot(), before);
  console.log('bank support request tests: OK');
}

// ---------------------------------------------------------------- 8) profil deposu: migration 011 öncesi veritabanı (expand/contract)
{
  const rows = {
    banks: CAT.banks.slice(0, 5).map(b => ({ id: `b-${b.code}`, code: b.code, name: b.name, sort_order: b.sortOrder, active: true })),
    card_products: CAT.cardProducts.map(p => ({ id: `c-${p.code}`, code: p.code, name: p.name, family: p.family, sort_order: p.sortOrder, active: true, bank_id: `b-${p.bankCode}` })),
    profile_dimensions: [], profile_dimension_cards: [], profile_dimension_options: [], profile_option_criteria: [],
  };
  const fetchImpl = async (url) => {
    const path = url.split('/rest/v1/')[1]; const table = path.split('?')[0];
    if (table === 'card_programs' || table === 'bank_coverage') return { ok: false, status: 404, text: async () => JSON.stringify({ code: 'PGRST205', message: `Could not find the table 'public.${table}'` }) };
    if (table === 'card_products' && path.includes('program_code')) return { ok: false, status: 400, text: async () => JSON.stringify({ code: '42703', message: 'column card_products.program_code does not exist' }) };
    return { ok: true, status: 200, text: async () => JSON.stringify(rows[table] || []) };
  };
  const store = createProfileStore({ fetchImpl, baseUrl: 'https://x.supabase.co', apiKey: 'k', getAccessToken: async () => 't' });
  const m = await store.loadMaster();
  assert.equal(m.catalog.schema, 2, 'pre-011 server catalog');
  assert.deepEqual(m.catalog.banks.map(b => b.code), ['akbank', 'isbank', 'qnb', 'teb', 'ykb'], 'new banks appear only once the server has them');
  assert.ok(m.catalog.cardPrograms.every(p => ['akbank', 'isbank', 'qnb', 'teb', 'ykb'].includes(p.bankCode)), 'bundled programs filtered to server banks');
  assert.equal(m.catalog.cardProducts.find(p => p.code === 'akbank-wings-black').programCode, 'wings');
  assert.equal(m.catalog.bankCoverage.length, 5);
  console.log('profile store pre-011 fallback tests: OK');
}

// ---------------------------------------------------------------- 9) bootstrap kartları + statik katalog hâlâ çalışıyor
{
  assert.equal(initialCards.length, 6);
  const v1 = staticCatalog.campaigns.filter(c => c.eligibilityRule);
  assert.ok(v1.length >= 4 && v1.every(c => c.eligibilitySchemaVersion === 1 && c.cardProductIds), 'static snapshot carries dual-written v1 fields next to legacy');
  assert.ok(staticCatalog.campaigns.every(c => Array.isArray(c.cardProductIds)), 'legacy fields preserved');
  console.log('dual-write snapshot tests: OK');
}
