// v1.5.0 — Kapsam modeli (saf fonksiyonlar). Bir bankanın uygulamada bulunması TAM destek anlamına gelmez.
//
// Fasetler (bağımsız): masterData, cardProducts, profileDimensions, coreBenefits, campaignSources, campaignCrawler, campaigns
//   değerler: 'full' | 'partial' | 'none'   (campaigns ve campaignSources için ayrıca 'coming')
// Genel destek düzeyi (türetilir): 'full' | 'partial' | 'profile_only' | 'coming' | 'unsupported'
// Kaynak/ölçüt tazeliği: 'verified' | 'last_known' | 'stale' | 'unverified'
//
// Kurallar (testlerle zorunlu):
//   - kampanya fasetinin beyanı bir ÜST SINIRDIR; etkin (enabled + adapter) tarayıcısı olmayan banka 'full'/'partial'
//     kampanya kapsamı GÖSTEREMEZ ('coming' veya 'none' olur);
//   - kart ürünü olmayan banka 'none' kart kapsamıdır, beyan ne derse desin;
//   - 'full' genel düzey yalnız TÜM fasetler 'full' ve kaynaklar 'verified' iken verilir.
// Kaynak kaydı: server/source_catalog.json (yapılandırma) → tarayıcı her taramada catalog.meta.sourceRegistry'ye
// yapılandırma + çalışma durumu (son tarama, son başarılı tarama, son doğrulama, sağlık) yazar. Tek doğruluk kaynağı odur.

export const FACET_VALUES = Object.freeze(['full', 'partial', 'none', 'coming']);
export const SUPPORT_LEVELS = Object.freeze(['full', 'partial', 'profile_only', 'coming', 'unsupported']);
export const FRESHNESS_VALUES = Object.freeze(['verified', 'last_known', 'stale', 'unverified']);

const DAY = 24 * 3600 * 1000;
// Kampanya kaynakları günde 2 kez taranır: 2 gün içinde başarı = doğrulanmış; 7 güne kadar son başarılı kayıt korunur.
export const SOURCE_VERIFIED_DAYS = 2;
export const SOURCE_LAST_KNOWN_DAYS = 7;
// Ölçüt (ör. varlık bandı eşiği) kaynak doğrulaması: 90 gün.
export const CRITERIA_VERIFIED_DAYS = 90;

const ageDays = (iso, now) => (iso ? (new Date(now).getTime() - new Date(iso).getTime()) / DAY : Infinity);

// Tek bir kampanya kaynağının tazeliği (catalog.meta.sourceRegistry satırı).
export function sourceFreshness(source, now = new Date()) {
  if (!source || source.enabled === false || !source.adapter) return 'unverified';
  if (!source.lastSuccessAt) return 'unverified';
  const age = ageDays(source.lastSuccessAt, now);
  // 'ok' = son tarama taze kayıt üretti. Aksi hâlde (zero / severe_drop / repaired_from_lkg) son başarılı kayıt korunuyordur.
  if (age <= SOURCE_VERIFIED_DAYS && source.health === 'ok') return 'verified';
  if (age <= SOURCE_LAST_KNOWN_DAYS) return 'last_known';
  return 'stale';
}

// Ölçüt satırının (global ana veri) kaynak tazeliği. KULLANICI onayından bağımsızdır.
export function criteriaFreshness(row, now = new Date()) {
  if (!row?.verifiedAt) return 'unverified';
  return ageDays(row.verifiedAt, now) <= CRITERIA_VERIFIED_DAYS ? 'verified' : 'stale';
}

const FRESHNESS_ORDER = ['unverified', 'stale', 'last_known', 'verified'];
const worstFreshness = list => (list.length ? FRESHNESS_ORDER[Math.min(...list.map(f => Math.max(0, FRESHNESS_ORDER.indexOf(f))))] : 'unverified');

// Bir bankanın kapsamı. registry: catalog.meta.sourceRegistry (yoksa kampanya kaynakları "bilinmiyor" → unverified).
export function bankCoverage(bankCode, catalog, { registry = null, now = new Date() } = {}) {
  const bank = (catalog?.banks || []).find(b => b.code === bankCode);
  const declared = (catalog?.bankCoverage || []).find(c => c.bankCode === bankCode) || {};
  const products = (catalog?.cardProducts || []).filter(p => p.bankCode === bankCode);
  const productCodes = new Set(products.map(p => p.code));
  const dims = (catalog?.dimensions || []).filter(d => d.bankCode === bankCode || (d.cardCodes || []).some(c => productCodes.has(c)));
  const sources = (registry || []).filter(s => s.bankCode === bankCode);
  const activeSources = sources.filter(s => s.enabled !== false && s.adapter);
  const configuredSources = sources.filter(s => s.url);

  const clamp = (v, allowed) => (allowed.includes(v) ? v : allowed[allowed.length - 1]);
  const masterData = bank ? 'full' : 'none';
  const cardProducts = products.length ? clamp(declared.cardProducts || 'partial', ['full', 'partial']) : 'none';
  // Boyut yoksa: beyan 'full' ise banka gerçekten boyut tanımlamıyordur; değilse 'none'.
  const profileDimensions = !products.length ? 'none'
    : (!dims.length ? (declared.profileDimensions === 'full' ? 'full' : 'none') : clamp(declared.profileDimensions || 'partial', ['full', 'partial']));
  const coreBenefits = products.length ? clamp(declared.coreBenefits || 'none', ['full', 'partial', 'none']) : 'none';
  const campaignSources = activeSources.length ? 'full' : (configuredSources.length ? 'coming' : (registry ? 'none' : (declared.campaigns === 'coming' ? 'coming' : 'none')));
  const campaignCrawler = activeSources.length ? 'full' : 'none';
  let campaigns;
  if (activeSources.length && products.length) campaigns = clamp(declared.campaigns || 'partial', ['full', 'partial']);
  else if (!registry && products.length && ['full', 'partial'].includes(declared.campaigns)) campaigns = 'partial'; // kayıt yüklenmedi: en fazla kısmi
  else campaigns = (configuredSources.length || declared.campaigns === 'coming') ? 'coming' : 'none';
  if (campaigns === 'full' && !activeSources.length) campaigns = 'coming'; // güvenlik: tarayıcısız tam kapsam yok

  const freshness = activeSources.length ? worstFreshness(activeSources.map(s => sourceFreshness(s, now))) : 'unverified';
  // v1.5.0: kaynak tamlık kanıtı (tarayıcı metrikleri). En zayıf kaynak belirler; kanıt yoksa 'unknown'.
  // 'complete' yalnız bankanın sayılabilir resmi sayısı birebir eşleştiğinde verilir; LKG eşitliği kanıt değildir.
  const CONF = ['unknown', 'low', 'medium', 'high'];
  const confs = activeSources.map(s => s.metrics?.completeness?.confidence || 'unknown');
  const sourceConfidence = confs.length ? CONF[Math.min(...confs.map(c => Math.max(0, CONF.indexOf(c))))] : 'unknown';
  const lastSuccessfulCrawl = activeSources.map(s => s.lastSuccessAt).filter(Boolean).sort().pop() || null;
  const lastVerification = activeSources.map(s => s.lastVerifiedAt || s.lastSuccessAt).filter(Boolean).sort().pop() || null;

  let level;
  if (!bank) level = 'unsupported';
  else if (cardProducts === 'none') level = campaigns === 'coming' ? 'coming' : 'unsupported';
  else if (['none', 'coming'].includes(campaigns) && coreBenefits === 'none') level = 'profile_only';
  else if ([cardProducts, profileDimensions, coreBenefits, campaigns].every(v => v === 'full') && freshness === 'verified') level = 'full';
  else level = 'partial';

  return {
    bankCode, level,
    facets: { masterData, cardProducts, profileDimensions, coreBenefits, campaignSources, campaignCrawler, campaigns },
    freshness, lastSuccessfulCrawl, lastVerification, sourceConfidence,
    sources: sources.map(s => ({ sourceCode: s.sourceCode, enabled: s.enabled !== false, adapter: s.adapter || null, freshness: sourceFreshness(s, now), lastSuccessAt: s.lastSuccessAt || null, health: s.health || null,
      completeness: s.metrics?.completeness?.status || 'unknown', confidence: s.metrics?.completeness?.confidence || 'unknown' })),
    note: declared.note || null,
  };
}

export function allBankCoverage(catalog, opts = {}) {
  return (catalog?.banks || []).map(b => bankCoverage(b.code, catalog, opts));
}

// Kısa, kullanıcıya dönük rozet (normal kullanıcıyı teknik ayrıntıya boğmadan).
export const SUPPORT_BADGE = Object.freeze({
  full: null,
  partial: 'Kısmi destek',
  profile_only: 'Yalnız profil',
  coming: 'Kampanyalar yakında',
  unsupported: 'Henüz desteklenmiyor',
});

export function supportBadge(level) { return SUPPORT_BADGE[level] ?? null; }

// Hangi Kart? için tek satırlık uyarı: yalnız kullanıcının seçtiği bankalardan biri kart/kampanya açısından
// kullanılamıyorsa (coming / unsupported / profile_only). Kısmi destek normal akışta gürültü yapmaz (ayrıntı: Profil › Uygulama Bilgisi).
export function recommendationCoverageNote(selectedBankCodes, catalog, opts = {}) {
  const limited = (selectedBankCodes || []).map(code => bankCoverage(code, catalog, opts)).filter(c => ['coming', 'unsupported', 'profile_only'].includes(c.level));
  if (!limited.length) return null;
  const names = limited.map(c => (catalog.banks.find(b => b.code === c.bankCode)?.name || c.bankCode));
  return `${names.join(', ')} için kart ve kampanya desteği henüz hazır değil; öneriler yalnız desteklenen kartlarını kapsar.`;
}
