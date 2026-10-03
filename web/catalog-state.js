// Katalog birleştirme ve kullanıcı durumu koruma kuralları.
// DOM'a dokunmayan saf fonksiyonlardır; app.js bunları kullanır, test-catalog-state.mjs test eder.
import { ensureReset } from './engine.js';
import { trDay, addTrDays } from './tr-time.js';
import { normalizeLegacyCampaignSegments } from './legacy-option-aliases.js';

export function normSourceUrl(u) { return String(u || '').trim().replace(/\/+$/, '').toLowerCase(); }

function foldText(v) {
  return String(v ?? '').trim().toLocaleLowerCase('tr-TR')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ı/g, 'i')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function validIsoDate(v) {
  if (!ISO_DATE.test(String(v || ''))) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Yerel sunucu modu: /api/* uçları yalnız yerel geliştirme sunucusunda vardır.
// GitHub Pages üretiminde bu uçlar çağrılmaz (404 / pil / veri israfı).
// ---------------------------------------------------------------------------
export function isLocalServerMode(loc = globalThis.location, cfg = globalThis.BKA_CONFIG || {}) {
  if (cfg && cfg.localApi === true) return true;
  if (cfg && cfg.localApi === false) return false;
  const h = String(loc?.hostname || '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' || h.endsWith('.localhost');
}

// ---------------------------------------------------------------------------
// Kullanıcıya özel kampanyalar
// ---------------------------------------------------------------------------
export function isPrivateCampaign(c) { return Boolean(c) && c.sourceKind === 'user_private'; }

function privateKey(c) {
  return c.id ? `id:${c.id}` : `t:${foldText(c.bank)}|${foldText(c.title)}|${foldText(String(c.termsSummary || '').slice(0, 200))}`;
}

// Birleşim: mevcut kayıt asla yalnızca gelen listede yok diye silinmez. Aynı anahtarlı kayıtta gelen sürüm kazanır.
export function mergePrivateCampaigns(existing = [], incoming = []) {
  const map = new Map();
  for (const c of existing || []) if (isPrivateCampaign(c)) map.set(privateKey(c), clone(c));
  for (const c of incoming || []) if (isPrivateCampaign(c)) {
    const k = privateKey(c);
    map.set(k, { ...(map.get(k) || {}), ...clone(c) });
  }
  return [...map.values()];
}

// ---------------------------------------------------------------------------
// Sürekli kart ayrıcalıkları (core) + canlı gözlem
// ---------------------------------------------------------------------------
const NAV_MERCHANT_NOISE = /^(?:ana sayfa|bireysel bankacılık|krediler|kartlar|kredi kartları|mevduat ürünleri|yatırım ürünleri|ödemeler ve hizmetler|sigorta ve emeklilik|hesaplama araçları|şube ve|atm(?:'ler|ler)?|kendim için|işim için|geri)$/i;

export function safeMerchantScope(core, live) {
  const cs = core?.merchantScope || { kind: 'all' };
  const ls = live?.merchantScope || null;
  if (!ls || cs.kind !== 'contains' || ls.kind !== 'contains') return cs;
  const liveValues = (ls.values || []).filter(v => v && !NAV_MERCHANT_NOISE.test(String(v).trim()));
  if (!liveValues.length) return cs;
  const values = [...new Set([...(cs.values || []), ...liveValues])];
  const excludedValues = [...new Set([...(cs.excludedValues || []), ...(ls.excludedValues || [])])];
  return { ...cs, ...ls, values, excludedValues, requiresBranchConfirmation: cs.requiresBranchConfirmation === true || ls.requiresBranchConfirmation === true };
}

// Core ayrıcalığın onaylı resmi kaynak URL'leri: birincil sourceUrl + officialSources[].url (kaynak alias'ları).
export function coreApprovedUrls(core) {
  const urls = [core?.sourceUrl, ...((core?.officialSources || []).map(x => x && x.url))].map(normSourceUrl).filter(Boolean);
  return [...new Set(urls)];
}

// Canlı kaydın aynı core ayrıcalığa ait olduğu "açıkça" belli mi?
// Onaylı resmi kaynak URL'lerinden biri (veya aynı id) + aynı banka şart. Son-başarılı (stale) kopyalar sayılmaz.
export function observationMatchesCore(core, observed) {
  if (!core || !observed) return false;
  if (observed.sourceKind === 'user_private') return false;
  if (observed.staleFromLastKnownGood) return false;
  const sameUrl = coreApprovedUrls(core).includes(normSourceUrl(observed.sourceUrl));
  const sameId = observed.id && observed.id === core.id;
  if (!sameUrl && !sameId) return false;
  if (observed.bank && core.bank && foldText(observed.bank) !== foldText(core.bank)) return false;
  return true;
}

const RULE_FIELDS = ['segmentRules', 'rewardRule', 'periodCap', 'eligibility', 'transactionRules', 'requiresEnrollment', 'enrollmentMethod', 'enrollmentScope', 'rulesComplete', 'rewardUnit', 'termsSummary'];

function corePeriods(core) {
  if (Array.isArray(core.validityPeriods) && core.validityPeriods.length) return core.validityPeriods.map(clone);
  const p = { id: 'base', startDate: core.startDate || null, endDate: core.endDate || null, verifiedAt: core.verifiedAt };
  for (const f of RULE_FIELDS) if (core[f] !== undefined) p[f] = clone(core[f]);
  return [p];
}

// Canlı gözlem daha geç ve geçerli bir bitiş tarihi gösteriyorsa yalnız TARİH uzatılır.
// Ödül/segment kuralları son doğrulanmış dönemden taşınır ve sonuç koşullu (uyarılı) olur.
export function extendCoreValidity(core, observed, now = new Date(), { maxHorizonDays = 400 } = {}) {
  if (!observationMatchesCore(core, observed)) return core;
  const periods = corePeriods(core);
  const ends = periods.map(p => p.endDate);
  if (ends.some(e => !e)) return core; // süresiz core: uzatmaya gerek yok
  const lastEnd = ends.sort().pop();
  const liveEnd = observed.endDate;
  if (!validIsoDate(liveEnd) || liveEnd <= lastEnd) return core;
  if (liveEnd > addTrDays(trDay(now), maxHorizonDays)) return core; // makul olmayan uzak tarih: güvenme (Türkiye günü)
  let liveStart = validIsoDate(observed.startDate) ? observed.startDate : addDays(lastEnd, 1);
  if (liveStart > liveEnd) return core;
  if (liveStart <= lastEnd) liveStart = addDays(lastEnd, 1);
  const base = periods.slice().sort((a, b) => String(a.endDate).localeCompare(String(b.endDate))).pop();
  const extension = { id: `live-${liveStart}-${liveEnd}`, startDate: liveStart, endDate: liveEnd, liveExtended: true, verifiedAt: base.verifiedAt };
  for (const f of RULE_FIELDS) if (base[f] !== undefined) extension[f] = clone(base[f]);
  extension.decisionWarnings = [...new Set([...(base.decisionWarnings || []),
    `Yeni geçerlilik tarihi (${liveStart} → ${liveEnd}) resmi sayfada görüldü; ödül/segment kuralları son doğrulanmış dönemden taşındı. Yeni dönem koşullarını resmi sayfadan kontrol et.`])];
  return { ...core, validityPeriods: [...periods, extension] };
}

// Birden fazla onaylı resmi kaynağı olan core: her kaynağın kendi tarihi yalnız O kaynağın canlı gözlemiyle
// ve yalnız daha geç + geçerli + makul bir tarihe güncellenir. Çelişki motor tarafında temsil edilir.
export function applyOfficialSourceObservations(core, observations = [], now = new Date(), { maxHorizonDays = 400 } = {}) {
  if (!Array.isArray(core?.officialSources) || !core.officialSources.length) return core;
  const horizon = addTrDays(trDay(now), maxHorizonDays);
  const sources = core.officialSources.map(src => {
    const obs = observations.find(o => observationMatchesCore(core, o) && normSourceUrl(o.sourceUrl) === normSourceUrl(src.url));
    if (!obs) return clone(src);
    const out = { ...clone(src), lastObservedAt: obs.verifiedAt || new Date(now).toISOString(), lastObservedEndDate: obs.endDate || null };
    const liveEnd = obs.endDate;
    if (validIsoDate(liveEnd) && (!validIsoDate(src.endDate) || liveEnd > src.endDate) && liveEnd <= horizon) {
      out.endDate = liveEnd; out.liveUpdated = true;
    }
    return out;
  });
  return { ...core, officialSources: sources };
}

export function mergeCatalogWithCore(campaigns = [], { coreBenefits = [], existingCampaigns = [], now = new Date() } = {}) {
  // v1.4.3: yayında kalmış eski kayıtların eşik etiketli segment anahtarları nötr bant kodlarına çevrilir.
  const incoming = clone(Array.isArray(campaigns) ? campaigns : []).map(normalizeLegacyCampaignSegments);
  const live = incoming.filter(c => !isPrivateCampaign(c));
  const consumed = new Set();
  const cores = coreBenefits.map(core => {
    const approved = coreApprovedUrls(core);
    const matchIdx = live.map((c, idx) => idx).filter(idx => !consumed.has(idx) && (
      approved.includes(normSourceUrl(live[idx].sourceUrl)) || live[idx].id === core.id
    ));
    // Çok kaynaklı core: tüm onaylı kaynak gözlemleri tüketilir (ayrı kopya kalmaz). Tek kaynaklı: ilk eşleşme.
    const take = Array.isArray(core.officialSources) && core.officialSources.length ? matchIdx : matchIdx.slice(0, 1);
    take.forEach(idx => consumed.add(idx));
    const observations = take.map(idx => live[idx]);
    const observed = observations[0] || null;
    // Finansal/segment kuralları doğrulanmış core kayıttan gelir; canlı kaynak yalnız işyeri kapsamını,
    // son görülme bilgisini ve (açıkça aynı ayrıcalıksa) daha geç geçerlilik tarihini zenginleştirir.
    const verifiedCore = Array.isArray(core.officialSources) && core.officialSources.length
      ? applyOfficialSourceObservations(clone(core), observations, now)
      : extendCoreValidity(clone(core), observed, now);
    return {
      ...(observed || {}),
      ...verifiedCore,
      merchantScope: safeMerchantScope(core, observed),
      verifiedAt: observed?.verifiedAt || core.verifiedAt,
      rawTextDigest: observed?.rawTextDigest || core.rawTextDigest,
      sourceKind: 'core_benefit',
      coreBenefit: true,
      liveObserved: Boolean(observed),
    };
  });
  const rest = live.filter((_, idx) => !consumed.has(idx) && !coreBenefits.some(core => core.id === live[idx]?.id));
  // Kullanıcıya özel kampanyalar katalog alt kümesinde olmasa bile korunur (boş liste silme sebebi değildir).
  const privates = mergePrivateCampaigns(existingCampaigns, incoming);
  return [...cores, ...rest, ...privates];
}

// ---------------------------------------------------------------------------
// Kampanya durumu (kalan hak / katılım / ilerleme) uzlaştırma
// ---------------------------------------------------------------------------
export function campaignIdentity(c) {
  if (!c) return { url: '', bankTitle: '' };
  const title = foldText(c.title);
  return { url: normSourceUrl(c.sourceUrl), bankTitle: title ? `${foldText(c.bank)}|${title}` : '' };
}

function hasUserData(st) {
  return Boolean(st) && (st.valueSource === 'user_confirmed' || st.enrollmentStatus === 'joined' || st.enrollmentStatus === 'not_joined'
    || (st.qualifyingTransactions !== null && st.qualifyingTransactions !== undefined));
}

function migrateState(state, oldId, newId) {
  const out = { ...clone(state), campaignId: newId, migratedFrom: oldId };
  if (typeof out.periodKey === 'string' && out.periodKey.startsWith(`${oldId}:`)) out.periodKey = `${newId}:${out.periodKey.slice(oldId.length + 1)}`;
  delete out.orphanedAt;
  return out;
}

// Kurallar:
//  * Katalogda geçici olarak görünmeyen kampanyanın durumu SİLİNMEZ; "orphanedAt" ile saklanır.
//  * Canlı id değiştiyse ve eski kayıt aynı resmi URL'ye (yoksa aynı banka+başlığa) tekil olarak eşleşiyorsa
//    durum yeni id'ye taşınır.
//  * Yalnız kullanıcı verisi içermeyen orphan durumlar, uzun süre (retentionDays) görünmezse budanır.
export function reconcileCampaignStates({ campaigns = [], states = {}, previousCampaigns = [], resolve = c => c, now = new Date(), retentionDays = 180 }) {
  const prev = states || {};
  const nowIso = new Date(now).toISOString();
  const ids = new Set(campaigns.map(c => c.id));
  const prevById = new Map((previousCampaigns || []).map(c => [c.id, c]));

  const orphanIds = Object.keys(prev).filter(id => !ids.has(id));
  const orphanIdentity = id => prev[id]?.identity || campaignIdentity(prevById.get(id));

  // Tekil eşleşme haritaları
  const byKey = (kind) => {
    const m = new Map();
    for (const id of orphanIds) {
      const k = orphanIdentity(id)?.[kind];
      if (!k) continue;
      m.set(k, m.has(k) ? null : id); // null = belirsiz (birden fazla aday)
    }
    return m;
  };
  const orphanByUrl = byKey('url');
  const orphanByTitle = byKey('bankTitle');
  const newNeedingCount = (kind, key) => campaigns.filter(c => !prev[c.id] && campaignIdentity(c)[kind] === key).length;

  const next = {};
  const consumed = new Set();
  for (const raw of campaigns) {
    const c = resolve(raw);
    const ident = campaignIdentity(raw);
    let st = prev[raw.id];
    if (!st) {
      let from = null;
      if (ident.url && orphanByUrl.get(ident.url) && newNeedingCount('url', ident.url) === 1) from = orphanByUrl.get(ident.url);
      else if (ident.bankTitle && orphanByTitle.get(ident.bankTitle) && newNeedingCount('bankTitle', ident.bankTitle) === 1) from = orphanByTitle.get(ident.bankTitle);
      if (from && !consumed.has(from)) { st = migrateState(prev[from], from, raw.id); consumed.add(from); }
    }
    const normalized = ensureReset(c, st, now);
    const out = { ...normalized, identity: ident };
    if (st?.migratedFrom && !out.migratedFrom) out.migratedFrom = st.migratedFrom;
    delete out.orphanedAt;
    next[raw.id] = out;
  }

  const cutoff = new Date(now).getTime() - retentionDays * 86400000;
  for (const id of orphanIds) {
    if (consumed.has(id)) continue;
    const st = prev[id];
    if (!st || typeof st !== 'object') continue;
    const orphanedAt = st.orphanedAt || nowIso;
    if (!hasUserData(st) && new Date(orphanedAt).getTime() < cutoff) continue; // uzun süredir yok + kullanıcı verisi yok
    next[id] = { ...st, identity: st.identity || orphanIdentity(id), orphanedAt };
  }
  return next;
}

// Segment değişince segment-bağımlı kalan hak bilinmiyor yapılır; "Kullanıcı doğruladı" etiketi kalmaz.
export function invalidateSegmentDependentStates({ campaigns = [], states = {}, bank, now = new Date() }) {
  const nowIso = new Date(now).toISOString();
  const next = { ...states };
  for (const campaign of campaigns) {
    if (campaign.bank !== bank) continue;
    const dependsOnSegment = (campaign.eligibility?.segmentLabels?.length || 0) > 0 || Boolean(campaign.segmentRules) || Array.isArray(campaign.validityPeriods);
    if (!dependsOnSegment) continue;
    const prev = next[campaign.id];
    if (!prev) continue; // durum yoksa motor zaten "ilk kez görüldü → bilinmiyor" kabul eder
    next[campaign.id] = {
      ...prev,
      remainingLimit: null,
      usedAmount: null,
      valueSource: 'unknown',
      confirmedAt: null,
      updatedAt: nowIso,
      segmentChangedAt: nowIso,
      notes: 'Segment değişti; kalan kampanya hakkı yeniden doğrulanmalı.'
    };
  }
  return next;
}

// Bulut verisini cihaza uygularken kullanıcıya özel kampanyalar birleştirilir, silinmez.
export function applyCloudRow(localData, row, defaultSettings = {}) {
  const out = { ...localData };
  out.settings = { ...defaultSettings, ...(row.settings || {}) };
  out.states = { ...(localData.states || {}), ...(row.campaign_states || {}) };
  const cloudPrivates = Array.isArray(row.private_campaigns) ? row.private_campaigns : [];
  const local = localData.campaigns || [];
  out.campaigns = [...local.filter(c => !isPrivateCampaign(c)), ...mergePrivateCampaigns(local, cloudPrivates)];
  return out;
}
