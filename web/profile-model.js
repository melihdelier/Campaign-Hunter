// v1.4 — Kişisel profil modeli (saf fonksiyonlar, DOM/ağ yok).
// Profil = kullanıcı verisi: seçili bankalar, sahip olunan kartlar, profil öznitelikleri (segment/statü/tier…), tercihler.
// Ana veri (bankalar, kart ürünleri, boyutlar) `catalog` parametresiyle gelir; kişisel portföy KOD İÇİNE GÖMÜLMEZ.
// v1.4.3: attributeConfirmations[dim] = { criteriaVersion, confirmedAt } — seçimin hangi ölçüt sürümünde onaylandığı.
// Karar motoruna giden kartlar/ayarlar YALNIZ bugün geçerli (onayı güncel) seçimleri kullanır (profile-criteria.js).
import { currentCriteriaVersion, effectiveAttributes, attributeConfirmationStatus, optionDisplayLabel } from './profile-criteria.js';
import { normalizeLegacyAttributes, normalizeLegacySettings } from './legacy-option-aliases.js';

const isoNow = now => (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString();

export function emptyProfile() {
  return { banks: [], cards: [], attributes: {}, attributeConfirmations: {}, preferences: {}, displayName: null, onboardingCompletedAt: null };
}

const uniq = arr => [...new Set(arr)];
const byCode = list => new Map((list || []).map(x => [x.code, x]));

export function catalogIndex(catalog) {
  return {
    banks: byCode(catalog.banks),
    cards: byCode(catalog.cardProducts),
    dims: byCode(catalog.dimensions),
  };
}

// Kullanıcının bankalarına/kartlarına göre sorulması gereken boyutlar.
export function applicableDimensions(profile, catalog) {
  const cards = new Set(profile.cards || []);
  const banks = new Set(profile.banks || []);
  return (catalog.dimensions || [])
    .filter(d => d.active !== false)
    .filter(d => {
      if ((d.cardCodes || []).length) return d.cardCodes.some(c => cards.has(c));
      if (d.bankCode) return banks.has(d.bankCode);
      return true; // bankadan ve karttan bağımsız genel program
    })
    .sort((a, b) => (a.sortOrder ?? 100) - (b.sortOrder ?? 100));
}

// Tutarlılık: bilinmeyen kodları at, bankası seçilmemiş kartı at, geçersiz/uygulanamaz öznitelikleri at.
export function normalizeProfile(input, catalog) {
  const idx = catalogIndex(catalog);
  const p = { ...emptyProfile(), ...(input || {}) };
  const banks = uniq((p.banks || []).filter(b => idx.banks.has(b)));
  const bankSet = new Set(banks);
  const cards = uniq((p.cards || []).filter(c => idx.cards.has(c) && bankSet.has(idx.cards.get(c).bankCode)));
  const draft = { ...p, banks, cards };
  const applicable = new Set(applicableDimensions(draft, catalog).map(d => d.code));
  const legacy = normalizeLegacyAttributes(p.attributes || {}, p.attributeConfirmations || {});
  const attributes = {};
  const attributeConfirmations = {};
  for (const [dim, opt] of Object.entries(legacy.attributes)) {
    const d = idx.dims.get(dim);
    if (!d || !applicable.has(dim) || opt == null) continue;
    if (!(d.options || []).some(o => o.code === opt && o.active !== false)) continue;
    attributes[dim] = opt;
    const c = legacy.attributeConfirmations[dim];
    if (c && typeof c === 'object') attributeConfirmations[dim] = { criteriaVersion: c.criteriaVersion ?? null, confirmedAt: c.confirmedAt ?? null };
  }
  return { ...draft, attributes, attributeConfirmations, preferences: { ...(p.preferences || {}) } };
}

export function toggleBank(profile, bankCode, on, catalog) {
  const banks = on ? uniq([...(profile.banks || []), bankCode]) : (profile.banks || []).filter(b => b !== bankCode);
  return normalizeProfile({ ...profile, banks }, catalog); // kapatılan bankanın kartları ve bağlı öznitelikleri düşer
}

export function toggleCard(profile, cardCode, on, catalog) {
  const card = catalogIndex(catalog).cards.get(cardCode);
  if (!card) return normalizeProfile(profile, catalog);
  const banks = on ? uniq([...(profile.banks || []), card.bankCode]) : (profile.banks || []);
  const cards = on ? uniq([...(profile.cards || []), cardCode]) : (profile.cards || []).filter(c => c !== cardCode);
  return normalizeProfile({ ...profile, banks, cards }, catalog);
}

// Kullanıcı bir seçeneği seçtiğinde: seçim + BUGÜNKÜ ölçüt sürümünde onay (boyut sürümlü değilse criteriaVersion null).
export function setAttribute(profile, dimensionCode, optionCode, catalog, { now = new Date() } = {}) {
  const attributes = { ...(profile.attributes || {}) };
  const attributeConfirmations = { ...(profile.attributeConfirmations || {}) };
  if (optionCode == null || optionCode === '') { delete attributes[dimensionCode]; delete attributeConfirmations[dimensionCode]; }
  else {
    attributes[dimensionCode] = optionCode;
    attributeConfirmations[dimensionCode] = { criteriaVersion: currentCriteriaVersion(catalog, dimensionCode, now), confirmedAt: isoNow(now) };
  }
  return normalizeProfile({ ...profile, attributes, attributeConfirmations }, catalog);
}

// "Hâlâ bu banttayım": aynı seçimi güncel ölçüt sürümünde yeniden onaylar. Yürürlükte ölçüt yoksa değişiklik yapmaz.
export function confirmAttribute(profile, dimensionCode, catalog, { now = new Date() } = {}) {
  const opt = profile?.attributes?.[dimensionCode];
  if (opt == null) return normalizeProfile(profile, catalog);
  const version = currentCriteriaVersion(catalog, dimensionCode, now);
  if (!version && attributeConfirmationStatus(profile, catalog, dimensionCode, now).status === 'criteria_unavailable') return normalizeProfile(profile, catalog);
  return setAttribute(profile, dimensionCode, opt, catalog, { now });
}

// Onboarding sonunda kullanıcı inceleme ekranında gördüğü (güncel etiketli) seçimleri onaylamış olur.
// YALNIZ hiç onayı olmayan seçimler onaylanır; eski sürümde onaylanmış (stale) seçim burada sessizce yenilenmez.
export function confirmPendingAttributes(profile, catalog, { now = new Date() } = {}) {
  let p = normalizeProfile(profile, catalog);
  for (const dim of Object.keys(p.attributes)) {
    if (attributeConfirmationStatus(p, catalog, dim, now).status === 'unconfirmed') p = confirmAttribute(p, dim, catalog, { now });
  }
  return p;
}

export function isProfileComplete(profile) {
  return Boolean(profile && profile.onboardingCompletedAt);
}

export function canCompleteOnboarding(profile) {
  return (profile?.cards || []).length > 0;
}

// Karar motoruna giden kart listesi: YALNIZ kullanıcının sahip olduğu kartlar.
export function profileToEngineCards(profile, catalog, { now = new Date() } = {}) {
  const idx = catalogIndex(catalog);
  const raw = normalizeProfile(profile, catalog);
  // Yeniden onay bekleyen / ölçütü bilinmeyen seçimler bugün için "bilinmiyor" sayılır.
  const p = { ...raw, attributes: effectiveAttributes(raw, catalog, now) };
  const dims = applicableDimensions(p, catalog);
  return p.cards.map(code => {
    const product = idx.cards.get(code);
    const bank = idx.banks.get(product.bankCode);
    let segment = null;
    let segmentLabel = null;
    let cardType;
    // Kartı kapsayan TÜM boyutların seçimleri (kanonik, boyut koduyla). Uygunluk bunları okur; birleştirilmiş metin yok.
    const profileAttributes = {};
    for (const d of dims) {
      if (!(d.cardCodes || []).includes(code)) continue;
      if (p.attributes[d.code] != null) profileAttributes[d.code] = p.attributes[d.code];
      const opt = (d.options || []).find(o => o.code === p.attributes[d.code]);
      // card.segment / card.cardType yalnız mevcut ödül/çekirdek ayrıcalık mantığı için geriye uyumluluk alanlarıdır.
      // eligibility_only boyutları bu alanlara ASLA yazılmaz.
      if (d.engineBinding === 'card_segment' && opt) { segment = opt.engineLabel || opt.label; segmentLabel = optionDisplayLabel(catalog, d.code, opt.code, now); }
      if (d.engineBinding === 'card_type') cardType = opt ? (opt.engineLabel || opt.code) : undefined;
    }
    const card = { id: `uc-${code}`, bank: bank?.name || product.bankCode, bankCode: product.bankCode, name: product.name, segment, segmentLabel, cardProductId: code, active: true, profileAttributes };
    if (cardType) card.cardType = cardType;
    return card;
  });
}

// Mevcut kazanım formüllerinin (loyalty.js) okuduğu ayarlar. Seçilmemiş = null (oran uydurulmaz).
export function profileToLegacySettings(profile, catalog, { now = new Date() } = {}) {
  const p = normalizeProfile(profile, catalog);
  const attrs = effectiveAttributes(p, catalog, now);
  const out = {};
  for (const d of catalog.dimensions || []) {
    if (!d.settingKey) continue;
    out[d.settingKey] = attrs[d.code] ?? null;
  }
  return out;
}

// Eski tek-kullanıcı verisinden (ayarlar + kartlar) profil ÖN-DOLDURMA önerisi. Asla otomatik tamamlanmaz;
// kullanıcı onboarding'de görür ve onaylar.
export function legacyToProfilePrefill({ settings = {}, cards = [] } = {}, catalog) {
  const idx = catalogIndex(catalog);
  const cardCodes = uniq((cards || []).filter(c => c && c.active !== false && idx.cards.has(c.cardProductId)).map(c => c.cardProductId));
  const banks = uniq(cardCodes.map(c => idx.cards.get(c).bankCode));
  const attributes = {};
  settings = normalizeLegacySettings(settings) || {};
  for (const d of catalog.dimensions || []) {
    const v = d.settingKey ? settings[d.settingKey] : undefined;
    if (v != null) attributes[d.code] = v;
  }
  return normalizeProfile({ banks, cards: cardCodes, attributes, onboardingCompletedAt: null }, catalog);
}

// Sunucuya uygulanacak fark (satır bazlı, idempotent).
export function diffProfiles(before, after) {
  const b = before || emptyProfile();
  const a = after || emptyProfile();
  const minus = (x, y) => (x || []).filter(v => !(y || []).includes(v));
  const conf = (p, k) => (p.attributeConfirmations || {})[k] || {};
  const confChanged = k => (conf(a, k).criteriaVersion ?? null) !== (conf(b, k).criteriaVersion ?? null) || (conf(a, k).confirmedAt ?? null) !== (conf(b, k).confirmedAt ?? null);
  // [boyut, seçenek, onay] — seçim veya onayı (ölçüt sürümü / zamanı) değişen satırlar yazılır.
  const attrsUpsert = Object.entries(a.attributes || {}).filter(([k, v]) => (b.attributes || {})[k] !== v || confChanged(k))
    .map(([k, v]) => [k, v, { criteriaVersion: conf(a, k).criteriaVersion ?? null, confirmedAt: conf(a, k).confirmedAt ?? null }]);
  const attrsRemove = Object.keys(b.attributes || {}).filter(k => !(k in (a.attributes || {})));
  return {
    banksAdd: minus(a.banks, b.banks),
    banksRemove: minus(b.banks, a.banks),
    cardsAdd: minus(a.cards, b.cards),
    cardsRemove: minus(b.cards, a.cards),
    attrsUpsert,
    attrsRemove,
    prefsChanged: JSON.stringify(a.preferences || {}) !== JSON.stringify(b.preferences || {}),
    profileChanged: (a.displayName ?? null) !== (b.displayName ?? null) || (a.onboardingCompletedAt ?? null) !== (b.onboardingCompletedAt ?? null),
  };
}

// Segment/statü değişince kalan-limit doğrulamasını sıfırlanacak bankalar (banka adlarıyla; motor banka adı kullanır).
export function banksAffectedByAttributeChange(before, after, catalog) {
  const idx = catalogIndex(catalog);
  const changed = new Set([...Object.keys(before?.attributes || {}), ...Object.keys(after?.attributes || {})]
    .filter(k => (before?.attributes || {})[k] !== (after?.attributes || {})[k]));
  const banks = new Set();
  for (const code of changed) {
    const d = idx.dims.get(code);
    if (!d || d.engineBinding === 'loyalty') continue;
    const bankCode = d.bankCode || idx.cards.get((d.cardCodes || [])[0])?.bankCode;
    if (bankCode && idx.banks.get(bankCode)) banks.add(idx.banks.get(bankCode).name);
  }
  return [...banks];
}

export const ONBOARDING_STEPS = ['banks', 'cards', 'attributes', 'review'];

export function nextOnboardingStep(step, profile, catalog) {
  const i = ONBOARDING_STEPS.indexOf(step);
  if (step === 'banks' && !(profile.banks || []).length) return { step, error: 'En az bir banka seç.' };
  if (step === 'cards' && !(profile.cards || []).length) return { step, error: 'En az bir kart seç.' };
  let next = ONBOARDING_STEPS[Math.min(i + 1, ONBOARDING_STEPS.length - 1)];
  if (next === 'attributes' && !applicableDimensions(profile, catalog).length) next = 'review';
  return { step: next, error: null };
}

export function previousOnboardingStep(step, profile, catalog) {
  const i = ONBOARDING_STEPS.indexOf(step);
  let prev = ONBOARDING_STEPS[Math.max(i - 1, 0)];
  if (prev === 'attributes' && !applicableDimensions(profile, catalog).length) prev = 'cards';
  return prev;
}
