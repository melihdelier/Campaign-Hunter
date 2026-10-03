// v1.4.3 — ESKİ eşik kodlu seçenek kimliklerinin TEK GİRİŞ DÖNÜŞÜM noktası.
//
// v1.4.2 ve öncesi Maximiles/Crystal varlık bantlarını eşik içeren kodlarla saklıyordu. Kanonik kimlik artık nötr ve
// boyuta özeldir (band_1 …). Bu modül YALNIZ zaten var olan eski veriyi okurken kullanılır:
//   - cihazdaki eski tek-kullanıcı ayarları (localStorage / user_app_state.settings)
//   - cihazdaki v1.4.x profil önbelleği
//   - yayında kalmış eski katalog kayıtları (segmentLabels / segmentRules eski bant ETİKETLERİYLE anahtarlı)
// Yeni hiçbir veri eski kimliklerle YAZILMAZ. Sunucudaki karşılığı supabase/migrations/010_option_criteria.sql'dir.
// Kaldırma planı: eski katalog anlık görüntüleri ve cihaz verisi dönüştükten bir kararlı sürüm sonra (bkz. docs/ELIGIBILITY_SCHEMA_v1.md §6).
// Bir test (test-option-criteria.mjs) eski kimliklerin bu modül, migration geçmişi ve testler dışında geçmediğini doğrular.

export const LEGACY_OPTION_CODE_ALIASES = Object.freeze({
  maximiles_band: Object.freeze({ under_1m: 'band_1', '1m_4m': 'band_2', '4m_8m': 'band_3', '8m_plus': 'band_4' }),
  crystal_band: Object.freeze({ under_1m: 'band_1', '1m_6m': 'band_2', '6m_10m': 'band_3', '10m_plus': 'band_4' }),
});

// Eski seçim, kullanıcıya gösterilen eski etiketlerle yapılmıştı; bu etiketlerin eşikleri ölçüt sürümü v1 ile aynıdır.
// Bu yüzden dönüştürülen seçim v1 altında onaylanmış sayılır (onay zamanı bilinmiyor → confirmedAt null).
// Ölçüt değişirse (v2) bu seçimler de diğerleri gibi "yeniden onay" durumuna düşer.
export const LEGACY_ALIAS_CRITERIA_VERSION = Object.freeze({ maximiles_band: 'v1', crystal_band: 'v1' });

const SETTING_KEY_DIMENSION = Object.freeze({ maximilesBand: 'maximiles_band', crystalBand: 'crystal_band' });

// Eski katalog kayıtlarında segmentLabels/segmentRules anahtarları (kart ürünü başına).
export const LEGACY_SEGMENT_LABEL_ALIASES = Object.freeze({
  'is-maximiles-black': Object.freeze({ '1 milyon TL altı': 'band_1', '1–4 milyon TL': 'band_2', '4–8 milyon TL': 'band_3', '8 milyon TL+': 'band_4' }),
  'ykb-crystal': Object.freeze({ '1 milyon TL altı': 'band_1', '1–6 milyon TL': 'band_2', '6–10 milyon TL': 'band_3', '10 milyon TL+': 'band_4' }),
});

export function migrateLegacyOptionCode(dimensionCode, optionCode) {
  const map = LEGACY_OPTION_CODE_ALIASES[dimensionCode];
  return map && Object.prototype.hasOwnProperty.call(map, optionCode) ? map[optionCode] : optionCode;
}

// Eski ayar nesnesi → aynı anlamda yeni kodlar. Diğer anahtarlar dokunulmaz; girdi değişmez.
export function normalizeLegacySettings(settings) {
  if (!settings || typeof settings !== 'object') return settings;
  let out = settings;
  for (const [key, dim] of Object.entries(SETTING_KEY_DIMENSION)) {
    const v = settings[key];
    if (v == null) continue;
    const next = migrateLegacyOptionCode(dim, v);
    if (next !== v) { if (out === settings) out = { ...settings }; out[key] = next; }
  }
  return out;
}

// Profil öznitelikleri + onaylar. Dönüştürülen ve onayı olmayan seçimlere v1 onayı (confirmedAt null) yazılır.
export function normalizeLegacyAttributes(attributes = {}, confirmations = {}) {
  const outAttrs = { ...(attributes || {}) };
  const outConf = { ...(confirmations || {}) };
  const migrated = [];
  for (const [dim, opt] of Object.entries(attributes || {})) {
    const next = migrateLegacyOptionCode(dim, opt);
    if (next === opt) continue;
    outAttrs[dim] = next;
    migrated.push(dim);
    if (!outConf[dim]?.criteriaVersion) outConf[dim] = { criteriaVersion: LEGACY_ALIAS_CRITERIA_VERSION[dim], confirmedAt: outConf[dim]?.confirmedAt ?? null };
  }
  return { attributes: outAttrs, attributeConfirmations: outConf, migrated };
}

// Eski katalog kaydı (crawler v1.4.2 ve öncesi) → nötr bant anahtarları. Belirsizse dokunmaz.
export function normalizeLegacyCampaignSegments(campaign) {
  if (!campaign || typeof campaign !== 'object') return campaign;
  const products = (campaign.cardProductIds || []).filter(p => LEGACY_SEGMENT_LABEL_ALIASES[p]);
  if (!products.length) return campaign;
  const map = new Map();
  for (const p of products) for (const [label, code] of Object.entries(LEGACY_SEGMENT_LABEL_ALIASES[p])) {
    if (map.has(label) && map.get(label) !== code) map.set(label, null); // belirsiz
    else map.set(label, code);
  }
  const conv = label => (map.get(label) ?? label);
  let out = campaign;
  const labels = campaign.eligibility?.segmentLabels;
  if (Array.isArray(labels) && labels.some(l => map.get(l))) {
    out = { ...out, eligibility: { ...campaign.eligibility, segmentLabels: labels.map(conv) } };
  }
  const rules = campaign.segmentRules;
  if (rules && typeof rules === 'object' && Object.keys(rules).some(k => map.get(k))) {
    out = { ...out, segmentRules: Object.fromEntries(Object.entries(rules).map(([k, v]) => [conv(k), v])) };
  }
  return out;
}
