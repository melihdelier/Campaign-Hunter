// v1.2.2 regresyon testleri — 2026-10-01 kod incelemesi bulguları (#1–#7 + düşük riskli düzeltmeler).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateCampaign, recommend, ensureReset, resolveMerchantInput, resolveSegmentCampaign, freshness, applyCombinedCustomerCaps } from './engine.js';
import { initialCards, initialCampaigns, initialStates } from './bootstrap-data.js';
import { mergeCatalogWithCore, mergePrivateCampaigns, extendCoreValidity, reconcileCampaignStates, invalidateSegmentDependentStates, applyCloudRow, isLocalServerMode, observationMatchesCore } from './catalog-state.js';
import { groupCampaignsByCard } from './campaign-browser.js';
import { APP_VERSION } from './version.js';

const CORE = initialCampaigns.filter(c => c.coreBenefit);
const card = id => initialCards.find(c => c.cardProductId === id);
const OCT1 = new Date('2026-10-01T12:00:00+03:00');
const byId = id => initialCampaigns.find(c => c.id === id);

// ---------------------------------------------------------------- #1 core validity
{
  // Maximiles Black: Q4 resmi kuralları 1 Ekim'den itibaren seçilir (5.000/10.000 TL eşikleri).
  const maxi = byId('official-is-restoran-2026q3');
  const q4 = resolveSegmentCampaign(maxi, card('is-maximiles-black'), OCT1);
  assert.equal(q4.startDate, '2026-10-01'); assert.equal(q4.endDate, '2026-12-31');
  assert.equal(q4.rewardRule.tiers[0].min, 5000); assert.equal(q4.periodCap, 8000);
  const q3 = resolveSegmentCampaign(maxi, card('is-maximiles-black'), new Date('2026-09-20T12:00:00+03:00'));
  assert.equal(q3.rewardRule.tiers[0].min, 4000);
  const e = evaluateCampaign({ campaign: maxi, state: undefined, card: card('is-maximiles-black'), merchant: 'Test Restoran', category: 'restoran', amount: 12000, now: OCT1 });
  assert.equal(e.eligible, true); assert.equal(e.theoreticalReward, 2400);
  const below = evaluateCampaign({ campaign: maxi, state: undefined, card: card('is-maximiles-black'), merchant: 'Test', category: 'restoran', amount: 4500, now: OCT1 });
  assert.equal(below.potential, true); // Q4'te 4.500 TL artık eşik altı

  // Maximiles Q4 1 milyon TL altı: resmi metin net (5.000 TL+ %5, işlem 1.000 / aylık 2.000) → rulesComplete:true, uyarı yok.
  const under1m = resolveSegmentCampaign(maxi, { ...card('is-maximiles-black'), segment: '1 milyon TL altı' }, OCT1);
  assert.equal(under1m.rulesComplete, true);
  assert.equal(under1m.rewardRule.rate, 0.05); assert.equal(under1m.rewardRule.minSpend, 5000);
  assert.equal(under1m.rewardRule.perTransactionCap, 1000); assert.equal(under1m.periodCap, 2000);
  assert.ok(!under1m.decisionWarnings.some(w => /net okunamadı/.test(w)));
  const u = evaluateCampaign({ campaign: maxi, state: undefined, card: { ...card('is-maximiles-black'), segment: '1 milyon TL altı' }, merchant: 'R', category: 'restoran', amount: 30000, now: OCT1 });
  assert.equal(u.eligible, true); assert.equal(u.theoreticalReward, 1000);

  // Crystal: iki onaylı resmi kaynak çelişiyor (YKB 30.09 / Crystal 31.10). Crystal-özel kaynak yok sayılmaz.
  const crystal = byId('official-ykb-crystal-restoran-2026-09');
  const OCT3 = new Date('2026-10-03T12:00:00+03:00');
  const cr = resolveSegmentCampaign(crystal, card('ykb-crystal'), OCT3);
  assert.equal(cr.endDate, '2026-10-31');
  assert.equal(cr.officialDateConflict.chosenEndDate, '2026-10-31');
  assert.deepEqual(cr.officialDateConflict.sources.map(x => x.endDate).sort(), ['2026-09-30', '2026-10-31']);
  assert.ok(cr.decisionWarnings.some(w => /Resmi kaynaklar geçerlilik tarihinde çelişiyor/.test(w) && /30/.test(w) && /2026-10-31/.test(w)));
  const ce3 = evaluateCampaign({ campaign: crystal, state: undefined, card: card('ykb-crystal'), merchant: 'Da Mario', category: 'restoran', amount: 5000, now: OCT3 });
  assert.equal(ce3.eligible, true); assert.equal(ce3.conditional, true); assert.equal(ce3.theoreticalReward, 1000);
  assert.equal(cr.rewardRule.rate, 0.20); assert.equal(cr.periodCap, 3000); // kurallar değişmedi
  // Temkinli politika açıkça seçilirse en erken resmi tarih kullanılır.
  const cautious = resolveSegmentCampaign({ ...crystal, dateConflictPolicy: 'earliest_official' }, card('ykb-crystal'), OCT3);
  assert.equal(cautious.endDate, '2026-09-30');

  // Tüm resmi tarihler geçtikten sonra core sessizce kaybolmaz: bilgi amaçlı + uyarı (katalogda "dönem bitti").
  const NOV5 = new Date('2026-11-05T12:00:00+03:00');
  const ce = evaluateCampaign({ campaign: crystal, state: undefined, card: card('ykb-crystal'), merchant: 'Da Mario', category: 'restoran', amount: 5000, now: NOV5 });
  assert.equal(ce.informational, true); assert.equal(ce.coreExpired, true); assert.match(ce.infoNote, /2026-10-31/);
  const groups = groupCampaignsByCard({ campaigns: CORE, cards: initialCards, category: 'restoran', resolveCampaign: (r, c, n) => resolveSegmentCampaign(r, c, n), now: NOV5 });
  assert.ok(groups.find(g => g.card.cardProductId === 'ykb-crystal').campaigns.some(c => c.expiredCore === true));
  const groupsOct = groupCampaignsByCard({ campaigns: CORE, cards: initialCards, category: 'restoran', resolveCampaign: (r, c, n) => resolveSegmentCampaign(r, c, n), now: OCT3 });
  assert.ok(groupsOct.find(g => g.card.cardProductId === 'ykb-crystal').campaigns.some(c => !c.expiredCore && c.officialDateConflict));

  // Onaylı kaynak alias'ı canlı gözlemi: yalnız O kaynağın tarihini, yalnız daha geç tarihe günceller; kural ezilmez.
  const crystalObs = { id: 'live-crystal_special-abc', bank: 'Yapı Kredi', sourceUrl: 'https://www.crystalcard.com.tr/crystal-dunyasi/yurtici-anlasmali-otel-and-restoran-indirimleri/', endDate: '2026-11-30', rewardRule: { kind: 'percent', rate: 0.99 }, periodCap: 99999 };
  const ykbObs = { id: 'live-crystal_special-ykb', bank: 'Yapı Kredi', sourceUrl: crystal.sourceUrl, endDate: '2026-09-15' };
  const foreign = { id: 'live-world-other', bank: 'Yapı Kredi', sourceUrl: 'https://www.crystalcard.com.tr/kampanyalar/baska', endDate: '2027-01-31' };
  const mergedMulti = mergeCatalogWithCore([crystalObs, ykbObs, foreign], { coreBenefits: CORE, now: OCT3 });
  const mm = mergedMulti.find(c => c.id === crystal.id);
  const byKey = Object.fromEntries(mm.officialSources.map(x => [x.key, x]));
  assert.equal(byKey.crystal.endDate, '2026-11-30'); assert.equal(byKey.crystal.liveUpdated, true);
  assert.equal(byKey.ykb.endDate, '2026-09-30'); assert.equal(byKey.ykb.lastObservedEndDate, '2026-09-15'); // daha erken tarih düşürmez
  assert.equal(mergedMulti.filter(c => c.id === crystalObs.id || c.id === ykbObs.id).length, 0); // iki gözlem de tüketildi
  assert.ok(mergedMulti.some(c => c.id === 'live-world-other')); // onaysız URL core'a bağlanmaz
  const mmr = resolveSegmentCampaign(mm, card('ykb-crystal'), OCT3);
  assert.equal(mmr.endDate, '2026-11-30'); assert.equal(mmr.rewardRule.rate, 0.20); assert.equal(mmr.liveExtendedValidity, true);
  assert.equal(observationMatchesCore(crystal, { ...crystalObs, bank: 'Akbank' }), false);

  // Tek kaynaklı core için tarih uzatma kuralları (sentetik kopya: officialSources yok).
  const single = { ...crystal, officialSources: undefined, dateConflictPolicy: undefined };
  const live = { id: 'live-world-x', bank: 'Yapı Kredi', sourceUrl: crystal.sourceUrl + '/', startDate: '2026-10-01', endDate: '2026-12-31',
    rewardRule: { kind: 'percent', rate: 0.99 }, periodCap: 999999, segmentRules: null };
  const merged = mergeCatalogWithCore([live], { coreBenefits: [single], now: OCT1 });
  const mc = merged.find(c => c.id === crystal.id);
  const resolved = resolveSegmentCampaign(mc, card('ykb-crystal'), OCT1);
  assert.equal(resolved.endDate, '2026-12-31');
  assert.equal(resolved.rewardRule.rate, 0.20);
  assert.equal(resolved.periodCap, 3000);
  assert.equal(resolved.liveExtendedValidity, true);
  assert.ok(resolved.decisionWarnings.some(w => /son doğrulanmış dönemden taşındı/.test(w)));
  const ev = evaluateCampaign({ campaign: mc, state: undefined, card: card('ykb-crystal'), merchant: 'Da Mario', category: 'restoran', amount: 5000, now: OCT1 });
  assert.equal(ev.eligible, true); assert.equal(ev.conditional, true);
  assert.equal(merged.filter(c => c.id === 'live-world-x').length, 0);
  const no = o => extendCoreValidity(single, { ...live, ...o }, OCT1) === single;
  assert.ok(no({ bank: 'Akbank' }));
  assert.ok(no({ sourceUrl: 'https://www.yapikredi.com.tr/baska-sayfa', id: 'x' }));
  assert.ok(no({ endDate: '2026-09-15' }));
  assert.ok(no({ endDate: '2026-13-45' }));
  assert.ok(no({ endDate: '2031-01-01' }));
  assert.ok(no({ staleFromLastKnownGood: true }));
  assert.equal(observationMatchesCore(single, { ...live, sourceKind: 'user_private' }), false);
  // Süresiz core (TEB) uzatılmaz/değişmez.
  const teb = byId('official-teb-infinite-restoran-ultra');
  assert.equal(extendCoreValidity(teb, { ...live, bank: 'TEB', sourceUrl: teb.sourceUrl }, OCT1), teb);
  console.log('#1 core validity + official source tests: OK');
}

// ---------------------------------------------------------------- #3 private campaigns
{
  const priv = { id: 'custom-1', sourceKind: 'user_private', bank: 'QNB', title: 'Uygulamaya özel', cardProductIds: ['qnb-ms-private'] };
  const existing = [...CORE, priv];
  // Supabase/statik katalog user_private içermez → silinmemeli.
  const merged = mergeCatalogWithCore([{ id: 'live-a', bank: 'TEB', title: 'A', sourceUrl: 'https://a' }], { coreBenefits: CORE, existingCampaigns: existing, now: OCT1 });
  assert.ok(merged.some(c => c.id === 'custom-1'));
  // Tamamen boş katalog alt kümesi de silmez.
  assert.ok(mergeCatalogWithCore([], { coreBenefits: CORE, existingCampaigns: existing, now: OCT1 }).some(c => c.id === 'custom-1'));
  // Yerel sunucu sürümü aynı id ile gelirse güncellenir, çoğalmaz.
  const updated = mergeCatalogWithCore([{ ...priv, title: 'Güncel' }], { coreBenefits: CORE, existingCampaigns: existing, now: OCT1 });
  assert.equal(updated.filter(c => c.id === 'custom-1').length, 1);
  assert.equal(updated.find(c => c.id === 'custom-1').title, 'Güncel');
  // Bulut round-trip: boş private_campaigns cihazdakini silmez; buluttaki yeni kayıt eklenir.
  const local = { settings: {}, states: {}, campaigns: existing };
  const a = applyCloudRow(local, { settings: {}, campaign_states: {}, private_campaigns: [] }, {});
  assert.ok(a.campaigns.some(c => c.id === 'custom-1'));
  const b = applyCloudRow(local, { private_campaigns: [{ id: 'custom-2', sourceKind: 'user_private', title: 'Bulut' }] }, {});
  assert.ok(b.campaigns.some(c => c.id === 'custom-1') && b.campaigns.some(c => c.id === 'custom-2'));
  // Upload → download → katalog yükleme zinciri
  const uploaded = JSON.parse(JSON.stringify(existing.filter(c => c.sourceKind === 'user_private')));
  const afterDownload = applyCloudRow({ settings: {}, states: {}, campaigns: CORE }, { private_campaigns: uploaded }, {});
  const afterReload = mergeCatalogWithCore([], { coreBenefits: CORE, existingCampaigns: afterDownload.campaigns, now: OCT1 });
  assert.ok(afterReload.some(c => c.id === 'custom-1'));
  assert.equal(mergePrivateCampaigns([priv], [{ id: 'live', sourceKind: 'official_web' }]).length, 1);
  console.log('#3 private campaign tests: OK');
}

// ---------------------------------------------------------------- #5 period cap
{
  const wings = byId('official-wings-program-restoran-2026');
  const wc = card('akbank-wings-black');
  const e = evaluateCampaign({ campaign: wings, state: undefined, card: wc, merchant: 'x', category: 'restoran', amount: 50000, now: OCT1 });
  assert.equal(e.perTransactionReward, 7500);
  assert.equal(e.theoreticalReward, 2500);
  assert.equal(e.periodCapApplied, true);
  assert.ok(e.inspection.warnings.some(w => /Kalan dönem hakkı bilinmiyor/.test(w)));
  const e20 = evaluateCampaign({ campaign: wings, state: undefined, card: wc, merchant: 'x', category: 'restoran', amount: 20000, now: OCT1 });
  assert.equal(e20.theoreticalReward, 2500);
  // Kalan hak biliniyorsa onunla daha da sınırlanır.
  const st = { campaignId: wings.id, periodKey: '2026-10', enrollmentStatus: 'joined', remainingLimit: 400, valueSource: 'user_confirmed', confirmedAt: OCT1.toISOString() };
  const ek = evaluateCampaign({ campaign: wings, state: st, card: wc, merchant: 'x', category: 'restoran', amount: 50000, now: OCT1 });
  assert.equal(ek.actualReward, 400);
  // Sıralama tavanlanmış değer üzerinden yapılır: Wings 50k ≠ 7.500 TL.
  const rec = recommend({ cards: [wc, card('teb-infinite')], campaigns: [wings, byId('official-teb-infinite-restoran-ultra')], states: {}, merchant: 'x', category: 'restoran', amount: 50000, now: OCT1 });
  for (const r of rec) assert.ok(r.best.theoreticalReward <= (r.best.campaign.periodCap ?? Infinity));
  console.log('#5 period cap tests: OK');
}

// ---------------------------------------------------------------- #6 enrollment scope
{
  const wings = byId('official-wings-program-restoran-2026');
  assert.equal(wings.enrollmentScope, 'program');
  const sept = { campaignId: wings.id, periodKey: '2026-09', enrollmentStatus: 'joined', remainingLimit: 0, valueSource: 'user_confirmed', confirmedAt: '2026-09-20T10:00:00Z' };
  const oct = ensureReset(resolveSegmentCampaign(wings, card('akbank-wings-black'), OCT1), sept, OCT1);
  assert.equal(oct.periodKey, '2026-10'); assert.equal(oct.enrollmentStatus, 'joined'); assert.equal(oct.remainingLimit, null);
  // Kampanyaya özel katılım (varsayılan) her dönem yeniden doğrulanır.
  const campaignSpecific = { id: 'c', resetPolicy: 'monthly', requiresEnrollment: true, periodCap: 100 };
  assert.equal(ensureReset(campaignSpecific, { ...sept, campaignId: 'c' }, OCT1).enrollmentStatus, 'unknown');
  // "unknown" program durumu "joined"a dönüşmez.
  assert.equal(ensureReset(wings, { ...sept, enrollmentStatus: 'unknown' }, OCT1).enrollmentStatus, 'unknown');
  console.log('#6 enrollment scope tests: OK');
}

// ---------------------------------------------------------------- #7 local-only API
{
  assert.equal(isLocalServerMode({ hostname: 'melihdelier.github.io' }, {}), false);
  assert.equal(isLocalServerMode({ hostname: '127.0.0.1' }, {}), true);
  assert.equal(isLocalServerMode({ hostname: 'localhost' }, {}), true);
  assert.equal(isLocalServerMode({ hostname: '' }, {}), false);
  assert.equal(isLocalServerMode({ hostname: 'melihdelier.github.io' }, { localApi: true }), true);
  assert.equal(isLocalServerMode({ hostname: 'localhost' }, { localApi: false }), false);
  // app.js içinde her /api/ çağrısı LOCAL_API kapısının arkasında olmalı.
  const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(app, /if \(LOCAL_API\) setInterval\(/);
  assert.match(app, /if \(LOCAL_API && \(mode === 'local' \|\| mode === 'auto'\)\)/);
  assert.match(app, /if \(!LOCAL_API\) throw new Error\('local_api_disabled'\)/);
  assert.match(app, /async function loadRuntimeVersion\(\) \{[\s\S]{0,200}if \(!LOCAL_API\) return;/);
  assert.match(app, /async function loadRefreshStatus\(\) \{\s*if \(!LOCAL_API\)/);
  console.log('#7 local api gating tests: OK');
}

// ---------------------------------------------------------------- low: versions / category / segment label
{
  const root = new URL('../', import.meta.url);
  const versionTxt = readFileSync(new URL('VERSION.txt', root), 'utf8').trim();
  assert.equal(APP_VERSION, versionTxt);
  assert.ok(readFileSync(new URL('./index.html', import.meta.url), 'utf8').includes(`<span id="runtimeVersion">${APP_VERSION}</span>`));
  const sw = readFileSync(new URL('./sw.js', import.meta.url), 'utf8');
  assert.ok(sw.includes(`const CACHE='bka-${APP_VERSION}';`));
  for (const f of ['./catalog-state.js', './version.js', './tr-time.js']) assert.ok(sw.includes(`'${f}'`), `${f} SW önbelleğinde olmalı`);
  assert.ok(!readFileSync(new URL('./app.js', import.meta.url), 'utf8').includes("'v1.2.0-pwa'"));

  // Alt dize eşleşmesi manuel kategoriyi ezmez.
  const prime = resolveMerchantInput(initialCampaigns, 'Amazon Prime Video', 'dijital');
  assert.equal(prime.effectiveCategory, 'dijital');
  assert.ok(prime.notices.some(n => /manuel kategori/.test(n)));
  // Birebir alias hâlâ düzeltir.
  assert.equal(resolveMerchantInput(initialCampaigns, 'Migros', 'e-ticaret').effectiveCategory, 'market');
  assert.equal(resolveMerchantInput(initialCampaigns, 'Migros Sanal Market', 'e-ticaret').effectiveCategory, 'market');
  // Bulanık yazım (typo) manuel seçimi ezmez.
  assert.equal(resolveMerchantInput(initialCampaigns, 'Migross', 'e-ticaret').effectiveCategory, 'e-ticaret');

  // Segment değişikliği: kalan hak bilinmiyor + "Kullanıcı doğruladı" etiketi kalmaz.
  const states = { 'official-teb-infinite-restoran-ultra': { campaignId: 'official-teb-infinite-restoran-ultra', periodKey: '2026-10', enrollmentStatus: 'not_required', remainingLimit: 5000, valueSource: 'user_confirmed', confirmedAt: OCT1.toISOString() } };
  const inv = invalidateSegmentDependentStates({ campaigns: CORE, states, bank: 'TEB', now: OCT1 });
  const s = inv['official-teb-infinite-restoran-ultra'];
  assert.equal(s.remainingLimit, null); assert.equal(s.periodKey, '2026-10');
  assert.notEqual(freshness(s, OCT1).label, 'Kullanıcı doğruladı');
  assert.equal(freshness(s, OCT1).status, 'unknown');
  // Durumu olmayan kampanya için sahte state (periodKey'siz → yanlış "reset") üretilmez.
  assert.equal(inv['official-wings-program-restoran-2026'], undefined);
  const teb = byId('official-teb-infinite-restoran-ultra');
  assert.equal(ensureReset(resolveSegmentCampaign(teb, card('teb-infinite'), OCT1), s, OCT1).remainingLimit, null);
  console.log('low-risk fix tests: OK');
}

// ---------------------------------------------------------------- #4 state preservation
{
  const conf = (id, extra = {}) => ({ campaignId: id, periodKey: '2026-10', enrollmentStatus: 'joined', remainingLimit: 123, valueSource: 'user_confirmed', confirmedAt: OCT1.toISOString(), qualifyingTransactions: 2, ...extra });
  const A = { id: 'live-qnb_ms-old', bank: 'QNB', title: 'Okul Alışverişi 2.500 Mil', sourceUrl: 'https://q/kampanya/okul', resetPolicy: 'monthly', requiresEnrollment: true, periodCap: 2500, cardProductIds: ['qnb-ms-private'] };
  const B = { id: 'live-teb-x', bank: 'TEB', title: 'Market', sourceUrl: 'https://t/market', resetPolicy: 'monthly', periodCap: 300, cardProductIds: ['teb-infinite'] };

  // Geçici kaybolma: durum silinmez, geri gelince aynen kullanılır.
  let st = reconcileCampaignStates({ campaigns: [B], states: { [A.id]: conf(A.id), [B.id]: conf(B.id) }, previousCampaigns: [A, B], now: OCT1 });
  assert.equal(st[A.id].remainingLimit, 123); assert.ok(st[A.id].orphanedAt);
  st = reconcileCampaignStates({ campaigns: [A, B], states: st, previousCampaigns: [B], now: new Date('2026-10-02T12:00:00+03:00') });
  assert.equal(st[A.id].remainingLimit, 123); assert.equal(st[A.id].enrollmentStatus, 'joined'); assert.equal(st[A.id].orphanedAt, undefined);

  // Canlı id değişimi (aynı URL): durum yeni id'ye taşınır.
  const A2 = { ...A, id: 'live-qnb_ms-new' };
  st = reconcileCampaignStates({ campaigns: [A2, B], states: { [A.id]: conf(A.id) }, previousCampaigns: [A], now: OCT1 });
  assert.equal(st[A2.id].remainingLimit, 123); assert.equal(st[A2.id].qualifyingTransactions, 2); assert.equal(st[A2.id].migratedFrom, A.id);
  assert.equal(st[A.id], undefined);

  // Kampanya-dönemi periodKey'i eski id içeriyorsa yeni id'ye uyarlanır (sahte reset yok).
  const C = { id: 'old-c', bank: 'QNB', title: 'Dönem', sourceUrl: 'https://q/donem', resetPolicy: 'campaign', startDate: '2026-09-15', endDate: '2026-10-15', periodCap: 1000 };
  const C2 = { ...C, id: 'new-c' };
  st = reconcileCampaignStates({ campaigns: [C2], states: { 'old-c': conf('old-c', { periodKey: 'old-c:2026-09-15:2026-10-15' }) }, previousCampaigns: [C], now: OCT1 });
  assert.equal(st['new-c'].remainingLimit, 123); assert.equal(st['new-c'].periodKey, 'new-c:2026-09-15:2026-10-15');

  // URL değişti ama banka+başlık aynı (tekil) → taşınır; belirsiz (iki aday) → taşınmaz, eski durum korunur.
  const A3 = { ...A, id: 'live-3', sourceUrl: 'https://q/kampanya/okul-2' };
  st = reconcileCampaignStates({ campaigns: [A3], states: { [A.id]: conf(A.id) }, previousCampaigns: [A], now: OCT1 });
  assert.equal(st['live-3'].remainingLimit, 123);
  const D1 = { ...A, id: 'd1', sourceUrl: 'https://q/d1' }, D2 = { ...A, id: 'd2', sourceUrl: 'https://q/d2' };
  st = reconcileCampaignStates({ campaigns: [D1, D2], states: { [A.id]: conf(A.id) }, previousCampaigns: [A], now: OCT1 });
  assert.equal(st.d1.remainingLimit, null); assert.equal(st.d2.remainingLimit, null); assert.equal(st[A.id].remainingLimit, 123);

  // Kullanıcı verisi olmayan çok eski orphan budanır; kullanıcı verisi olan budanmaz.
  const old = new Date('2026-01-01T00:00:00Z').toISOString();
  st = reconcileCampaignStates({ campaigns: [], states: { x: { campaignId: 'x', valueSource: 'reset', orphanedAt: old }, y: conf('y', { orphanedAt: old }) }, now: OCT1 });
  assert.equal(st.x, undefined); assert.equal(st.y.remainingLimit, 123);

  // Core state'leri (initialStates) yeni katalog yüklemesinde kaybolmaz.
  const merged = mergeCatalogWithCore([], { coreBenefits: CORE, now: OCT1 });
  st = reconcileCampaignStates({ campaigns: merged, states: initialStates, now: OCT1 });
  for (const id of Object.keys(initialStates)) assert.ok(st[id], id);
  console.log('#4 state preservation tests: OK');
}

// ---------------------------------------------------------------- same-URL reuse within the same calendar month
{
  const URL = 'https://bank/kampanya/market';
  const first = { id: 'live-teb_general-market', bank: 'TEB', title: 'Markette 300 TL Bonus', sourceUrl: URL, resetPolicy: 'monthly', requiresEnrollment: true, periodCap: 300, startDate: '2026-10-01', endDate: '2026-10-15', cardProductIds: ['teb-infinite'] };
  const used = { campaignId: first.id, periodKey: '2026-10', enrollmentStatus: 'joined', remainingLimit: 0, usedAmount: 300, qualifyingTransactions: 3, valueSource: 'user_confirmed', confirmedAt: '2026-10-10T10:00:00Z', campaignStart: '2026-10-01' };
  const D = new Date('2026-10-20T12:00:00+03:00');

  // Aynı id + aynı URL, aynı takvim ayı, farklı başlangıç → yeni kampanya: limit/ilerleme/katılım taşınmaz.
  const second = { ...first, startDate: '2026-10-16', endDate: '2026-10-31' };
  const r = ensureReset(second, used, D);
  assert.equal(r.periodKey, '2026-10');
  assert.equal(r.remainingLimit, null); assert.equal(r.qualifyingTransactions, null); assert.equal(r.usedAmount, null);
  assert.equal(r.enrollmentStatus, 'unknown'); assert.equal(r.valueSource, 'unknown'); assert.equal(r.campaignStart, '2026-10-16');
  assert.match(r.notes, /yeni kampanya dönemi/);
  const ev = evaluateCampaign({ campaign: second, state: used, card: card('teb-infinite'), merchant: 'x', category: 'all', amount: 1000, now: D });
  assert.notEqual(ev.state.remainingLimit, 0);

  // Aynı kampanyanın yalnız bitiş tarihi uzadıysa (aynı başlangıç) durum korunur.
  const extended = { ...first, endDate: '2026-10-31' };
  assert.equal(ensureReset(extended, used, D).remainingLimit, 0);
  assert.equal(ensureReset(extended, used, D).qualifyingTransactions, 3);

  // Yeni canlı id ile aynı URL'de yeniden yayın (reconcile taşıması) da yeni başlangıç tarihinde sıfırlanır.
  const reissued = { ...second, id: 'live-teb_general-market-2' };
  const st = reconcileCampaignStates({ campaigns: [reissued], states: { [first.id]: used }, previousCampaigns: [first], now: D });
  assert.equal(st[reissued.id].migratedFrom, first.id);
  assert.equal(st[reissued.id].remainingLimit, null); assert.equal(st[reissued.id].qualifyingTransactions, null);

  // Kampanya-dönemi politikası: uzatma korunur, aynı ay içinde yeni başlangıç yeni dönemdir.
  const cp = { ...first, resetPolicy: 'campaign' };
  const cpState = { ...used, periodKey: `${cp.id}:2026-10-01:2026-10-15` };
  const cpExt = ensureReset({ ...cp, endDate: '2026-10-31' }, cpState, D);
  assert.equal(cpExt.remainingLimit, 0); assert.equal(cpExt.periodKey, `${cp.id}:2026-10-01:2026-10-31`);
  const cpNew = ensureReset({ ...cp, startDate: '2026-10-16', endDate: '2026-10-31' }, cpState, D);
  assert.notEqual(cpNew.remainingLimit, 0); assert.equal(cpNew.qualifyingTransactions, null);

  // Eski (campaignStart'sız) durum: başlangıç damgalanır, sahte sıfırlama yapılmaz.
  const legacy = { ...used }; delete legacy.campaignStart;
  const lg = ensureReset(first, legacy, D);
  assert.equal(lg.remainingLimit, 0); assert.equal(lg.campaignStart, '2026-10-01');
  // Başlangıç tarihi ayrıştırılamadıysa (boş) karar verilmez, durum korunur.
  assert.equal(ensureReset({ ...first, startDate: null }, used, D).remainingLimit, 0);
  console.log('same-URL reuse tests: OK');
}


// ---------------------------------------------------------------- fresh install crossing into a new month
{
  const OCT3 = new Date('2026-10-03T12:00:00+03:00');
  // 1) Yeni cihaz: bootstrap katalog + bootstrap durumları (eylül dönem anahtarlı) → ekimde HİÇBİR tavan varsayılmaz.
  const campaigns = mergeCatalogWithCore([], { coreBenefits: CORE, now: OCT3 });
  const effective = c => resolveSegmentCampaign(c, initialCards.find(k => c.cardProductIds?.includes(k.cardProductId)) || { segment: null }, OCT3);
  const st = reconcileCampaignStates({ campaigns, states: JSON.parse(JSON.stringify(initialStates)), resolve: effective, now: OCT3 });
  for (const c of campaigns) {
    const e = effective(c);
    if (e.periodCap == null) continue;
    assert.equal(st[c.id].remainingLimit, null, `${c.id} fresh install must be unknown`);
    assert.equal(st[c.id].valueSource, 'unknown', c.id);
    assert.equal(freshness(st[c.id], OCT3).status, 'unknown', c.id);
  }
  for (const v of Object.values(initialStates)) { assert.equal(v.remainingLimit, null); assert.equal(v.confirmedAt, null); }
  // Crystal örneği: hesap kalan hakkı bilinmiyor diye kesin sonuç vermez, tavanlı teorik üst sınır gösterir.
  const crystal = byId('official-ykb-crystal-restoran-2026-09');
  const ce = evaluateCampaign({ campaign: crystal, state: st[crystal.id], card: card('ykb-crystal'), merchant: 'Da Mario', category: 'restoran', amount: 5000, now: OCT3 });
  assert.equal(ce.remainingKnown, false); assert.equal(ce.actualReward, null); assert.equal(ce.theoreticalReward, 1000);
  assert.ok(ce.inspection.warnings.some(w => /Kalan dönem hakkı bilinmiyor/.test(w)));

  // 2) v1.2.1 cihazında kalmış eski örnek "reset" durumları (eylül, tam tavan, kaynağı kullanıcı değil) → ekimde bilinmiyor.
  const legacy = { campaignId: crystal.id, periodKey: '2026-09', enrollmentStatus: 'not_required', remainingLimit: 3000, usedAmount: 0, valueSource: 'reset', confirmedAt: '2026-09-01T00:01:00+03:00' };
  const lr = ensureReset(resolveSegmentCampaign(crystal, card('ykb-crystal'), OCT3), legacy, OCT3);
  assert.equal(lr.remainingLimit, null); assert.equal(lr.valueSource, 'unknown');

  // 3) Aynı cihaz bir ay daha geçerse de bilinmiyor kalır (bilinmeyenden tavan türemez).
  const NOV2 = new Date('2026-11-02T12:00:00+03:00');
  const teb = byId('official-teb-infinite-restoran-ultra');
  const nov = ensureReset(resolveSegmentCampaign(teb, card('teb-infinite'), NOV2), st[teb.id], NOV2);
  assert.equal(nov.periodKey, '2026-11'); assert.equal(nov.remainingLimit, null);

  // 4) Kullanıcı eylülde doğrulamış olsa bile ekim BİLİNMİYOR başlar: önceki dönem doğrulaması yeni döneme tavan vermez.
  const confirmed = { campaignId: teb.id, periodKey: '2026-09', enrollmentStatus: 'not_required', remainingLimit: 1200, valueSource: 'user_confirmed', confirmedAt: '2026-09-30T22:00:00+03:00' };
  const tebOct = resolveSegmentCampaign(teb, card('teb-infinite'), OCT3);
  for (const when of [new Date('2026-10-01T00:05:00+03:00'), OCT3, new Date('2026-10-20T12:00:00+03:00')]) {
    const r = ensureReset(tebOct, confirmed, when);
    assert.equal(r.periodKey, '2026-10'); assert.equal(r.remainingLimit, null); assert.equal(r.usedAmount, null);
    assert.equal(r.valueSource, 'unknown'); assert.equal(r.confirmedAt, null);
    assert.equal(freshness(r, when).status, 'unknown');
    // Tavanlı teorik kazanç görünür kalır, kalan hak bilinmiyor işaretlenir ve kesin kazanç üretilmez.
    const ev = evaluateCampaign({ campaign: teb, state: confirmed, card: card('teb-infinite'), merchant: 'x', category: 'restoran', amount: 50000, now: when });
    assert.equal(ev.eligible, true); assert.equal(ev.theoreticalReward, 2000); assert.equal(ev.remainingKnown, false); assert.equal(ev.actualReward, null);
    assert.ok(ev.inspection.warnings.some(w => /Kalan dönem hakkı bilinmiyor/.test(w)));
  }
  // Kampanya-dönemi politikası: yeni dönem de bilinmiyor başlar.
  const cpC = { id: 'cp-x', resetPolicy: 'campaign', periodCap: 500, startDate: '2026-10-01', endDate: '2026-10-31', requiresEnrollment: false };
  const cpR = ensureReset(cpC, { campaignId: 'cp-x', periodKey: 'cp-x:2026-09-01:2026-09-30', remainingLimit: 500, valueSource: 'user_confirmed', confirmedAt: '2026-09-29T10:00:00Z' }, OCT3);
  assert.equal(cpR.remainingLimit, null); assert.equal(cpR.valueSource, 'unknown');
  // Kalan hak sıralamayı yalnız yeni dönemde yeniden doğrulanınca etkiler: doğrulanmış 0 TL kalan → kart sıralamada geriler.
  const wingsC = byId('official-wings-program-restoran-2026');
  const fresh0 = { 'official-teb-infinite-restoran-ultra': { campaignId: teb.id, periodKey: '2026-10', enrollmentStatus: 'not_required', remainingLimit: 0, valueSource: 'user_confirmed', confirmedAt: OCT3.toISOString() },
                   'official-wings-program-restoran-2026': { campaignId: wingsC.id, periodKey: '2026-09', enrollmentStatus: 'joined', remainingLimit: 2500, valueSource: 'user_confirmed', confirmedAt: '2026-09-30T10:00:00+03:00' } };
  const rec = recommend({ cards: [card('teb-infinite'), card('akbank-wings-black')], campaigns: [teb, wingsC], states: fresh0, merchant: 'x', category: 'restoran', amount: 10000, now: OCT3 });
  const wingsRow = rec.find(r => r.card.cardProductId === 'akbank-wings-black');
  assert.equal(wingsRow.best.state.remainingLimit, null); // eylül doğrulaması ekime taşınmadı
  assert.equal(wingsRow.best.actualReward, null); assert.equal(wingsRow.best.theoreticalReward, 1500);
  assert.equal(wingsRow.best.state.enrollmentStatus, 'joined'); // program katılımı korunur
  assert.equal(rec.find(r => r.card.cardProductId === 'teb-infinite').best.actualReward, 0);
  // v1.2.1 cihazının bu ay için otomatik yazdığı tam-tavan 'reset' değeri de bilinmiyor yapılır (doğrulama değil).
  const legacyOct = { campaignId: teb.id, periodKey: '2026-10', enrollmentStatus: 'not_required', remainingLimit: 8000, usedAmount: 0, valueSource: 'reset', confirmedAt: '2026-10-01T00:01:00+03:00' };
  const lo = ensureReset(tebOct, legacyOct, OCT3);
  assert.equal(lo.periodKey, '2026-10'); assert.equal(lo.remainingLimit, null); assert.equal(lo.valueSource, 'unknown');
  const loEval = evaluateCampaign({ campaign: teb, state: legacyOct, card: card('teb-infinite'), merchant: 'x', category: 'restoran', amount: 5000, now: OCT3 });
  assert.equal(loEval.remainingKnown, false); assert.equal(loEval.actualReward, null);
  // Bu dönem kullanıcı doğrulamış değer ise aynen kullanılır.
  const verifiedOct = { ...legacyOct, remainingLimit: 600, valueSource: 'user_confirmed', confirmedAt: OCT3.toISOString() };
  assert.equal(ensureReset(tebOct, verifiedOct, OCT3).remainingLimit, 600);
  console.log('fresh install / month rollover tests: OK');
}

// ---------------------------------------------------------------- Crystal tier caps vs Metal+Crystal combined cap
{
  const crystal = byId('official-ykb-crystal-restoran-2026-09');
  const OCT3 = new Date('2026-10-03T12:00:00+03:00');
  assert.deepEqual(Object.keys(crystal.segmentRules), ['1 milyon TL altı', '1–6 milyon TL', '6–10 milyon TL', '10 milyon TL+']);
  assert.deepEqual(Object.values(crystal.segmentRules).map(r => r.periodCap), [3000, 5000, 7500, 10000]);
  assert.ok(!crystal.eligibility.segmentLabels.includes('Metal Crystal'));
  assert.equal(crystal.combinedCustomerCaps[0].periodCap, 15000);
  assert.deepEqual(crystal.combinedCustomerCaps[0].requiresCardTypes, ['crystal', 'metal_crystal']);
  const base = card('ykb-crystal');
  const top = { ...base, segment: '10 milyon TL+' };
  // Yalnız Metal Crystal: 15.000 genel tavan olarak UYGULANMAZ; varlık seviyesi tavanı (10.000) geçerli.
  const metalOnly = applyCombinedCustomerCaps(resolveSegmentCampaign(crystal, { ...top, cardType: 'metal_crystal' }, OCT3), { ...top, cardType: 'metal_crystal' });
  assert.equal(metalOnly.periodCap, 10000); assert.equal(metalOnly.activeCombinedCaps, undefined);
  // İkisi birden: birleşik müşteri kuralı devrede (ayrı kural + uyarı); kart başı tavan değişmez.
  const both = { ...top, cardType: 'crystal_and_metal' };
  const eb = evaluateCampaign({ campaign: crystal, state: undefined, card: both, merchant: 'Da Mario', category: 'restoran', amount: 30000, now: OCT3 });
  assert.equal(eb.campaign.periodCap, 10000);
  assert.equal(eb.campaign.activeCombinedCaps[0].id, 'crystal_plus_metal');
  assert.ok(eb.inspection.warnings.some(w => /15\.000 TL/.test(w) && /toplam/.test(w)));
  // Segment kaybolmaz: Metal Crystal seçimi kartı segment dışı bırakmaz.
  const metalUnder = evaluateCampaign({ campaign: crystal, state: undefined, card: { ...base, cardType: 'metal_crystal' }, merchant: 'Da Mario', category: 'restoran', amount: 5000, now: OCT3 });
  assert.equal(metalUnder.eligible, true); assert.equal(metalUnder.campaign.periodCap, 3000);
  // Birleşik tavan kart başı tavandan küçükse (sentetik) daha sıkı olan uygulanır.
  const synthetic = applyCombinedCustomerCaps({ periodCap: 20000, combinedCustomerCaps: crystal.combinedCustomerCaps }, both);
  assert.equal(synthetic.periodCap, 15000);
  const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  assert.ok(!/\?\s*'Metal Crystal'\s*:/.test(app), 'app.js must not map card type to a Metal Crystal segment');
  console.log('Crystal tier vs combined cap tests: OK');
}
