// v1.4.3 — Tarihli/kaynaklı seçenek ölçütleri ve kullanıcı onayının güncelliği (saf fonksiyonlar).
//
// Kimlik ≠ ölçüt: `maximiles_band = band_2` kalıcı bir seçimdir; "1–4 milyon TL" ise o bandın BELİRLİ BİR ölçüt
// sürümündeki tanımıdır. Banka eşikleri değişince yeni ölçüt sürümü eklenir; kullanıcının eski onayı sessizce
// güncel gerçek kabul EDİLMEZ — yeniden onay istenir ve o zamana kadar seçim karar motorunda "bilinmiyor" sayılır
// (bilinmeyen asla tutarı yükseltmez / uygunluk vermez).
//
// Onay durumu (attributeConfirmationStatus):
//   not_versioned        boyutun hiç ölçüt kaydı yok (ör. teb_tier) → seçim olduğu gibi geçerli
//   unset                seçim yok ("Bilmiyorum")
//   confirmed            onay, bugünkü güncel ölçüt sürümünde verilmiş → geçerli
//   unconfirmed          seçim var ama hangi ölçüt sürümünde onaylandığı bilinmiyor → yeniden onay gerekir
//   stale                onay eski bir ölçüt sürümünde verilmiş (veya seçenek güncel sürümde tanımlı değil) → yeniden onay
//   criteria_unavailable bugün yürürlükte ölçüt yok / belirsiz (çakışan sürümler) → yeniden onaylanamaz, bilinmiyor sayılır
//
// NOT: Bu dosyadaki onay durumu KULLANICI onayıdır (user_profile_attributes.criteria_version + confirmed_at).
// Ölçüt satırının `verifiedAt`'i ise GLOBAL ana verinin kaynak doğrulamasıdır (güven/tazelik). İkisi ayrı kavramlardır;
// biri diğerinin yerine geçmez. İleride banka kapsama modeli için kaynak durumu (verified / last-known / stale /
// unverified) ayrıca modellenecek; kullanıcı onayından türetilmeyecek.
import { trDay } from './tr-time.js';

export const REQUIRES_RECONFIRMATION = new Set(['unconfirmed', 'stale']);
const USABLE = new Set(['not_versioned', 'confirmed']);

const dayOf = now => (typeof now === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(now) ? now : trDay(now instanceof Date ? now : new Date(now ?? Date.now())));

export function criteriaRows(catalog, dimensionCode) {
  return (catalog?.optionCriteria || []).filter(r => r.dimensionCode === dimensionCode);
}

export function isVersionedDimension(catalog, dimensionCode) {
  return criteriaRows(catalog, dimensionCode).length > 0;
}

const inForce = (r, day) => String(r.effectiveFrom) <= day && (r.effectiveTo == null || day < String(r.effectiveTo));

// Bugün yürürlükteki TEK ölçüt sürümü; yoksa veya birden fazla sürüm çakışıyorsa null.
export function currentCriteriaVersion(catalog, dimensionCode, now = new Date()) {
  const day = dayOf(now);
  const versions = [...new Set(criteriaRows(catalog, dimensionCode).filter(r => inForce(r, day)).map(r => r.criteriaVersion))];
  return versions.length === 1 ? versions[0] : null;
}

export function criteriaFor(catalog, dimensionCode, optionCode, criteriaVersion) {
  return criteriaRows(catalog, dimensionCode).find(r => r.optionCode === optionCode && r.criteriaVersion === criteriaVersion) || null;
}

export function currentCriteria(catalog, dimensionCode, optionCode, now = new Date()) {
  const v = currentCriteriaVersion(catalog, dimensionCode, now);
  return v ? criteriaFor(catalog, dimensionCode, optionCode, v) : null;
}

// Kullanıcıya gösterilecek etiket: güncel ölçüt etiketi; yoksa seçeneğin nötr adı.
export function optionDisplayLabel(catalog, dimensionCode, optionCode, now = new Date()) {
  const crit = currentCriteria(catalog, dimensionCode, optionCode, now);
  if (crit?.displayLabel) return crit.displayLabel;
  const dim = (catalog?.dimensions || []).find(d => d.code === dimensionCode);
  return dim?.options?.find(o => o.code === optionCode)?.label || optionCode;
}

export function attributeConfirmationStatus(profile, catalog, dimensionCode, now = new Date()) {
  const option = profile?.attributes?.[dimensionCode];
  if (option == null) return { status: 'unset', option: null };
  if (!isVersionedDimension(catalog, dimensionCode)) return { status: 'not_versioned', option };
  const currentVersion = currentCriteriaVersion(catalog, dimensionCode, now);
  const confirmation = profile?.attributeConfirmations?.[dimensionCode] || null;
  const confirmedVersion = confirmation?.criteriaVersion ?? null;
  const base = { option, currentVersion, confirmedVersion, confirmedAt: confirmation?.confirmedAt ?? null };
  if (!currentVersion) return { ...base, status: 'criteria_unavailable' };
  if (!confirmedVersion) return { ...base, status: 'unconfirmed' };
  if (confirmedVersion !== currentVersion || !criteriaFor(catalog, dimensionCode, option, currentVersion)) return { ...base, status: 'stale' };
  return { ...base, status: 'confirmed' };
}

export function isUsableStatus(status) { return USABLE.has(status); }

// Karar motoruna giden öznitelikler: yalnız güncel olarak geçerli seçimler. Kalıcı profil DEĞİŞMEZ.
export function effectiveAttributes(profile, catalog, now = new Date()) {
  const out = {};
  for (const dim of Object.keys(profile?.attributes || {})) {
    if (isUsableStatus(attributeConfirmationStatus(profile, catalog, dim, now).status)) out[dim] = profile.attributes[dim];
  }
  return out;
}

// Yeniden onay gerektiren / geçici olarak kullanılamayan seçimler (UI uyarısı için).
export function attributesNeedingAttention(profile, catalog, now = new Date()) {
  return Object.keys(profile?.attributes || {})
    .map(dim => ({ dim, ...attributeConfirmationStatus(profile, catalog, dim, now) }))
    .filter(x => !isUsableStatus(x.status) && x.status !== 'unset');
}

// Profilin bugünkü ölçütlere göre "etkin" kopyası (engine/uygunluk için). Onay bilgisi taşınır; hiçbir şey yazılmaz.
export function effectiveProfile(profile, catalog, now = new Date()) {
  if (!profile) return profile;
  return { ...profile, attributes: effectiveAttributes(profile, catalog, now) };
}

// Ana veri tutarlılığı (test + guard benzeri): her sürümde boyutun tüm seçenekleri tanımlı, aynı sürümün satırları
// aynı tarih aralığına sahip, aynı gün iki sürüm yürürlükte değil.
export function validateOptionCriteria(catalog) {
  const errors = [];
  const byDim = new Map();
  for (const r of catalog?.optionCriteria || []) {
    const dim = (catalog.dimensions || []).find(d => d.code === r.dimensionCode);
    if (!dim) { errors.push(`${r.dimensionCode}: unknown dimension`); continue; }
    if (!dim.options.some(o => o.code === r.optionCode)) errors.push(`${r.dimensionCode}.${r.optionCode}: unknown option`);
    for (const k of ['criteriaVersion', 'effectiveFrom', 'displayLabel', 'sourceUrl']) if (!r[k]) errors.push(`${r.dimensionCode}.${r.optionCode}: ${k} required`);
    if (r.effectiveTo != null && !(String(r.effectiveTo) > String(r.effectiveFrom))) errors.push(`${r.dimensionCode}.${r.optionCode}@${r.criteriaVersion}: effectiveTo must be after effectiveFrom`);
    if (r.lowerBound != null && r.upperBound != null && !(Number(r.upperBound) > Number(r.lowerBound))) errors.push(`${r.dimensionCode}.${r.optionCode}@${r.criteriaVersion}: upperBound must exceed lowerBound`);
    const versions = byDim.get(r.dimensionCode) || new Map(); byDim.set(r.dimensionCode, versions);
    const v = versions.get(r.criteriaVersion) || []; v.push(r); versions.set(r.criteriaVersion, v);
  }
  for (const [dimCode, versions] of byDim) {
    const dim = catalog.dimensions.find(d => d.code === dimCode);
    const ranges = [];
    for (const [ver, rows] of versions) {
      const codes = new Set(rows.map(r => r.optionCode));
      for (const o of dim?.options || []) if (o.active !== false && !codes.has(o.code)) errors.push(`${dimCode}@${ver}: option ${o.code} has no definition`);
      if (codes.size !== rows.length) errors.push(`${dimCode}@${ver}: duplicate option rows`);
      const spans = new Set(rows.map(r => `${r.effectiveFrom}|${r.effectiveTo ?? ''}`));
      if (spans.size !== 1) errors.push(`${dimCode}@${ver}: rows of one version must share effectiveFrom/effectiveTo`);
      ranges.push({ ver, from: String(rows[0].effectiveFrom), to: rows[0].effectiveTo == null ? null : String(rows[0].effectiveTo) });
    }
    for (let i = 0; i < ranges.length; i += 1) for (let j = i + 1; j < ranges.length; j += 1) {
      const a = ranges[i]; const b = ranges[j];
      const overlap = (a.to == null || b.from < a.to) && (b.to == null || a.from < b.to);
      if (overlap) errors.push(`${dimCode}: versions ${a.ver} and ${b.ver} overlap`);
    }
  }
  return errors;
}
