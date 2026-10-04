// v1.4.1 — Ortak kampanya uygunluk değerlendiricisi (Kampanyalar + Hangi Kart? aynı fonksiyonu kullanır).
//
// Kural modeli (catalog JSON'da `eligibilityRule`, şema sürümü ELIGIBILITY_SCHEMA_VERSION; ayrıntı: docs/ELIGIBILITY_SCHEMA_v1.md).
// Tüm değerler KARARLI KODLARDIR (kart ürünü kodu, banka kodu, profil boyutu kodu, seçenek kodu); Türkçe görünen
// etiketlere bağlı değildir.
//
//   { "all":  [rule, ...] }                          VE
//   { "any":  [rule, ...] }                          VEYA
//   { "not":  rule }                                 DEĞİL / hariç tutma
//   { "payWith": { "cards": [...], "banks": [...], "families": [...] } } işlemde kullanılan kart bu ürünlerden/bankalardan/
//                                                    uygunluk ailelerinden biri (v1.5.0: families = kararlı aile/program kodu;
//                                                    ürün, ana verideki aile ÜYELİĞİ ile eşleşir — kural ürün listesine indirgenmez)
//   { "owns":    { "cards": [...], "banks": [...] } } kullanıcı bu ürünlerden birine sahip / bu bankanın müşterisi
//   { "attr":    { "dim": "teb_tier", "in": ["ultra"] } }  profil özniteliği (boyut kodu + seçenek kodları)
//   { "always": true }
//   { "legacySegmentLabel": { "in": [...] } }         YALNIZ geriye uyumluluk (eski eligibility.segmentLabels)
//
// Üç değerli mantık: true / false / null (bilinmiyor — ör. kullanıcı segmentini seçmemiş). Uygun = yalnız true.
// Bilinmeyen öznitelik asla "uygun" sayılmaz; gerekçesiyle birlikte döner (gelecekte "segmentini seçersen" ipucu için).

import { optionDisplayLabel } from './profile-criteria.js';
import { CARD_ELIGIBILITY_FAMILIES } from './profile-catalog.js';

export const ELIGIBILITY_SCHEMA_VERSION = 1;

const norm = v => String(v ?? '').trim().toLocaleLowerCase('tr-TR');
const asList = v => (Array.isArray(v) ? v : (v == null ? [] : [v])).map(String);

// ------------------------------------------------------------------ bağlam
// cards: kullanıcının sahip olduğu kart ürün kodları; banks: müşterisi olduğu banka kodları;
// attributes: { boyut_kodu: seçenek_kodu } (kanonik uygunluk kaynağı);
// attributesKnown: false ise (eski çağrılar / profil bilgisi verilmemiş) yalnız uyumluluk düğümleri card.segment'e bakar.
export function buildEligibilityContext({ cards = [], banks = null, attributes = null, catalog = null } = {}) {
  const cardCodes = cards.map(c => (typeof c === 'string' ? c : c?.cardProductId)).filter(Boolean);
  const cardBank = new Map((catalog?.cardProducts || []).map(p => [p.code, p.bankCode]));
  const productFamilies = productFamilyMap(catalog);
  const bankCodes = banks ? banks.map(String) : [...new Set(cardCodes.map(c => cardBank.get(c)).filter(Boolean))];
  return {
    cards: new Set(cardCodes),
    banks: new Set(bankCodes),
    attributes: attributes ? { ...attributes } : {},
    attributesKnown: attributes != null,
    catalog,
    cardBank,
    productFamilies,
    mode: 'actual',
  };
}

// Ürün → uygunluk aileleri (ana veri). Katalog aile listesi taşımıyorsa paketli sürümlü liste kullanılır.
export function productFamilyMap(catalog) {
  const fams = Array.isArray(catalog?.cardFamilies) ? catalog.cardFamilies : CARD_ELIGIBILITY_FAMILIES;
  const map = new Map();
  for (const f of fams) for (const m of f.members || []) { if (!map.has(m)) map.set(m, new Set()); map.get(m).add(f.code); }
  return map;
}

export function cardFamiliesOf(card, ctx) {
  const code = card?.cardProductId;
  const fromMaster = (ctx?.productFamilies || productFamilyMap(ctx?.catalog)).get(code) || new Set();
  return new Set([...fromMaster, ...asList(card?.families)]);
}

// Eski tek-kullanıcı ayarlarından (settingKey) kanonik öznitelik haritası.
export function attributesFromLegacySettings(settings = {}, catalog) {
  const out = {};
  for (const d of catalog?.dimensions || []) {
    if (d.settingKey && settings[d.settingKey] != null) out[d.code] = String(settings[d.settingKey]);
  }
  return out;
}

// ------------------------------------------------------------------ kural değerlendirme
const leaf = (value, reason) => ({ value, reasons: reason && value !== true ? [reason] : [] });

// Kullanıcıya gösterilen ad: güncel ölçüt etiketi (ör. "1–4 milyon TL arası"), yoksa seçeneğin nötr adı.
function optionLabel(ctx, dim, code) {
  return ctx.catalog ? optionDisplayLabel(ctx.catalog, dim, code) : code;
}

export function evaluateRule(rule, ctx, card, opts = {}) {
  if (rule == null) return leaf(true);
  if (typeof rule !== 'object' || Array.isArray(rule)) return leaf(false, { code: 'invalid_rule', message: 'Geçersiz uygunluk kuralı.' });
  const keys = Object.keys(rule);
  if (keys.length !== 1) return leaf(false, { code: 'invalid_rule', message: 'Uygunluk kuralı düğümü tek anahtar içermeli.' });
  const [op] = keys;
  const arg = rule[op];

  if (op === 'always') return leaf(arg === true, { code: 'never', message: 'Kampanya bu profile açık değil.' });

  if (op === 'all' || op === 'any') {
    const parts = asArray(arg).map(r => evaluateRule(r, ctx, card, opts));
    if (op === 'all') {
      const value = parts.some(p => p.value === false) ? false : parts.some(p => p.value === null) ? null : true;
      return { value, reasons: value === true ? [] : parts.filter(p => p.value !== true).flatMap(p => p.reasons) };
    }
    const value = parts.some(p => p.value === true) ? true : parts.some(p => p.value === null) ? null : false;
    return { value, reasons: value === true ? [] : parts.flatMap(p => p.reasons) };
  }

  if (op === 'not') {
    const inner = evaluateRule(arg, ctx, card, { ...opts, negated: !opts.negated });
    const value = inner.value === null ? null : !inner.value;
    return { value, reasons: value === true ? [] : (inner.value === null ? inner.reasons : [{ code: 'excluded', message: 'Bu kart/profil kampanyadan hariç tutulmuş.' }]) };
  }

  if (op === 'payWith') {
    const cardsOk = !arg?.cards || asList(arg.cards).includes(String(card?.cardProductId));
    const bank = ctx.cardBank?.get(card?.cardProductId) || card?.bankCode || null;
    const banksOk = !arg?.banks || (bank != null && asList(arg.banks).includes(bank));
    const fams = arg?.families ? cardFamiliesOf(card, ctx) : null;
    const familiesOk = !arg?.families || asList(arg.families).some(f => fams.has(f));
    return leaf(cardsOk && banksOk && familiesOk, { code: 'card_product', message: 'Bu kart tipi kampanyaya dahil değil.' });
  }

  if (opts.cardOnly) return leaf(null); // aday ön-elemesi: yalnız kart koşulu değerlendirilir

  if (op === 'owns') {
    const cardsOk = !arg?.cards || asList(arg.cards).some(c => ctx.cards.has(c));
    const banksOk = !arg?.banks || asList(arg.banks).some(b => ctx.banks.has(b));
    const famMap = ctx.productFamilies || productFamilyMap(ctx.catalog);
    const familiesOk = !arg?.families || [...ctx.cards].some(c => asList(arg.families).some(f => famMap.get(c)?.has(f)));
    return leaf(cardsOk && banksOk && familiesOk, { code: 'ownership', message: 'Kampanya için gerekli kart/banka profilinde yok.' });
  }

  if (op === 'attr') {
    const dim = String(arg?.dim || '');
    const allowed = asList(arg?.in);
    if (!dim || !allowed.length) return leaf(false, { code: 'invalid_rule', message: 'attr düğümü dim ve in içermeli.' });
    const has = Object.prototype.hasOwnProperty.call(ctx.attributes, dim) && ctx.attributes[dim] != null;
    if (!has) return leaf(null, { code: 'segment', dim, message: 'Bu kart için segment seçilmemiş; segmente özel koşullar değerlendirilemedi (Profil › Müşteri Profili).' });
    const ok = allowed.includes(String(ctx.attributes[dim]));
    return leaf(ok, { code: 'segment', dim, message: `Kart segmenti uygun değil (${optionLabel(ctx, dim, ctx.attributes[dim])}).` });
  }

  if (op === 'legacySegmentLabel') {
    const labels = asList(arg?.in);
    if (!labels.length) return leaf(true);
    // Mümkünse etiketi kanonik özniteliğe çevir (kart + card_segment boyutu + engineLabel eşleşmesi).
    if (ctx.attributesKnown && ctx.catalog) {
      const mapped = mapLegacyLabelsToAttr(labels, card?.cardProductId, ctx.catalog);
      if (mapped) return evaluateRule({ attr: mapped }, ctx, card, opts);
    }
    // Eşleme yoksa / öznitelik bilgisi verilmemişse eski davranış: kartın segment etiketi.
    if (!card?.segment) return leaf(null, { code: 'segment', message: 'Bu kart için segment seçilmemiş; segmente özel koşullar değerlendirilemedi (Profil › Müşteri Profili).' });
    return leaf(labels.some(l => norm(l) === norm(card.segment)), { code: 'segment', message: `Kart segmenti uygun değil (${card.segmentLabel || card.segment}).` });
  }

  return leaf(false, { code: 'invalid_rule', message: `Bilinmeyen uygunluk düğümü: ${op}` });
}

function asArray(v) { return Array.isArray(v) ? v : []; }

// Eski segment etiketlerini, o kartı kapsayan card_segment boyutunun seçenek kodlarına çevirir.
// Tüm etiketler TEK bir boyutta eşleşmiyorsa null (belirsiz) → eski etiket karşılaştırmasına düşülür.
export function mapLegacyLabelsToAttr(labels, cardCode, catalog) {
  const dims = (catalog?.dimensions || []).filter(d => d.engineBinding === 'card_segment' && (d.cardCodes || []).includes(cardCode));
  for (const d of dims) {
    const codes = labels.map(l => d.options.find(o => norm(o.engineLabel || o.label) === norm(l))?.code);
    if (codes.length && codes.every(Boolean)) return { dim: d.code, in: [...new Set(codes)] };
  }
  return null;
}

// ------------------------------------------------------------------ katalog kaydı → kural
// Yeni kayıtlar `eligibilityRule` taşır; eskiler cardProductIds + eligibility.segmentLabels'tan uyumluluk kuralına çevrilir.
export function legacyEligibilityRule(campaign) {
  const parts = [{ payWith: { cards: asList(campaign?.cardProductIds) } }];
  const labels = campaign?.eligibility?.segmentLabels;
  if (Array.isArray(labels) && labels.length) parts.push({ legacySegmentLabel: { in: labels } });
  return { all: parts };
}

// ------------------------------------------------------------------ şema sürümü zorlaması (v1.4.2)
// Bir kayıt `eligibilityRule` veya `rewardVariants` ANAHTARINI taşıyorsa (değer null olsa bile) yeni şemayı kullanıyordur:
//   - `eligibilitySchemaVersion` tam sayı 1 OLMALI (eksik / "1" / 1.5 / 2 → geçersiz);
//   - kural ve varyantlar yapısal olarak geçerli OLMALI.
// Geçersizse kayıt KAPALI başarısız olur: hiçbir kart için uygun değildir ve eski alanlara (cardProductIds /
// segmentLabels) ASLA geri düşülmez. Yeni şema anahtarı yoksa eski uyumluluk adaptörü kullanılır.
// İstemci ana veri kodlarını bilmeden yalnız yapıyı doğrular; bilinmeyen kodlar zaten hiçbir kullanıcıyla eşleşmez.
// Katalog kalite kapısı (server/eligibility_schema.py) aynı kuralları + ana veri kodlarını uygular.
export const SUPPORTED_ELIGIBILITY_SCHEMA_VERSIONS = Object.freeze([1]);
const hasKey = (o, k) => o != null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);

export function usesEligibilitySchema(campaign) {
  return hasKey(campaign, 'eligibilityRule') || hasKey(campaign, 'rewardVariants');
}

// Tek doğruluk kaynağı: { status: 'legacy' | 'valid' | 'invalid', errors: [...], warnings: [...] }
export function validateCampaignEligibility(campaign, { catalog = null } = {}) {
  if (!usesEligibilitySchema(campaign)) return { status: 'legacy', errors: [], warnings: [] };
  const errors = [];
  const warnings = [];
  if (!hasKey(campaign, 'eligibilitySchemaVersion')) errors.push('eligibilitySchemaVersion: missing (required when eligibilityRule/rewardVariants is present)');
  else {
    const v = campaign.eligibilitySchemaVersion;
    if (typeof v !== 'number' || !Number.isInteger(v)) errors.push(`eligibilitySchemaVersion: malformed (${JSON.stringify(v)}); integer required`);
    else if (!SUPPORTED_ELIGIBILITY_SCHEMA_VERSIONS.includes(v)) errors.push(`eligibilitySchemaVersion: unsupported (${v}); supported: ${SUPPORTED_ELIGIBILITY_SCHEMA_VERSIONS.join(', ')}`);
  }
  if (errors.length) return { status: 'invalid', errors, warnings }; // sürüm bilinmiyorsa içerik yorumlanmaz
  if (hasKey(campaign, 'eligibilityRule')) {
    const r = checkEligibilityRule(campaign.eligibilityRule, { catalog, strict: true, path: '$.eligibilityRule' });
    errors.push(...r.errors); warnings.push(...r.warnings);
  }
  if (hasKey(campaign, 'rewardVariants')) {
    const vs = campaign.rewardVariants;
    if (!Array.isArray(vs) || !vs.length) errors.push('$.rewardVariants: non-empty array required');
    else vs.forEach((v, i) => {
      const p = `$.rewardVariants[${i}]`;
      if (!v || typeof v !== 'object' || Array.isArray(v)) { errors.push(`${p}: object required`); return; }
      if (!hasKey(v, 'when')) errors.push(`${p}.when: required`);
      else { const r = checkEligibilityRule(v.when, { catalog, strict: true, path: `${p}.when` }); errors.push(...r.errors); warnings.push(...r.warnings); }
      if (!v.rewardRule || typeof v.rewardRule !== 'object' || Array.isArray(v.rewardRule)) errors.push(`${p}.rewardRule: object required`);
    });
  }
  return { status: errors.length ? 'invalid' : 'valid', errors, warnings };
}

// Çalışma zamanı çözümlemesi (kampanya nesnesi başına önbellekli).
const RESOLVED = new WeakMap();
export function resolveCampaignEligibility(campaign) {
  if (campaign && typeof campaign === 'object' && RESOLVED.has(campaign)) return RESOLVED.get(campaign);
  const v = validateCampaignEligibility(campaign);
  const out = v.status === 'legacy' ? { status: 'legacy', rule: legacyEligibilityRule(campaign), errors: [] }
    : v.status === 'valid' ? { status: 'valid', rule: campaign.eligibilityRule ?? legacyEligibilityRule(campaign), errors: [] }
    : { status: 'invalid', rule: null, errors: v.errors };
  // rewardVariants tek başına (eligibilityRule anahtarı olmadan) geçerliyse uygunluk eski alanlardan gelir.
  if (campaign && typeof campaign === 'object') RESOLVED.set(campaign, out);
  return out;
}

const INVALID_REASON = errors => ({
  code: errors.some(e => e.startsWith('eligibilitySchemaVersion')) ? 'unsupported_schema' : 'invalid_rule',
  message: 'Kampanyanın uygunluk kuralı geçersiz veya desteklenmeyen şema sürümünde; güvenlik için uygun sayılmadı.',
});

// Geçersiz kayıt için null döner (çağıran asla null'u "kural yok = uygun" diye yorumlamamalı;
// evaluateCampaignForCard / campaignTargetsCard bunu kapalı başarısızlık olarak işler).
export function campaignEligibilityRule(campaign) {
  return resolveCampaignEligibility(campaign).rule;
}

// v1.5.0: tarayıcı her kayda kampanyanın KENDİ metninden/resmi yapısal verisinden çözülmüş kart uygunluğunu yazar
// (eligibilityResolution.state: resolved | partial | unresolved | needs_review). Çözülemeyen/çelişkili kayıt katalogda kalır
// ama hiçbir kart için kesin uygun DEĞİLDİR (kapalı başarısızlık; cardProductIds de zaten boştur).
export const UNRESOLVED_ELIGIBILITY_STATES = Object.freeze(['unresolved', 'needs_review']);
export function eligibilityUnresolved(campaign) {
  const st = campaign?.eligibilityResolution?.state;
  return UNRESOLVED_ELIGIBILITY_STATES.includes(st);
}
const UNRESOLVED_REASON = { code: 'eligibility_unresolved', message: 'Kampanyanın hangi kartlarda geçerli olduğu resmi metinde doğrulanamadı.' };

// Bir kampanyanın, kullanıcının BELİRLİ bir kartıyla yapılan işlem için uygunluğu.
export function evaluateCampaignForCard(campaign, card, ctx) {
  if (eligibilityUnresolved(campaign)) return { eligible: false, value: false, reasons: [UNRESOLVED_REASON] };
  const res = resolveCampaignEligibility(campaign);
  if (res.status === 'invalid') return { eligible: false, value: false, reasons: [INVALID_REASON(res.errors)] };
  const r = evaluateRule(res.rule, ctx || buildEligibilityContext({ cards: card ? [card] : [] }), card);
  return { eligible: r.value === true, value: r.value, reasons: dedupeReasons(r.reasons) };
}

// Aday ön-elemesi: kart koşulu bu kartı kesin dışlamıyorsa kampanya bu kart için değerlendirilir.
export function campaignTargetsCard(campaign, card, ctx) {
  if (eligibilityUnresolved(campaign)) return false;
  const res = resolveCampaignEligibility(campaign);
  if (res.status === 'invalid') return false;
  const r = evaluateRule(res.rule, ctx || buildEligibilityContext({ cards: card ? [card] : [] }), card, { cardOnly: true });
  return r.value !== false;
}

// ------------------------------------------------------------------ rewardVariants seçimi (v1.4.2: tanım + test; motora henüz bağlı değil)
// Varyantlar SIRAYLA değerlendirilir; yazar en özel / en değerli varyantı başa koyar.
//   when = true  → GERÇEK (actual) varyant; tarama durur (ilk eşleşen kazanır).
//   when = false → atlanır.
//   when = null  → gerçek SAYILMAZ; "koşullu/potansiyel" listesine eklenir ve taramaya devam edilir.
// Bilinmeyen öznitelik asla gerçek tutarı yükseltmez. `{always:true}` varyantı garantili tabanı verir.
// rewardVariants varken kampanyanın taban `rewardRule`'u örtük yedek DEĞİLDİR: garantili taban yalnız açık bir
// `always` (veya kesin true) varyantından gelir. Hiçbiri true değilse gerçek ödül yoktur (actual = null).
export function selectRewardVariant(variants, ctx, card) {
  const conditional = [];
  const list = Array.isArray(variants) ? variants : [];
  for (let index = 0; index < list.length; index += 1) {
    const variant = list[index];
    // Savunmacı: koşulu olmayan/null varyant asla koşulsuz sayılmaz (doğrulanmış kayıtta zaten olmaz).
    if (variant?.when == null) continue;
    const r = evaluateRule(variant.when, ctx, card);
    if (r.value === true) return { status: 'actual', actual: { index, variant }, conditional };
    if (r.value === null) conditional.push({ index, variant, reasons: dedupeReasons(r.reasons) });
  }
  return { status: conditional.length ? 'conditional_only' : 'none', actual: null, conditional };
}

// Uygunluk ve ödül kademesi AYRI kararlardır: önce kampanya uygunluğu, sonra kademe.
//   ineligible           → kampanya bu kart/profil için kesin uygun değil (ödül yok, koşullu bilgi yok)
//   eligibility_unknown  → uygunluk bilinmiyor; gerçek ödül YOK, false olmayan varyantlar yalnız koşullu bilgi
//   actual / conditional_only / none → uygun; selectRewardVariant sonucu
//   legacy               → rewardVariants yok; mevcut motor (rewardRule/segmentRules) karar verir
export function resolveCampaignReward(campaign, card, ctx) {
  const eligibility = evaluateCampaignForCard(campaign, card, ctx);
  if (eligibility.value === false) return { status: 'ineligible', eligibility, actual: null, conditional: [] };
  if (!hasKey(campaign, 'rewardVariants')) return { status: 'legacy', eligibility, actual: null, conditional: [] };
  const sel = selectRewardVariant(campaign.rewardVariants, ctx, card);
  if (eligibility.value === null) {
    const conditional = [...(sel.actual ? [{ ...sel.actual, reasons: [] }] : []), ...sel.conditional].sort((a, b) => a.index - b.index);
    return { status: 'eligibility_unknown', eligibility, actual: null, conditional };
  }
  return { ...sel, eligibility };
}

// ------------------------------------------------------------------ GERÇEK vs VARSAYIMSAL bağlam (v1.4.2)
// Normal Hangi Kart? YALNIZ gerçek bağlamı kullanır (mode 'actual'): kullanıcının kayıtlı profili + sahip olduğu kartlar.
// Gelecekteki Keşfet ("bu kartı alsam / segmentim şu olsa") aynı kural sistemini GEÇİCİ bir katmanla kullanabilir:
// withHypotheticalOverlay yeni bir bağlam döner, girdi bağlamı ve kalıcı profil DEĞİŞMEZ; sonuç 'hypothetical' işaretlidir.
export function withHypotheticalOverlay(ctx, { cards = [], banks = [], attributes = {} } = {}) {
  const base = ctx || buildEligibilityContext({});
  const cardCodes = cards.map(c => (typeof c === 'string' ? c : c?.cardProductId)).filter(Boolean);
  const derivedBanks = cardCodes.map(c => base.cardBank?.get(c)).filter(Boolean);
  return {
    ...base,
    mode: 'hypothetical',
    cards: new Set([...base.cards, ...cardCodes]),
    banks: new Set([...base.banks, ...banks.map(String), ...derivedBanks]),
    attributes: { ...base.attributes, ...attributes },
    attributesKnown: true,
    overlay: Object.freeze({ cards: [...cardCodes], banks: [...banks], attributes: { ...attributes } }),
  };
}

function dedupeReasons(reasons) {
  const seen = new Set();
  return reasons.filter(r => { const k = `${r.code}|${r.message}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

// ------------------------------------------------------------------ doğrulama (katalog kalite kapısı / testler)
const NODE_KEYS = new Set(['all', 'any', 'not', 'payWith', 'owns', 'attr', 'always', 'legacySegmentLabel']);
const CODE = /^[a-z0-9][a-z0-9_-]*$/;

// validateEligibilityRule: tüm sorunlar hata (geriye uyumlu imza).
export function validateEligibilityRule(rule, { catalog = null, path = '$' } = {}) {
  const r = checkEligibilityRule(rule, { catalog, path, strict: false });
  return [...r.errors, ...r.warnings];
}

// checkEligibilityRule: catalog verilirse bilinmeyen boyut/seçenek HATA; bilinmeyen kart ürünü/banka UYARI
// (ana veride henüz olmayan ürün — ör. qnb-fix — hiçbir kullanıcıyla eşleşmez, etkisizdir).
// strict: yayınlanan katalog kuralları; legacySegmentLabel (yalnız uyumluluk adaptörü üretir) reddedilir.
export function checkEligibilityRule(rule, { catalog = null, path = '$', strict = false } = {}) {
  const errors = [];
  const warnings = [];
  const walk = (node, p, depth) => {
    if (depth > 12) { errors.push(`${p}: too deep`); return; }
    if (!node || typeof node !== 'object' || Array.isArray(node)) { errors.push(`${p}: node must be an object`); return; }
    const keys = Object.keys(node);
    if (keys.length !== 1 || !NODE_KEYS.has(keys[0])) { errors.push(`${p}: exactly one of ${[...NODE_KEYS].join(', ')}`); return; }
    const [op] = keys; const arg = node[op];
    if (op === 'all' || op === 'any') {
      if (!Array.isArray(arg) || !arg.length) errors.push(`${p}.${op}: non-empty array required`);
      else arg.forEach((r, i) => walk(r, `${p}.${op}[${i}]`, depth + 1));
    } else if (op === 'not') walk(arg, `${p}.not`, depth + 1);
    else if (op === 'always') { if (arg !== true) errors.push(`${p}.always: must be true`); }
    else if (op === 'payWith' || op === 'owns') {
      if (!arg || typeof arg !== 'object' || Array.isArray(arg) || (!hasKey(arg, 'cards') && !hasKey(arg, 'banks') && !hasKey(arg, 'families'))) { errors.push(`${p}.${op}: cards, banks and/or families required`); return; }
      const extra = Object.keys(arg).filter(k => k !== 'cards' && k !== 'banks' && k !== 'families');
      if (extra.length) errors.push(`${p}.${op}: unknown key(s) ${extra.join(', ')}`);
      for (const k of ['cards', 'banks', 'families']) if (hasKey(arg, k)) {
        if (!Array.isArray(arg[k]) || !arg[k].length || !arg[k].every(v => typeof v === 'string' && CODE.test(v))) { errors.push(`${p}.${op}.${k}: non-empty array of codes`); continue; }
        if (catalog && k === 'cards') for (const c of arg[k]) if (!catalog.cardProducts.some(x => x.code === c)) warnings.push(`${p}.${op}.cards: unknown card product ${c}`);
        if (catalog && k === 'banks') for (const b of arg[k]) if (!catalog.banks.some(x => x.code === b)) warnings.push(`${p}.${op}.banks: unknown bank ${b}`);
        if (catalog && k === 'families') for (const f of arg[k]) if (!(catalog.cardFamilies || CARD_ELIGIBILITY_FAMILIES).some(x => x.code === f)) warnings.push(`${p}.${op}.families: unknown card family ${f}`);
      }
    } else if (op === 'attr') {
      if (!arg || typeof arg !== 'object' || Array.isArray(arg) || typeof arg.dim !== 'string' || !CODE.test(arg.dim) || !Array.isArray(arg.in) || !arg.in.length || !arg.in.every(v => typeof v === 'string' && CODE.test(v))
        || Object.keys(arg).some(k => k !== 'dim' && k !== 'in')) errors.push(`${p}.attr: { dim: code, in: [codes] } required`);
      else if (catalog) {
        const d = catalog.dimensions.find(x => x.code === arg.dim);
        if (!d) errors.push(`${p}.attr: unknown dimension ${arg.dim}`);
        else for (const o of arg.in) if (!d.options.some(x => x.code === o)) errors.push(`${p}.attr: unknown option ${arg.dim}.${o}`);
      }
    } else if (op === 'legacySegmentLabel') {
      if (strict) errors.push(`${p}.legacySegmentLabel: compatibility-only node; not allowed in published rules`);
      else if (!arg || !Array.isArray(arg.in)) errors.push(`${p}.legacySegmentLabel: { in: [labels] } required`);
    }
  };
  walk(rule, path, 0);
  return { errors, warnings };
}
