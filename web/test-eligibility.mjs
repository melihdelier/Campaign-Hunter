// v1.4.1 regresyon: ortak uygunluk değerlendiricisi, çok boyutlu profil öznitelikleri, eski katalog uyumluluğu.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateRule, evaluateCampaignForCard, campaignTargetsCard, buildEligibilityContext, attributesFromLegacySettings,
  legacyEligibilityRule, campaignEligibilityRule, mapLegacyLabelsToAttr, validateEligibilityRule, ELIGIBILITY_SCHEMA_VERSION,
  validateCampaignEligibility, resolveCampaignEligibility, selectRewardVariant, resolveCampaignReward, withHypotheticalOverlay,
  SUPPORTED_ELIGIBILITY_SCHEMA_VERSIONS } from './eligibility.js';
import { BUNDLED_PROFILE_CATALOG as CAT } from './profile-catalog.js';
import { emptyProfile, toggleCard, setAttribute, profileToEngineCards, profileToLegacySettings, applicableDimensions } from './profile-model.js';
import { recommend, inspectCampaign, evaluateCampaign, resolveSegmentCampaign } from './engine.js';
import { groupCampaignsByCard, campaignAppliesToCard } from './campaign-browser.js';
import { initialCampaigns, initialCards } from './bootstrap-data.js';

const NOW = new Date('2026-10-05T12:00:00+03:00');
const card = code => ({ cardProductId: code, active: true, bankCode: CAT.cardProducts.find(c => c.code === code)?.bankCode });

// ---------------------------------------------------------------- 1) kural dili (üç değerli mantık, kodlar)
{
  assert.equal(ELIGIBILITY_SCHEMA_VERSION, 1);
  const ctx = buildEligibilityContext({ cards: ['teb-infinite', 'qnb-ms-private'], attributes: { teb_tier: 'ultra' }, catalog: CAT });
  const ev = (rule, c = card('teb-infinite')) => evaluateRule(rule, ctx, c).value;
  assert.equal(ev({ payWith: { cards: ['teb-infinite'] } }), true);
  assert.equal(ev({ payWith: { cards: ['teb-infinite'] } }, card('qnb-ms-private')), false);
  assert.equal(ev({ payWith: { banks: ['teb'] } }), true);
  assert.equal(ev({ payWith: { banks: ['qnb'] } }), false);
  assert.equal(ev({ owns: { cards: ['qnb-ms-private'] } }), true);       // müşteri düzeyi: başka kartına sahip
  assert.equal(ev({ owns: { cards: ['ykb-crystal'] } }), false);
  assert.equal(ev({ owns: { banks: ['teb'] } }), true);
  assert.equal(ev({ attr: { dim: 'teb_tier', in: ['ultra'] } }), true);
  assert.equal(ev({ attr: { dim: 'teb_tier', in: ['plus', 'premium'] } }), false);
  assert.equal(ev({ attr: { dim: 'qnb_segment', in: ['private'] } }), null); // seçilmemiş → bilinmiyor
  // VE / VEYA / DEĞİL (Kleene)
  assert.equal(ev({ all: [{ payWith: { cards: ['teb-infinite'] } }, { attr: { dim: 'teb_tier', in: ['ultra'] } }] }), true);
  assert.equal(ev({ all: [{ payWith: { cards: ['teb-infinite'] } }, { attr: { dim: 'qnb_segment', in: ['private'] } }] }), null);
  assert.equal(ev({ all: [{ payWith: { cards: ['ykb-crystal'] } }, { attr: { dim: 'qnb_segment', in: ['private'] } }] }), false);
  assert.equal(ev({ any: [{ payWith: { cards: ['ykb-crystal'] } }, { payWith: { cards: ['teb-infinite'] } }] }), true);
  assert.equal(ev({ any: [{ payWith: { cards: ['ykb-crystal'] } }, { attr: { dim: 'qnb_segment', in: ['private'] } }] }), null);
  assert.equal(ev({ not: { payWith: { cards: ['teb-infinite'] } } }), false);
  assert.equal(ev({ not: { attr: { dim: 'qnb_segment', in: ['private'] } } }), null);
  assert.equal(ev({ all: [{ payWith: { banks: ['teb'] } }, { not: { attr: { dim: 'teb_tier', in: ['standard'] } } }] }), true);
  assert.equal(ev({ always: true }), true);
  // Bilinmeyen/bozuk düğüm asla uygun sayılmaz
  assert.equal(ev({ foo: 1 }), false); assert.equal(ev({ payWith: {}, attr: {} }), false);
  // Uygun = yalnız true; bilinmiyor gerekçesiyle döner
  const unknown = evaluateCampaignForCard({ eligibilitySchemaVersion: 1, eligibilityRule: { all: [{ payWith: { cards: ['teb-infinite'] } }, { attr: { dim: 'qnb_segment', in: ['private'] } }] } }, card('teb-infinite'), ctx);
  assert.equal(unknown.eligible, false); assert.equal(unknown.value, null); assert.equal(unknown.reasons[0].dim, 'qnb_segment');

  // Doğrulama: kararlı kodlar; Türkçe görünen etiket kabul edilmez
  assert.deepEqual(validateEligibilityRule({ all: [{ payWith: { cards: ['teb-infinite'] } }, { attr: { dim: 'teb_tier', in: ['ultra'] } }] }, { catalog: CAT }), []);
  assert.ok(validateEligibilityRule({ attr: { dim: 'teb_tier', in: ['Ultra / 10 milyon TL+'] } }, { catalog: CAT }).length > 0);
  assert.ok(validateEligibilityRule({ attr: { dim: 'teb_tier', in: ['galaxy'] } }, { catalog: CAT }).some(e => /unknown option/.test(e)));
  assert.ok(validateEligibilityRule({ payWith: { cards: ['mercedes-card'] } }, { catalog: CAT }).some(e => /unknown card product/.test(e)));
  assert.ok(validateEligibilityRule({ all: [] }).length > 0);
  assert.ok(validateEligibilityRule({ payWith: { cards: ['x'] }, owns: { cards: ['y'] } }).length > 0);
  console.log('eligibility rule language tests: OK');
}

// ---------------------------------------------------------------- 2) aynı karta iki farklı boyut — biri görünmez olmaz
{
  // Sentetik: TEB Infinite'e ikinci (yalnız uygunluk) boyutu. Gerçek ana veri DEĞİŞMEDİ.
  const EXT = { ...CAT, dimensions: [...CAT.dimensions, {
    code: 'teb_relationship', label: 'TEB ilişki tipi', kind: 'segment', bankCode: 'teb', cardCodes: ['teb-infinite'],
    engineBinding: 'eligibility_only', settingKey: null, sortOrder: 55,
    options: [{ code: 'ozel', label: 'TEB Özel', engineLabel: null, sortOrder: 10 }, { code: 'bireysel', label: 'Bireysel', engineLabel: null, sortOrder: 20 }],
  }] };
  let p = toggleCard(emptyProfile(), 'teb-infinite', true, EXT);
  assert.deepEqual(applicableDimensions(p, EXT).map(d => d.code), ['teb_tier', 'teb_relationship']); // onboarding ikisini de sorar
  p = setAttribute(setAttribute(p, 'teb_tier', 'ultra', EXT), 'teb_relationship', 'ozel', EXT);
  const [c] = profileToEngineCards(p, EXT);
  assert.equal(c.segment, 'Ultra', 'card.segment is NOT a concatenation and ignores eligibility_only');
  assert.ok(!/ozel|Özel|\|/.test(c.segment));
  assert.deepEqual(c.profileAttributes, { teb_tier: 'ultra', teb_relationship: 'ozel' }, 'both dimensions visible on the card');
  assert.equal('teb_relationship' in profileToLegacySettings(p, EXT), false, 'eligibility-only dims do not leak into earning settings');

  const ctx = buildEligibilityContext({ cards: profileToEngineCards(p, EXT), attributes: p.attributes, catalog: EXT });
  const ultraOzel = { id: 'x', eligibilitySchemaVersion: 1, eligibilityRule: { all: [{ payWith: { cards: ['teb-infinite'] } }, { attr: { dim: 'teb_tier', in: ['ultra'] } }, { attr: { dim: 'teb_relationship', in: ['ozel'] } }] } };
  assert.equal(evaluateCampaignForCard(ultraOzel, c, ctx).eligible, true);
  // ikinci boyut farklı → uygun değil, gerekçe ikinci boyutu gösterir (birinci boyut tarafından gizlenmez)
  const p2 = setAttribute(p, 'teb_relationship', 'bireysel', EXT);
  const r2 = evaluateCampaignForCard(ultraOzel, c, buildEligibilityContext({ cards: [c], attributes: p2.attributes, catalog: EXT }));
  assert.equal(r2.eligible, false); assert.deepEqual(r2.reasons.map(r => r.dim), ['teb_relationship']);
  // ikinci boyut seçilmemiş → bilinmiyor (uygun değil); birinci boyut yine doğru değerlendirilir
  const p3 = setAttribute(p, 'teb_relationship', null, EXT);
  const r3 = evaluateCampaignForCard(ultraOzel, c, buildEligibilityContext({ cards: [c], attributes: p3.attributes, catalog: EXT }));
  assert.equal(r3.value, null); assert.deepEqual(r3.reasons.map(r => r.dim), ['teb_relationship']);
  const tierOnly = { eligibilitySchemaVersion: 1, eligibilityRule: { all: [{ payWith: { cards: ['teb-infinite'] } }, { attr: { dim: 'teb_tier', in: ['ultra'] } }] } };
  assert.equal(evaluateCampaignForCard(tierOnly, c, buildEligibilityContext({ cards: [c], attributes: p3.attributes, catalog: EXT })).eligible, true);

  // Gerçek ana veri: Crystal'da iki boyut (varlık bandı + kart tipi) birlikte görünür ve birlikte değerlendirilir
  let y = toggleCard(emptyProfile(), 'ykb-crystal', true, CAT);
  y = setAttribute(setAttribute(y, 'crystal_band', 'band_4', CAT), 'crystal_card_type', 'crystal_and_metal', CAT);
  const [yc] = profileToEngineCards(y, CAT);
  assert.deepEqual(yc.profileAttributes, { crystal_band: 'band_4', crystal_card_type: 'crystal_and_metal' });
  const yctx = buildEligibilityContext({ cards: [yc], attributes: y.attributes, catalog: CAT });
  const metalTop = { eligibilitySchemaVersion: 1, eligibilityRule: { all: [{ payWith: { cards: ['ykb-crystal'] } }, { attr: { dim: 'crystal_band', in: ['band_4'] } }, { attr: { dim: 'crystal_card_type', in: ['metal_crystal', 'crystal_and_metal'] } }] } };
  assert.equal(evaluateCampaignForCard(metalTop, yc, yctx).eligible, true);
  const yPlain = setAttribute(y, 'crystal_card_type', 'crystal', CAT);
  assert.equal(evaluateCampaignForCard(metalTop, yc, buildEligibilityContext({ cards: [yc], attributes: yPlain.attributes, catalog: CAT })).eligible, false);

  // Hangi Kart? ve Kampanyalar aynı sonucu verir (ortak değerlendirici)
  const camp = { ...ultraOzel, id: 'ultra-ozel', title: 'TEB Ultra Özel', bank: 'TEB', categories: ['restoran'], merchantScope: { kind: 'all' }, status: 'active',
    startDate: '2026-10-01', endDate: '2026-10-31', resetPolicy: 'campaign', rewardRule: { kind: 'percent', rate: 0.1, minSpend: 0 }, rulesComplete: true, transactionRules: {} };
  for (const attrs of [p.attributes, p2.attributes, p3.attributes]) {
    const cc = buildEligibilityContext({ cards: [c], attributes: attrs, catalog: EXT });
    const rec = recommend({ cards: [c], campaigns: [camp], states: {}, merchant: 'x', category: 'restoran', amount: 1000, now: NOW, eligibilityContext: cc });
    const engineOk = Boolean(rec[0].all.find(e => e.campaign.id === 'ultra-ozel'));
    const browserOk = groupCampaignsByCard({ campaigns: [camp], cards: [c], category: 'restoran', now: NOW, eligibilityContext: cc })[0].campaigns.length === 1;
    assert.equal(engineOk, browserOk, JSON.stringify(attrs));
  }
  console.log('multi-dimension profile attribute tests: OK');
}

// ---------------------------------------------------------------- 3) eski katalog kayıtlarıyla birebir uyumluluk
// v1.4.0 öncesi mantık (referans kopya): kart ürünü listede + segment etiketi eşleşmesi
const norm = v => String(v ?? '').trim().toLocaleLowerCase('tr-TR');
function oldEngineEligible(campaign, c) {
  if (!campaign.cardProductIds?.includes(c.cardProductId)) return false;
  const allowed = campaign.eligibility?.segmentLabels;
  if (!Array.isArray(allowed) || !allowed.length) return true;
  return allowed.some(s => norm(s) === norm(c.segment));
}
{
  const legacyCampaigns = [
    ...initialCampaigns,
    { id: 'l1', cardProductIds: ['teb-infinite'], eligibility: { segmentLabels: ['Ultra'] } },
    { id: 'l2', cardProductIds: ['akbank-wings-elite', 'akbank-wings-black'] },
    { id: 'l3', cardProductIds: ['qnb-ms-private'], eligibility: { segmentLabels: ['Private', 'QNB First Plus'] } },
    { id: 'l4', cardProductIds: ['ykb-crystal'], eligibility: { segmentLabels: ['Etiket eşlenemez'] } }, // eşlenemeyen etiket → eski karşılaştırma
    { id: 'l5', cardProductIds: [] },
    { id: 'l6' },
  ];
  let checked = 0;
  for (const product of CAT.cardProducts) {
    const segDims = CAT.dimensions.filter(d => d.engineBinding === 'card_segment' && d.cardCodes.includes(product.code));
    const options = segDims.length ? segDims[0].options.map(o => o.code) : [null];
    for (const opt of [...options, null]) {
      let p = toggleCard(emptyProfile(), product.code, true, CAT);
      if (opt && segDims.length) p = setAttribute(p, segDims[0].code, opt, CAT);
      const [c] = profileToEngineCards(p, CAT);
      const profileCtx = buildEligibilityContext({ cards: [c], attributes: p.attributes, catalog: CAT });
      const bareCtx = buildEligibilityContext({ cards: [c] }); // eski çağrı biçimi: öznitelik bilgisi yok
      for (const camp of legacyCampaigns) {
        for (const variant of [camp, resolveSegmentCampaign(camp, c, NOW)]) {
          const old = oldEngineEligible(variant, c);
          assert.equal(evaluateCampaignForCard(variant, c, profileCtx).eligible, old, `${variant.id} ${product.code} ${opt} (profile ctx)`);
          assert.equal(evaluateCampaignForCard(variant, c, bareCtx).eligible, old, `${variant.id} ${product.code} ${opt} (bare ctx)`);
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 300, `exhaustive compatibility matrix (${checked})`);

  // Eski tek-kullanıcı modu: eski ayarlardan öznitelik → aynı sonuç
  const legacySettings = { qnbSegment: 'private', wingsTier: 'black_plus', maximilesBand: 'band_3', crystalBand: 'band_1', crystalCardType: 'crystal', tebTier: 'ultra', thyStatus: 'classic' };
  const attrs = attributesFromLegacySettings(legacySettings, CAT);
  assert.deepEqual(attrs.teb_tier, 'ultra'); assert.equal(attrs.thy_status, 'classic');
  const legacyCards = initialCards.map(x => ({ ...x }));
  const lctx = buildEligibilityContext({ cards: legacyCards, attributes: attrs, catalog: CAT });
  for (const camp of initialCampaigns) for (const c of legacyCards) {
    assert.equal(evaluateCampaignForCard(camp, c, lctx).eligible, oldEngineEligible(camp, c), `${camp.id}/${c.cardProductId}`);
  }

  // Eski etiketlerin kanonik özniteliğe eşlenmesi kararlı kodlarla yapılır
  assert.deepEqual(mapLegacyLabelsToAttr(['Ultra', 'Premium'], 'teb-infinite', CAT), { dim: 'teb_tier', in: ['ultra', 'premium'] });
  assert.deepEqual(mapLegacyLabelsToAttr(['Black Plus / 2 milyon TL+'], 'akbank-wings-black', CAT), { dim: 'wings_tier', in: ['black_plus'] });
  assert.equal(mapLegacyLabelsToAttr(['Ultra'], 'qnb-ms-private', CAT), null);
  assert.deepEqual(legacyEligibilityRule({ cardProductIds: ['teb-infinite'], eligibility: { segmentLabels: ['Ultra'] } }),
    { all: [{ payWith: { cards: ['teb-infinite'] } }, { legacySegmentLabel: { in: ['Ultra'] } }] });

  // eligibilityRule varsa eski alanların önüne geçer
  const both = { cardProductIds: ['qnb-ms-private'], eligibility: { segmentLabels: ['Private'] }, eligibilitySchemaVersion: 1, eligibilityRule: { payWith: { cards: ['teb-infinite'] } } };
  assert.deepEqual(campaignEligibilityRule(both), both.eligibilityRule);
  assert.equal(evaluateCampaignForCard(both, card('teb-infinite')).eligible, true);
  assert.equal(evaluateCampaignForCard(both, card('qnb-ms-private')).eligible, false);

  // segmentRules (ödül varyantları) profil bağlamında da aynı çalışır
  const teb = initialCampaigns.find(x => x.id === 'official-teb-infinite-restoran-ultra');
  let tp = setAttribute(toggleCard(emptyProfile(), 'teb-infinite', true, CAT), 'teb_tier', 'premium', CAT);
  const [tc] = profileToEngineCards(tp, CAT);
  const te = evaluateCampaign({ campaign: teb, state: undefined, card: tc, merchant: 'x', category: 'restoran', amount: 5000, now: NOW, eligibilityContext: buildEligibilityContext({ cards: [tc], attributes: tp.attributes, catalog: CAT }) });
  assert.equal(te.eligible, true); assert.equal(te.campaign.rewardRule.rate, 0.15); assert.equal(te.theoreticalReward, 750);

  // Bilinçli birleştirme: cardProductIds boş/eksik kampanya artık İKİ ekranda da uygun değil
  // (v1.4.0'da Kampanyalar ekranı bunları tüm kartlara uygun gösteriyordu, Hangi Kart? reddediyordu).
  for (const camp of [{ id: 'e1', cardProductIds: [] }, { id: 'e2' }]) {
    assert.equal(campaignAppliesToCard(camp, card('teb-infinite')), false);
    assert.equal(campaignTargetsCard(camp, card('teb-infinite')), false);
  }
  const insp = inspectCampaign({ campaign: { cardProductIds: ['teb-infinite'], eligibility: { segmentLabels: ['Ultra'] }, status: 'active' }, card: { cardProductId: 'teb-infinite', segment: 'Plus' }, merchant: '', category: 'all', amount: 1 });
  assert.ok(insp.reasons.some(r => r === 'Kart segmenti uygun değil (Plus).'), 'legacy messages preserved');
  console.log(`legacy catalog compatibility tests: OK (${checked} combinations)`);
}

// ---------------------------------------------------------------- 4) tek değerlendirici: ayrı filtre mantığı yok
{
  const browserSrc = readFileSync(new URL('./campaign-browser.js', import.meta.url), 'utf8');
  const engineSrc = readFileSync(new URL('./engine.js', import.meta.url), 'utf8');
  assert.match(browserSrc, /from '\.\/eligibility\.js'/); assert.match(engineSrc, /from '\.\/eligibility\.js'/);
  assert.ok(!/segmentLabels/.test(browserSrc), 'campaign browser has no own segment filter');
  const inspectBody = engineSrc.slice(engineSrc.indexOf('export function inspectCampaign'), engineSrc.indexOf('export function ensureReset'));
  assert.ok(!/cardProductIds\?\.includes|segmentMatches\(/.test(inspectBody), 'engine inspect has no own card/segment filter');
  const recBody = engineSrc.slice(engineSrc.indexOf('export function recommend'));
  assert.ok(!/cardProductIds\?\.includes/.test(recBody));
  console.log('shared evaluator wiring tests: OK');
}

// ---------------------------------------------------------------- 5) önerilen şema örnekleri makine tarafından doğrulanır
{
  const doc = JSON.parse(readFileSync(new URL('../docs/eligibility-examples.v1.json', import.meta.url), 'utf8'));
  assert.equal(doc.schemaVersion, ELIGIBILITY_SCHEMA_VERSION);
  for (const ex of doc.examples) {
    assert.deepEqual(validateCampaignEligibility(ex, { catalog: CAT }), { status: 'valid', errors: [], warnings: [] }, ex.id);
    assert.equal(ex.eligibilitySchemaVersion, 1, ex.id);
    for (const e of ex.expect) {
      const c = card(e.payWith);
      const ctx = buildEligibilityContext({ cards: [c], attributes: e.attributes, catalog: CAT });
      const r = evaluateCampaignForCard(ex, c, ctx);
      assert.equal(r.value, e.eligible, `${ex.id} ${e.payWith} ${JSON.stringify(e.attributes)}`);
    }
  }
  // rewardVariants: hangi varyant GERÇEK, hangileri yalnız KOŞULLU
  let rewardChecks = 0;
  for (const ex of doc.examples) for (const e of ex.rewardExpect || []) {
    const c = card(e.payWith);
    const ctx = buildEligibilityContext({ cards: [c], attributes: e.attributes, catalog: CAT });
    const r = resolveCampaignReward(ex, c, ctx);
    const label = `${ex.id} ${e.payWith} ${JSON.stringify(e.attributes)}`;
    assert.equal(r.status, e.status, label);
    assert.equal(r.actual ? r.actual.variant.rewardRule.rate : null, e.actualRate, label);
    assert.deepEqual(r.conditional.map(x => x.variant.rewardRule.rate), e.conditionalRates, label);
    rewardChecks += 1;
  }
  assert.ok(rewardChecks >= 8);
  console.log(`schema example tests: OK (${doc.examples.length} examples, ${rewardChecks} reward-variant checks)`);
}

// ---------------------------------------------------------------- 6) v1.4.2 şema sürümü zorlaması (kapalı başarısızlık)
{
  assert.deepEqual([...SUPPORTED_ELIGIBILITY_SCHEMA_VERSIONS], [1]);
  const fx = JSON.parse(readFileSync(new URL('../docs/eligibility-validation-cases.v1.json', import.meta.url), 'utf8'));
  const probe = card('teb-infinite');
  const probeCtx = buildEligibilityContext({ cards: [probe], attributes: { teb_tier: 'ultra' }, catalog: CAT });
  const full = c => ({ ...c, id: 'fx', title: 'fx', bank: 'TEB', categories: ['restoran'], merchantScope: { kind: 'all' }, status: 'active',
    startDate: '2026-10-01', endDate: '2026-10-31', resetPolicy: 'campaign', rewardRule: { kind: 'percent', rate: 0.1, minSpend: 0 }, rulesComplete: true, transactionRules: {} });
  for (const k of fx.cases) {
    const camp = k.campaign;
    const rt = validateCampaignEligibility(camp);
    const cat = validateCampaignEligibility(camp, { catalog: CAT });
    assert.equal(rt.status, k.runtimeStatus, `runtime: ${k.name}`);
    assert.equal(cat.status, k.catalogStatus, `catalog: ${k.name}`);
    if (k.errorContains) assert.ok(cat.errors.some(e => e.includes(k.errorContains)), `${k.name}: ${cat.errors}`);
    const r = evaluateCampaignForCard(camp, probe, probeCtx);
    assert.equal(r.eligible, k.eligibleForProbe, `probe: ${k.name}`);
    if (k.runtimeStatus === 'invalid') {
      // Eski alanlar (teb-infinite + Ultra) eşleşirdi; yine de uygun DEĞİL ve null değil kesin false
      assert.equal(r.value, false, k.name);
      assert.ok(['invalid_rule', 'unsupported_schema'].includes(r.reasons[0].code), k.name);
      assert.equal(campaignTargetsCard(camp, probe, probeCtx), false, k.name);
      assert.equal(campaignAppliesToCard(camp, probe, probeCtx), false, k.name);
      assert.equal(campaignEligibilityRule(camp), null, k.name);
      const rec = recommend({ cards: [probe], campaigns: [full(camp)], states: {}, merchant: 'x', category: 'restoran', amount: 1000, now: NOW, eligibilityContext: probeCtx });
      assert.ok(!rec.some(x => (x.all || []).some(e => e.campaign.id === 'fx' && e.eligible)), `recommend: ${k.name}`);
      assert.equal(groupCampaignsByCard({ campaigns: [full(camp)], cards: [probe], category: 'restoran', now: NOW, eligibilityContext: probeCtx })[0]?.campaigns.length || 0, 0, `browser: ${k.name}`);
    }
  }
  // Gerekli beş durum açıkça
  const R = { all: [{ payWith: { cards: ['teb-infinite'] } }, { attr: { dim: 'teb_tier', in: ['ultra'] } }] };
  const LEG = { cardProductIds: ['teb-infinite'], eligibility: { segmentLabels: ['Ultra'] } };
  assert.equal(evaluateCampaignForCard({ ...LEG, eligibilitySchemaVersion: 1, eligibilityRule: R }, probe, probeCtx).eligible, true);   // v1 kabul
  assert.equal(evaluateCampaignForCard({ ...LEG, eligibilityRule: R }, probe, probeCtx).eligible, false);                                 // sürüm yok
  assert.equal(evaluateCampaignForCard({ ...LEG, eligibilitySchemaVersion: 2, eligibilityRule: R }, probe, probeCtx).reasons[0].code, 'unsupported_schema');
  assert.equal(evaluateCampaignForCard({ ...LEG, eligibilitySchemaVersion: 1, eligibilityRule: { all: [] } }, probe, probeCtx).reasons[0].code, 'invalid_rule');
  assert.equal(evaluateCampaignForCard({ ...LEG }, probe, probeCtx).eligible, true);                                                      // eski adaptör
  assert.equal(resolveCampaignEligibility({ ...LEG }).status, 'legacy');
  // Gerçek paketli katalog (bootstrap) yeni şema anahtarı taşımıyor → tamamı eski adaptörden, davranış değişmedi
  assert.ok(initialCampaigns.every(c => validateCampaignEligibility(c).status === 'legacy'));
  // Guard ana veri kodları = paketli profil kataloğu (= migration 008/009 seed)
  const master = JSON.parse(readFileSync(new URL('../server/eligibility_master.v1.json', import.meta.url), 'utf8'));
  const { eligibilityMaster } = await import('../tools/gen-eligibility-master.mjs');
  assert.deepEqual(master, eligibilityMaster(CAT), 'server/eligibility_master.v1.json is generated from the bundled catalog (run node tools/gen-eligibility-master.mjs)');
  console.log(`schema version enforcement tests: OK (${fx.cases.length} shared fixture cases)`);
}

// ---------------------------------------------------------------- 7) rewardVariants üç değerli seçim
{
  const pct = rate => ({ kind: 'percent', rate });
  const QNB = [
    { when: { attr: { dim: 'qnb_segment', in: ['private'] } }, rewardRule: pct(0.20) },
    { when: { attr: { dim: 'qnb_segment', in: ['first_plus'] } }, rewardRule: pct(0.15) },
    { when: { always: true }, rewardRule: pct(0.10) },
  ];
  const q = card('qnb-ms-private');
  const sel = attrs => selectRewardVariant(QNB, buildEligibilityContext({ cards: [q], attributes: attrs, catalog: CAT }), q);
  const rate = s => s.actual?.variant.rewardRule.rate ?? null;
  const cond = s => s.conditional.map(x => x.variant.rewardRule.rate);
  assert.equal(rate(sel({ qnb_segment: 'private' })), 0.20); assert.deepEqual(cond(sel({ qnb_segment: 'private' })), []);
  assert.equal(rate(sel({ qnb_segment: 'first_plus' })), 0.15); assert.deepEqual(cond(sel({ qnb_segment: 'first_plus' })), []);
  assert.equal(rate(sel({ qnb_segment: 'first' })), 0.10); assert.equal(rate(sel({ qnb_segment: 'other' })), 0.10);
  const unk = sel({});
  assert.equal(unk.status, 'actual'); assert.equal(rate(unk), 0.10);            // bilinmiyor → garantili %10
  assert.deepEqual(cond(unk), [0.20, 0.15]);                                    // üst kademeler yalnız koşullu
  assert.ok(unk.conditional.every(x => x.reasons.some(r => r.code === 'segment' && r.dim === 'qnb_segment')));
  // always yoksa: bilinmiyor asla gerçek ödül olmaz
  const noFloor = selectRewardVariant(QNB.slice(0, 2), buildEligibilityContext({ cards: [q], attributes: {}, catalog: CAT }), q);
  assert.equal(noFloor.status, 'conditional_only'); assert.equal(noFloor.actual, null); assert.deepEqual(cond(noFloor), [0.20, 0.15]);
  const noneKnown = selectRewardVariant(QNB.slice(0, 2), buildEligibilityContext({ cards: [q], attributes: { qnb_segment: 'first' }, catalog: CAT }), q);
  assert.equal(noneKnown.status, 'none'); assert.equal(noneKnown.actual, null);
  // false atlanır; gerçekten SONRAKİ null varyantlar koşullu listeye girmez (ilk eşleşen kazanır)
  const after = selectRewardVariant([{ when: { always: true }, rewardRule: pct(0.1) }, { when: { attr: { dim: 'qnb_segment', in: ['private'] } }, rewardRule: pct(0.2) }],
    buildEligibilityContext({ cards: [q], attributes: {}, catalog: CAT }), q);
  assert.equal(rate(after), 0.1); assert.deepEqual(cond(after), []);
  // Savunmacı: when eksik/null asla koşulsuz sayılmaz
  assert.equal(selectRewardVariant([{ rewardRule: pct(0.5) }, { when: null, rewardRule: pct(0.4) }], buildEligibilityContext({}), q).actual, null);
  // Uygunluk ve kademe ayrı: QNB dışı kartla ödeme → ineligible (koşullu bilgi de yok)
  const camp = { eligibilitySchemaVersion: 1, eligibilityRule: { payWith: { banks: ['qnb'] } }, rewardVariants: QNB };
  const t = card('teb-infinite');
  const off = resolveCampaignReward(camp, t, buildEligibilityContext({ cards: [t], attributes: { qnb_segment: 'private' }, catalog: CAT }));
  assert.equal(off.status, 'ineligible'); assert.equal(off.actual, null); assert.deepEqual(off.conditional, []);
  // Geçersiz kayıt → ineligible (varyantlar yorumlanmaz)
  assert.equal(resolveCampaignReward({ eligibilityRule: { payWith: { banks: ['qnb'] } }, rewardVariants: QNB }, q, buildEligibilityContext({ cards: [q], catalog: CAT })).status, 'ineligible');
  // rewardVariants yok → legacy (mevcut motor karar verir)
  assert.equal(resolveCampaignReward({ cardProductIds: ['qnb-ms-private'] }, q, buildEligibilityContext({ cards: [q], catalog: CAT })).status, 'legacy');
  console.log('rewardVariants three-valued selection tests: OK');
}

// ---------------------------------------------------------------- 8) aynı yaprakta cards + banks = VE (VEYA için any)
{
  const t = card('teb-infinite'); const q = card('qnb-ms-private');
  const ctx = buildEligibilityContext({ cards: [t], attributes: {}, catalog: CAT });   // yalnız TEB kartına sahip
  const ev = (rule, c) => evaluateRule(rule, ctx, c).value;
  const mixed = { payWith: { cards: ['teb-infinite'], banks: ['qnb'] } };          // çelişkili: hiçbir kart iki koşulu birden sağlamaz
  assert.equal(ev(mixed, t), false); assert.equal(ev(mixed, q), false);
  assert.equal(ev({ payWith: { cards: ['qnb-ms-private'], banks: ['qnb'] } }, q), true);
  const either = { any: [{ payWith: { cards: ['teb-infinite'] } }, { payWith: { banks: ['qnb'] } }] };  // VEYA ayrı düğümlerle
  assert.equal(ev(either, t), true); assert.equal(ev(either, q), true); assert.equal(ev(either, card('ykb-crystal')), false);
  // owns: kullanıcı listedeki kartlardan birine SAHİP VE listedeki bankalardan birinin müşterisi (aynı kart olması gerekmez)
  const ownsMixed = { owns: { cards: ['teb-infinite'], banks: ['qnb'] } };
  assert.equal(ev(ownsMixed, t), false);                                            // QNB müşterisi değil
  const ctx2 = buildEligibilityContext({ cards: [t, q], attributes: {}, catalog: CAT });
  assert.equal(evaluateRule(ownsMixed, ctx2, t).value, true);
  assert.equal(evaluateRule({ any: [{ owns: { cards: ['teb-infinite'] } }, { owns: { banks: ['qnb'] } }] }, ctx, t).value, true);
  console.log('conjunctive cards+banks leaf tests: OK');
}

// ---------------------------------------------------------------- 9) GERÇEK vs VARSAYIMSAL (gelecekteki Keşfet) bağlam
{
  let profile = emptyProfile();
  profile = toggleCard(profile, 'qnb-ms-private', true, CAT);
  const snapshot = JSON.stringify(profile);
  const [qc] = profileToEngineCards(profile, CAT);
  const actual = buildEligibilityContext({ cards: [qc], banks: profile.banks, attributes: profile.attributes, catalog: CAT });
  assert.equal(actual.mode, 'actual');
  const privateOnly = { eligibilitySchemaVersion: 1, eligibilityRule: { all: [{ payWith: { banks: ['qnb'] } }, { attr: { dim: 'qnb_segment', in: ['private'] } }] } };
  assert.equal(evaluateCampaignForCard(privateOnly, qc, actual).value, null);       // gerçek: bilinmiyor → uygun değil
  const hypo = withHypotheticalOverlay(actual, { attributes: { qnb_segment: 'private' }, cards: ['teb-infinite'] });
  assert.equal(hypo.mode, 'hypothetical');
  assert.equal(evaluateCampaignForCard(privateOnly, qc, hypo).eligible, true);      // varsayımsal: uygun olurdu
  assert.ok(hypo.cards.has('teb-infinite') && hypo.banks.has('teb'));
  // Katman girdi bağlamı ve kalıcı profili DEĞİŞTİRMEZ
  assert.equal(evaluateCampaignForCard(privateOnly, qc, actual).value, null);
  assert.ok(!actual.cards.has('teb-infinite') && !actual.banks.has('teb'));
  assert.deepEqual(actual.attributes, {});
  assert.equal(JSON.stringify(profile), snapshot);
  // Normal Hangi Kart? yalnız gerçek bağlamı kurar: app.js'te varsayımsal katman kullanılmaz
  const appSrc = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  assert.ok(!/withHypotheticalOverlay/.test(appSrc), 'Hangi Kart? must use the actual context only');
  console.log('actual vs hypothetical context tests: OK');
}

// ---------------------------------------------------------------- 10) kanonik segment kimliğinde değişken eşik yok
{
  // Seçenek KODLARI kararlı kimliktir ve hiçbir boyutta sayısal eşik içermez (v1.4.3: istisna listesi kaldırıldı;
  // varlık bantları nötr sıra kodları band_N kullanır, eşikler tarihli ölçüt kayıtlarındadır — test-option-criteria.mjs).
  for (const d of CAT.dimensions) for (const o of d.options) assert.match(o.code, /^(?:[a-z_]+|band_\d+)$/, `${d.code}.${o.code} must not embed a threshold`);
  for (const [dim, codes] of Object.entries({ teb_tier: ['standard', 'plus', 'premium', 'ultra'], qnb_segment: ['other', 'first', 'first_plus', 'private'], wings_tier: ['standard', 'black', 'black_plus'], maximiles_band: ['band_1', 'band_2', 'band_3', 'band_4'], crystal_band: ['band_1', 'band_2', 'band_3', 'band_4'] }))
    assert.deepEqual(CAT.dimensions.find(d => d.code === dim).options.map(o => o.code), codes, `${dim} codes are frozen`);
  console.log('stable segment identity tests: OK');
}
