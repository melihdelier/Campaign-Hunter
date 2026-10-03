import { trDay, trMonthKey, toTrDay } from './tr-time.js';
import { evaluateCampaignForCard, campaignTargetsCard, buildEligibilityContext } from './eligibility.js';

export function money(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'Bilinmiyor';
  return new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY', maximumFractionDigits: 2 }).format(Number(value));
}

// Dönem anahtarı Türkiye takvimine (Europe/Istanbul) göre üretilir; cihaz saat diliminden bağımsızdır.
export function currentPeriodKey(campaign, date = new Date()) {
  if (campaign.resetPolicy === 'monthly') {
    return trMonthKey(date);
  }
  if (campaign.resetPolicy === 'campaign') {
    return `${campaign.id}:${campaign.startDate || ''}:${campaign.endDate || ''}`;
  }
  return `${campaign.id}:static`;
}

// Geçerlilik, Türkiye takvim günleri ('YYYY-MM-DD') karşılaştırılarak belirlenir: başlangıç günü 00:00 ve
// bitiş günü 23:59:59 Europe/Istanbul saatidir; çalışma ortamının yerel gece yarısına dayanmaz.
export function campaignIsActive(campaign, date = new Date()) {
  const today = trDay(date);
  const start = toTrDay(campaign.startDate);
  const end = toTrDay(campaign.endDate);
  if (start && today < start) return false;
  if (end && today > end) return false;
  return campaign.status !== 'inactive' && campaign.status !== 'expired';
}

// Bitiş günü Türkiye takviminde geçti mi?
export function endDatePassed(endDate, date = new Date()) {
  const end = toTrDay(endDate);
  return Boolean(end) && trDay(date) > end;
}

function norm(v) {
  return String(v ?? '').trim().toLocaleLowerCase('tr-TR');
}

function merchantKey(v) {
  return norm(v)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i')
    .replace(/[^a-z0-9]/g, '');
}

function levenshtein(a, b) {
  const x = merchantKey(a), y = merchantKey(b);
  if (x === y) return 0;
  if (!x.length) return y.length;
  if (!y.length) return x.length;
  const prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    let left = i;
    let diag = i - 1;
    for (let j = 1; j <= y.length; j++) {
      const up = prev[j];
      const next = Math.min(up + 1, left + 1, diag + (x[i - 1] === y[j - 1] ? 0 : 1));
      diag = up; prev[j] = next; left = next;
    }
  }
  return prev[y.length];
}

function merchantNameScore(input, candidate) {
  const a = merchantKey(input), b = merchantKey(candidate);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const minLen = Math.min(a.length, b.length);
  if (minLen >= 4 && (a.includes(b) || b.includes(a))) return 0.94;
  const d = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  const sim = 1 - d / maxLen;
  if (minLen >= 8 && d <= 2 && sim >= 0.75) return sim;
  if (minLen >= 5 && d <= 1 && sim >= 0.80) return sim;
  return 0;
}

function bestMerchantCandidate(input, values = []) {
  let best = null;
  for (const value of values) {
    const score = merchantNameScore(input, value);
    if (score > 0 && (!best || score > best.score)) best = { value, score };
  }
  return best;
}

const KNOWN_MERCHANTS = [
  { canonicalName: 'Migros', aliases: ['Migros','Migros Sanal Market','Migros Hemen'], categories: ['market'] },
  { canonicalName: 'Da Mario', aliases: ['Da Mario','Da Mario Etiler','Da Mario İstinye Park','Damario'], categories: ['restoran'] },
  { canonicalName: 'Günaydın', aliases: ['Günaydın','Gunaydin'], categories: ['restoran'] },
  { canonicalName: 'Amazon', aliases: ['Amazon','Amazon.com.tr','Amzon'], categories: ['e-ticaret'] },
  { canonicalName: 'Türk Hava Yolları', aliases: ['THY','Türk Hava Yolları','Turkish Airlines','turkishairlines.com'], categories: ['seyahat'] },
  { canonicalName: 'CarrefourSA', aliases: ['CarrefourSA','Carrefour'], categories: ['market'] },
  { canonicalName: 'Trendyol', aliases: ['Trendyol'], categories: ['e-ticaret'] },
  { canonicalName: 'Hepsiburada', aliases: ['Hepsiburada'], categories: ['e-ticaret'] },
  { canonicalName: 'n11', aliases: ['n11','n11.com'], categories: ['e-ticaret'] },
  { canonicalName: 'Pazarama', aliases: ['Pazarama'], categories: ['e-ticaret'] },
  { canonicalName: 'Gratis', aliases: ['Gratis','Gratis.com'], categories: ['giyim'] },
  { canonicalName: 'Network', aliases: ['Network','Network.com.tr'], categories: ['giyim'] },
  { canonicalName: 'Setur', aliases: ['Setur'], categories: ['seyahat'] },
  { canonicalName: 'ATÜ Duty Free', aliases: ['ATÜ Duty Free','ATU Duty Free'], categories: ['seyahat'] },
  { canonicalName: 'İSPARK', aliases: ['İSPARK','Ispark'], categories: ['otopark'] }
];

function knownMerchantContext(merchant) {
  let best = null;
  for (const item of KNOWN_MERCHANTS) {
    const hit = bestMerchantCandidate(merchant, item.aliases || []);
    if (hit && (!best || hit.score > best.score)) best = { ...item, score: hit.score, matchedAlias: hit.value };
  }
  if (!best || best.score < 0.80) return null;
  return { recognized: true, canonicalName: best.canonicalName, score: best.score, exactAlias: best.score === 1, categories: best.categories || [], matches: [], source: 'registry' };
}

function bestExcludedMerchantCandidate(input, values = []) {
  const a = merchantKey(input);
  let best = null;
  for (const value of values) {
    const b = merchantKey(value);
    if (!a || !b) continue;
    const lenGap = Math.abs(a.length - b.length);
    const d = levenshtein(a, b);
    const exact = a === b;
    const fuzzy = !exact && lenGap <= 2 && Math.min(a.length, b.length) >= 5 && d <= 1;
    if (!exact && !fuzzy) continue;
    const score = exact ? 1 : 1 - d / Math.max(a.length, b.length);
    if (!best || score > best.score) best = { value, score };
  }
  return best;
}

export function inferMerchantContext(campaigns, merchant) {
  const known = knownMerchantContext(merchant);
  if (known) return known;

  const matches = [];
  for (const campaign of campaigns || []) {
    const scope = campaign.merchantScope || {};
    if (!Array.isArray(scope.values) || !scope.values.length) continue;
    const best = bestMerchantCandidate(merchant, scope.values);
    if (!best) continue;
    matches.push({ campaign, value: best.value, score: best.score });
  }
  if (!matches.length) {
    const generic = [
      { names: ['THY', 'Türk Hava Yolları', 'Turkish Airlines', 'turkishairlines.com'], canonicalName: 'Türk Hava Yolları', category: 'seyahat' }
    ];
    for (const item of generic) {
      const best = bestMerchantCandidate(merchant, item.names);
      if (best) return { recognized: true, canonicalName: item.canonicalName, score: best.score, categories: [item.category], matches: [], source: 'generic' };
    }
    return { recognized: false, canonicalName: null, score: 0, categories: [], matches: [], source: 'none' };
  }
  matches.sort((a, b) => b.score - a.score);
  const top = matches[0];
  const related = matches.filter(m => m.score >= Math.max(0.80, top.score - 0.08));
  const categories = [...new Set(related.flatMap(m => m.campaign.merchantScope?.category ? [m.campaign.merchantScope.category] : (m.campaign.categories || (m.campaign.category ? [m.campaign.category] : []))).filter(c => c && c !== 'all'))];
  return { recognized: true, canonicalName: top.value, score: top.score, categories, matches: related, source: 'campaign' };
}

export function resolveMerchantInput(campaigns, merchant, selectedCategory) {
  const context = inferMerchantContext(campaigns, merchant);
  let effectiveCategory = selectedCategory;
  const notices = [];
  let needsCategorySelection = false;

  if (context.recognized && context.canonicalName && merchantKey(merchant) !== merchantKey(context.canonicalName)) {
    notices.push(`İşyeri “${merchant}” → “${context.canonicalName}” olarak eşleştirildi.`);
  }

  if (selectedCategory === 'auto') {
    if (context.categories.length === 1) {
      effectiveCategory = context.categories[0];
      notices.push(`Kategori otomatik olarak “${effectiveCategory}” belirlendi.`);
    } else {
      effectiveCategory = null;
      needsCategorySelection = true;
    }
  } else {
    // Manuel kategori, kampanya kataloğundaki gürültülü kategori çıkarımına kurban edilmemeli.
    // Yalnızca güvenilir yerel işyeri sözlüğü tek bir kategori söylüyorsa açık bir çelişkiyi düzelt.
    // Yalnız birebir (normalize edilmiş) alias eşleşmesi manuel seçimi düzeltebilir. Alt dize / bulanık eşleşme
    // (ör. "Amazon Prime Video" ⊃ "Amazon") farklı bir hizmet olabilir; manuel seçim korunur, yalnız uyarı verilir.
    if (context.source === 'registry' && context.exactAlias === true && context.categories.length === 1 && !context.categories.includes(selectedCategory)) {
      effectiveCategory = context.categories[0];
      notices.push(`Kategori uyuşmazlığı: “${context.canonicalName}” güvenilir işyeri sözlüğünde “${effectiveCategory}” olarak tanınıyor. “${selectedCategory}” yerine “${effectiveCategory}” kullanıldı.`);
    } else if (context.source === 'registry' && context.categories.length === 1 && !context.categories.includes(selectedCategory)) {
      effectiveCategory = selectedCategory;
      notices.push(`“${merchant}” işyeri sözlüğündeki “${context.canonicalName}” (${context.categories[0]}) kaydına benziyor fakat birebir eşleşmiyor; manuel kategori “${selectedCategory}” korundu.`);
    } else {
      effectiveCategory = selectedCategory;
      if (context.categories.length > 1 && !context.categories.includes(selectedCategory)) {
        notices.push(`Manuel kategori “${selectedCategory}” kullanıldı; katalogdaki otomatik kategori çıkarımı belirsiz (${context.categories.join(', ')}).`);
      }
    }
  }
  return { context, effectiveCategory, notices, needsCategorySelection };
}

export function categoryMatches(campaign, category) {
  const wanted = norm(category);
  if (!wanted || wanted === 'all') return true;
  const categories = campaign.categories || (campaign.category ? [campaign.category] : ['all']);
  return categories.some(c => c === 'all' || norm(c) === wanted);
}

export function segmentMatches(campaign, card) {
  const allowed = campaign.eligibility?.segmentLabels;
  if (!Array.isArray(allowed) || allowed.length === 0) return true;
  return allowed.some(s => norm(s) === norm(card.segment));
}

// Sürekli ayrıcalıklar birden fazla doğrulanmış dönem taşıyabilir (ör. Q3 → Q4 kural değişikliği).
// Tarihe göre geçerli dönemi seçer; hiçbiri geçerli değilse en son başlamış dönemi döndürür
// (böylece kampanya "dönemi bitti" olarak görünür, sessizce kaybolmaz).
const PERIOD_FIELDS = ['startDate','endDate','segmentRules','rewardRule','periodCap','eligibility','transactionRules','termsSummary','verifiedAt','requiresEnrollment','enrollmentMethod','enrollmentScope','rulesComplete','rewardUnit','merchantScope','categories'];

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
function isIsoDay(v) {
  if (!ISO_DAY.test(String(v || ''))) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

// Bir core ayrıcalık birden fazla ONAYLI resmi kaynağa (ör. banka sayfası + kart programı sitesi) sahip olabilir.
// Kaynaklar geçerlilik tarihinde çelişirse bu açıkça temsil edilir (officialDateConflict) ve uyarı eklenir.
// dateConflictPolicy: 'latest_official' (varsayılan; en geç resmi tarih) | 'earliest_official' (en temkinli).
export function resolveOfficialSourceDates(campaign) {
  const sources = Array.isArray(campaign?.officialSources) ? campaign.officialSources.filter(x => x && x.url) : [];
  const dated = sources.filter(x => isIsoDay(x.endDate));
  if (!dated.length) return campaign;
  const ends = [...new Set(dated.map(x => x.endDate))].sort();
  const policy = campaign.dateConflictPolicy === 'earliest_official' ? 'earliest_official' : 'latest_official';
  const chosen = policy === 'earliest_official' ? ends[0] : ends[ends.length - 1];
  const out = { ...campaign, endDate: chosen };
  const warnings = [...(campaign.decisionWarnings || [])];
  if (ends.length > 1) {
    out.officialDateConflict = {
      policy, chosenEndDate: chosen,
      sources: dated.map(x => ({ key: x.key || null, label: x.label || x.url, url: x.url, endDate: x.endDate, verifiedAt: x.verifiedAt || null, liveUpdated: Boolean(x.liveUpdated) }))
    };
    warnings.push(`Resmi kaynaklar geçerlilik tarihinde çelişiyor: ${dated.map(x => `${x.label || x.url} → ${x.endDate}`).join(' · ')}. ${policy === 'latest_official' ? 'En geç' : 'En erken'} resmi tarih (${chosen}) kullanıldı; işlem öncesi banka/kart uygulamasından teyit et.`);
  }
  if (dated.some(x => x.liveUpdated && x.endDate === chosen)) {
    out.liveExtendedValidity = true;
    warnings.push('Geçerlilik tarihi resmi kaynakta canlı olarak görüldü; ödül/segment kuralları son doğrulanmış tanımdan taşındı. Resmi koşulları kontrol et.');
  }
  out.decisionWarnings = [...new Set(warnings)];
  return out;
}

export function resolveValidityPeriod(campaign, now = new Date()) {
  const periods = Array.isArray(campaign?.validityPeriods) ? campaign.validityPeriods.filter(Boolean) : [];
  if (!periods.length) return resolveOfficialSourceDates(campaign);
  const t = new Date(now);
  const sorted = [...periods].sort((a, b) => String(a.startDate || '').localeCompare(String(b.startDate || '')));
  const isIn = p => campaignIsActive({ status: 'active', startDate: p.startDate, endDate: p.endDate }, t);
  let chosen = sorted.filter(isIn).pop();
  if (!chosen) {
    const today = trDay(t);
    const started = sorted.filter(p => !p.startDate || toTrDay(p.startDate) <= today);
    chosen = started.length ? started[started.length - 1] : sorted[0];
  }
  const out = { ...campaign };
  for (const f of PERIOD_FIELDS) if (Object.prototype.hasOwnProperty.call(chosen, f)) out[f] = chosen[f];
  out.activePeriodId = chosen.id || null;
  out.decisionWarnings = [...new Set([...(campaign.decisionWarnings || []), ...(chosen.decisionWarnings || [])])];
  if (chosen.liveExtended) out.liveExtendedValidity = true;
  return out;
}

export function resolveSegmentCampaign(campaign, card, now = new Date()) {
  campaign = resolveValidityPeriod(campaign, now);
  const rules = campaign.segmentRules;
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) return campaign;
  const entry = Object.entries(rules).find(([label]) => norm(label) === norm(card.segment));
  if (!entry) return campaign;
  const [label, variant] = entry;
  return {
    ...campaign,
    ...variant,
    id: campaign.id,
    title: campaign.title,
    bank: campaign.bank,
    sourceUrl: campaign.sourceUrl,
    sourceKind: campaign.sourceKind,
    segmentRules: campaign.segmentRules,
    eligibility: { ...(campaign.eligibility || {}), ...(variant.eligibility || {}), segmentLabels: [label] },
    rewardRule: variant.rewardRule || campaign.rewardRule,
    transactionRules: { ...(campaign.transactionRules || {}), ...(variant.transactionRules || {}) },
    decisionWarnings: [...new Set([...(campaign.decisionWarnings || []), ...(variant.decisionWarnings || [])])],
  };
}

export function merchantMatch(campaign, merchant) {
  const scope = campaign.merchantScope || { kind: 'all' };
  const value = norm(merchant);
  if (scope.kind === 'all') return { matched: true, verified: true, warning: null, canonicalName: null, fuzzy: false };
  if (!value) return { matched: false, verified: false, warning: 'İşyeri adı girilmedi.', canonicalName: null, fuzzy: false };

  const excludedMatch = bestExcludedMerchantCandidate(merchant, scope.excludedValues || []);
  if (excludedMatch) return { matched: false, verified: true, warning: 'Bu işyeri/şube kampanya dışında.', canonicalName: excludedMatch.value, fuzzy: excludedMatch.score < 1 };

  const best = bestMerchantCandidate(merchant, scope.values || []);
  const matchedByName = Boolean(best);
  const fuzzy = Boolean(best && best.score < 1);
  const fuzzyNote = fuzzy ? ` “${merchant}” girişi “${best.value}” ile eşleştirildi.` : '';

  if (scope.kind === 'contains') {
    if (!matchedByName) return { matched: false, verified: true, warning: 'İşyeri kampanya listesindeki eşleşmeler arasında değil.', canonicalName: null, fuzzy: false };
    const branchWarning = scope.requiresBranchConfirmation ? 'İşyeri adı eşleşti; kampanya bazı şubeleri hariç tutabildiği için şube doğrulaması gerekli.' : null;
    return {
      matched: true,
      verified: scope.requiresBranchConfirmation !== true && !fuzzy,
      warning: [fuzzyNote.trim(), branchWarning].filter(Boolean).join(' ' ) || null,
      canonicalName: best.value,
      fuzzy
    };
  }
  if (scope.kind === 'exact') {
    return { matched: matchedByName, verified: matchedByName && !fuzzy, warning: matchedByName ? (fuzzyNote.trim() || null) : 'İşyeri kampanya listesinde değil.', canonicalName: best?.value || null, fuzzy };
  }
  if (scope.kind === 'restricted_unknown') {
    return { matched: true, verified: false, warning: 'Kampanya sadece seçili işyerlerinde geçerli; işyeri listesi henüz tam doğrulanmadı.', canonicalName: null, fuzzy: false };
  }
  return { matched: false, verified: false, warning: 'İşyeri kapsamı tanınmıyor.', canonicalName: null, fuzzy: false };
}

export function ruleMinSpend(campaign) {
  const rule = campaign.rewardRule || {};
  if (rule.kind === 'tiered_percent' || rule.kind === 'tiered_fixed') {
    const tiers = Array.isArray(rule.tiers) ? rule.tiers : [];
    if (!tiers.length) return null;
    return Math.min(...tiers.map(t => Number(t.min || 0)));
  }
  return rule.minSpend !== undefined && rule.minSpend !== null ? Number(rule.minSpend) : 0;
}

export function matchingTier(campaign, amount) {
  const a = Number(amount);
  const rule = campaign.rewardRule || {};
  if (!['tiered_percent','tiered_fixed'].includes(rule.kind)) return null;
  const tiers = Array.isArray(rule.tiers) ? rule.tiers : [];
  return tiers.find(t => a >= Number(t.min || 0) && (t.max === undefined || t.max === null || a <= Number(t.max))) || null;
}

export function calcTheoreticalReward(campaign, amount) {
  const a = Number(amount);
  if (!Number.isFinite(a) || a <= 0) return 0;
  const rule = campaign.rewardRule || {};
  let reward = 0;

  if (rule.maxSpend !== undefined && rule.maxSpend !== null && a > Number(rule.maxSpend)) return 0;

  if (rule.kind === 'percent') {
    if (a < Number(rule.minSpend || 0)) return 0;
    reward = a * Number(rule.rate || 0);
  } else if (rule.kind === 'fixed') {
    if (a < Number(rule.minSpend || 0)) return 0;
    reward = Number(rule.reward || 0);
  } else if (rule.kind === 'tiered_percent') {
    const tier = matchingTier(campaign, a);
    if (!tier) return 0;
    reward = a * Number(tier.rate || 0);
  } else if (rule.kind === 'tiered_fixed') {
    const tier = matchingTier(campaign, a);
    if (!tier) return 0;
    reward = Number(tier.reward || 0);
  } else if (rule.kind === 'miles') {
    if (a < Number(rule.minSpend || 0)) return 0;
    reward = a / Number(rule.tryPerMile || 1);
  }

  const txCap = rule.perTransactionCap ?? campaign.perTransactionCap;
  if (txCap !== undefined && txCap !== null) reward = Math.min(reward, Number(txCap));
  return Math.max(0, reward);
}

// İşlem bazlı teorik kazancı dönem (aylık/kampanya) tavanıyla sınırlar. Kalan hak bilinmese bile
// tek bir işlem dönem tavanından fazla kazandıramaz.
export function calcCappedTheoreticalReward(campaign, amount) {
  const perTransaction = calcTheoreticalReward(campaign, amount);
  const cap = campaign.periodCap;
  if (cap === null || cap === undefined || !Number.isFinite(Number(cap))) return { reward: perTransaction, perTransaction, periodCapApplied: false };
  const reward = Math.min(perTransaction, Math.max(0, Number(cap)));
  return { reward, perTransaction, periodCapApplied: reward < perTransaction };
}

function blocker(code, message, kind = 'hard', meta = {}) {
  return { code, message, kind, ...meta };
}

export function inspectCampaign({ campaign, card, merchant, category, amount, locationScope = 'domestic', paymentChannel = 'physical', now = new Date(), eligibilityContext = null }) {
  const blockers = [];
  const warnings = [];

  if (!campaignIsActive(campaign, now)) blockers.push(blocker('inactive', 'Kampanya şu anda aktif değil.', 'hard'));
  // Kart/banka/profil uygunluğu: ortak değerlendirici (Kampanyalar ekranı da aynısını kullanır).
  const eligibility = evaluateCampaignForCard(campaign, card, eligibilityContext || buildEligibilityContext({ cards: [card] }));
  for (const r of eligibility.reasons) blockers.push(blocker(r.code, r.message, 'hard', r.dim ? { dim: r.dim } : {}));
  if (!categoryMatches(campaign, category)) blockers.push(blocker('category', 'Harcama kategorisi kampanya kapsamına uymuyor.', 'hard'));

  const m = merchantMatch(campaign, merchant);
  if (!m.matched) blockers.push(blocker('merchant', m.warning || 'İşyeri kampanya kapsamına uymuyor.', 'hard'));
  else if (!m.verified && m.warning) warnings.push(m.warning);

  const rule = campaign.rewardRule || {};
  const a = Number(amount);
  const minSpend = ruleMinSpend(campaign);
  const tx = campaign.transactionRules || {};
  // Toplam dönem harcaması kampanyalarında alt limit tek işleme uygulanamaz.
  if (!tx.cumulativeSpendCampaign && Number.isFinite(a) && minSpend !== null && a < minSpend) {
    const gap = Math.max(0, minSpend - a);
    blockers.push(blocker(
      'min_spend',
      `Alt limit ${money(minSpend)}; işlem tutarı ${money(a)}. ${money(gap)} eksik.`,
      'actionable',
      { requiredAmount: minSpend, currentAmount: a, gap }
    ));
  }
  if (rule.maxSpend !== undefined && rule.maxSpend !== null && a > Number(rule.maxSpend)) {
    blockers.push(blocker('max_spend', `Üst işlem sınırı ${money(rule.maxSpend)}; işlem tutarı ${money(a)}.`, 'actionable', { maxAmount: Number(rule.maxSpend), currentAmount: a }));
  }

  if (tx.cumulativeSpendCampaign) warnings.push('Bu kampanya tek işlem değil, dönem içi toplam harcamaya bağlı; birikmiş harcaman doğrulanmalı.');
  if (tx.location === 'domestic' && locationScope !== 'domestic') blockers.push(blocker('location', 'Kampanya yalnızca yurt içi işlemlerde geçerli.', 'actionable'));
  if (tx.location === 'international' && locationScope !== 'international') blockers.push(blocker('location', 'Kampanya yalnızca yurt dışı işlemlerde geçerli.', 'actionable'));
  if (Array.isArray(tx.allowedChannels) && tx.allowedChannels.length && !tx.allowedChannels.includes(paymentChannel)) {
    blockers.push(blocker('channel', `Ödeme kanalı uygun değil; geçerli kanal(lar): ${tx.allowedChannels.join(', ')}.`, 'actionable'));
  }
  if (Array.isArray(tx.excludedCategories) && tx.excludedCategories.length) warnings.push(`Hariç işlemler: ${tx.excludedCategories.join(', ')}.`);
  if (tx.requiredPos) warnings.push(`${tx.requiredPos} üzerinden işlem şartı var.`);
  if (tx.sameDaySameMerchantFirstOnly) warnings.push('Aynı gün aynı işyerindeki yalnızca ilk işlem kampanyaya dahil olabilir.');
  if (tx.differentDaysRequired) warnings.push('Uygun işlemlerin farklı günlerde yapılması gerekiyor.');
  if (tx.differentMerchantsRequired) warnings.push('Uygun işlemlerin farklı işyerlerinde yapılması gerekiyor.');
  if (tx.rewardStartsFromQualifyingTransaction && Number(tx.rewardStartsFromQualifyingTransaction) > 1) {
    warnings.push(`Ödül ${tx.rewardStartsFromQualifyingTransaction}. ve sonraki uygun işlemlerden itibaren kazanılıyor.`);
  }
  if (tx.customerLevel) warnings.push('Kampanya müşteri bazındadır.');
  if (tx.nonStackable) warnings.push('Kampanya başka indirim/kampanyalarla birleştirilemeyebilir.');
  for (const note of campaign.decisionWarnings || []) warnings.push(note);
  if (campaign.rulesComplete === false) warnings.push('Kampanya detayları henüz tam doğrulanmadı; kesin öneri olarak kullanılmamalı.');

  return {
    eligible: blockers.length === 0,
    reasons: blockers.map(x => x.message),
    blockers,
    warnings,
    merchant: m
  };
}

// Aynı id/URL'nin yeni bir kampanya için yeniden kullanılmasını tespit etmek için "kampanya örneği" başlangıcı.
// Core ayrıcalıkların sürekliliği dönem (validityPeriods) mekanizmasıyla yönetilir; onlar için kullanılmaz.
function campaignInstanceStart(campaign) {
  return campaign && !campaign.coreBenefit && isIsoDay(campaign.startDate) ? campaign.startDate : null;
}

function parseCampaignPeriodKey(key, id) {
  if (typeof key !== 'string' || !id || !key.startsWith(`${id}:`)) return null;
  const [start = '', end = ''] = key.slice(id.length + 1).split(':');
  return { start, end };
}

function unknownState(campaign, expectedKey, date, prevState, notes) {
  const persistentEnrollment = prevState && campaign.requiresEnrollment && campaign.enrollmentScope === 'program'
    && ['joined', 'not_joined'].includes(prevState.enrollmentStatus);
  return {
    campaignId: campaign.id,
    periodKey: expectedKey,
    enrollmentStatus: !campaign.requiresEnrollment ? 'not_required' : (persistentEnrollment ? prevState.enrollmentStatus : 'unknown'),
    remainingLimit: null,
    usedAmount: null,
    qualifyingTransactions: null,
    valueSource: 'unknown',
    confirmedAt: null,
    updatedAt: new Date(date).toISOString(),
    notes,
    ...(prevState?.identity ? { identity: prevState.identity } : {})
  };
}

export function ensureReset(campaign, state, date = new Date()) {
  const expectedKey = currentPeriodKey(campaign, date);
  const instanceStart = campaignInstanceStart(campaign);
  const stamp = st => (instanceStart ? { ...st, campaignStart: instanceStart } : st);

  // Kampanya ilk kez katalogda görülüyorsa kullanıcının ay/dönem içindeki önceki kullanımını bilemeyiz.
  // Bu nedenle dönem tavanını "kalan hak" diye varsayma; kullanıcı doğrulayana kadar bilinmiyor tut.
  if (!state) {
    return stamp(unknownState(campaign, expectedKey, date, null, 'Kampanya ilk kez görüldü; dönem içindeki önceki kullanım bilinmediği için kalan hak kullanıcı doğrulaması bekliyor.'));
  }

  // Kampanya-dönemi politikasında yalnız bitiş tarihi ileri uzadıysa (aynı başlangıç) bu yeni dönem değildir.
  if (campaign.resetPolicy === 'campaign' && state.periodKey !== expectedKey) {
    const prev = parseCampaignPeriodKey(state.periodKey, campaign.id);
    if (prev && prev.start && prev.start === (campaign.startDate || '') && prev.end && (campaign.endDate || '') > prev.end) {
      return stamp({ ...state, periodKey: expectedKey, notes: 'Kampanya süresi uzatıldı; mevcut kalan hak/ilerleme korundu.' });
    }
  }

  if (state.periodKey !== expectedKey) {
    // KURAL: her yeni aylık/kampanya döneminde kalan hak BİLİNMİYOR olarak başlar — önceki dönem kullanıcı
    // tarafından doğrulanmış olsa bile tam tavan varsayılmaz (kullanıcı uygulamayı açmadan önce harcamış olabilir).
    // Kalan hak sıralamayı ancak yeni dönemde yeniden doğrulandıktan sonra etkiler; tavanlı teorik kazanç görünür kalır.
    // Program katılımı (enrollmentScope:'program') kalıcıdır ve unknownState içinde korunur.
    return stamp(unknownState(campaign, expectedKey, date, state,
      'Yeni dönem başladı; kalan hak bu dönem için henüz doğrulanmadı. Bankadaki kalan hakkı doğrula.'));
  }

  // Önceki sürümlerin dönem başında otomatik yazdığı "reset" değeri (tam tavan) kullanıcı doğrulaması değildir;
  // aynı politika gereği bilinmiyor yapılır. (v1.2.2 artık 'reset' değeri üretmez; bu yalnız eski cihaz verisidir.)
  if (state.valueSource === 'reset') {
    return stamp({ ...state, remainingLimit: null, usedAmount: null, valueSource: 'unknown', confirmedAt: null,
      updatedAt: new Date(date).toISOString(), notes: 'Eski sürümün otomatik dönem değeri kaldırıldı; kalan hak bu dönem için doğrulanmalı.' });
  }

  // Aynı takvim ayı/dönem anahtarı içinde, aynı id/URL farklı başlangıç tarihli YENİ bir kampanyaya dönüştüyse
  // önceki kalan hak / ilerleme / katılım bu kampanyaya sessizce taşınmaz.
  if (instanceStart && state.campaignStart && state.campaignStart !== instanceStart) {
    return stamp(unknownState(campaign, expectedKey, date, state,
      `Aynı kaynakta yeni kampanya dönemi tespit edildi (başlangıç ${state.campaignStart} → ${instanceStart}); önceki kalan hak/ilerleme taşınmadı, yeniden doğrula.`));
  }
  if (instanceStart && !state.campaignStart) return { ...state, campaignStart: instanceStart };
  return state;
}

export function freshness(state, now = new Date(), staleAfterDays = 3) {
  if (!state?.confirmedAt) return { status: 'unknown', days: null, label: 'Doğrulanmamış' };
  const diff = Math.max(0, new Date(now) - new Date(state.confirmedAt));
  const days = Math.floor(diff / 86400000);
  if (state.valueSource === 'user_confirmed' && days <= staleAfterDays) return { status: 'fresh', days, label: 'Kullanıcı doğruladı' };
  if (days > staleAfterDays) return { status: 'stale', days, label: `${days} gün önce güncellendi` };
  if (state.valueSource === 'reset') return { status: 'estimated', days, label: 'Otomatik reset değeri' };
  return { status: 'estimated', days, label: 'Sistem tahmini' };
}

function progressAssessment(campaign, state) {
  const tx = campaign.transactionRules || {};
  const startsAt = Number(tx.rewardStartsFromQualifyingTransaction || 1);
  if (startsAt <= 1) return { known: true, rewardEligibleNow: true, note: null };

  const count = state?.qualifyingTransactions;
  if (count === null || count === undefined || !Number.isFinite(Number(count))) {
    return {
      known: false,
      rewardEligibleNow: null,
      note: `Bu işlemin ödül getirip getirmediği, kampanya dönemindeki önceki uygun işlem adedine bağlı. Ödül ${startsAt}. uygun işlemden itibaren başlıyor.`
    };
  }
  const currentOrdinal = Number(count) + 1;
  return {
    known: true,
    rewardEligibleNow: currentOrdinal >= startsAt,
    note: currentOrdinal >= startsAt
      ? `Bu işlem ${currentOrdinal}. uygun işlem olur ve ödül koşulunu sağlar.`
      : `Bu işlem ${currentOrdinal}. uygun işlem olur; ödül ${startsAt}. uygun işlemden itibaren başlar.`
  };
}

// Kartlar arası birleşik müşteri tavanı (ör. Metal Crystal + Crystal birlikte: aylık 15.000 TL toplam).
// Kart başına segment tavanından AYRI bir kuraldır; yalnız müşteri gerekli kart tiplerinin hepsini taşıyorsa devreye girer.
export function cardTypesHeld(card) {
  if (!card) return [];
  if (card.cardType === 'crystal_and_metal') return ['crystal', 'metal_crystal'];
  return card.cardType ? [card.cardType] : [];
}

export function applyCombinedCustomerCaps(campaign, card) {
  const caps = Array.isArray(campaign?.combinedCustomerCaps) ? campaign.combinedCustomerCaps : [];
  if (!caps.length) return campaign;
  const held = cardTypesHeld(card);
  const active = caps.filter(c => Array.isArray(c.requiresCardTypes) && c.requiresCardTypes.length && c.requiresCardTypes.every(t => held.includes(t)));
  if (!active.length) return campaign;
  let out = { ...campaign, activeCombinedCaps: active };
  const warnings = [...(campaign.decisionWarnings || [])];
  for (const c of active) {
    if (Number.isFinite(Number(c.periodCap)) && (out.periodCap == null || Number(c.periodCap) < Number(out.periodCap))) out.periodCap = Number(c.periodCap);
    warnings.push(`${c.label}: kartlar toplamında aylık en fazla ${Number(c.periodCap).toLocaleString('tr-TR')} TL. Kart başına varlık seviyesi tavanı ayrıca geçerlidir; diğer kartla yapılan indirimler bu toplamdan düşer.`);
  }
  out.decisionWarnings = [...new Set(warnings)];
  return out;
}

export function evaluateCampaign({ campaign, state, card, merchant, category, amount, locationScope = 'domestic', paymentChannel = 'physical', now = new Date(), staleAfterDays = 3, eligibilityContext = null }) {
  campaign = applyCombinedCustomerCaps(resolveSegmentCampaign(campaign, card, now), card);
  const inspection = inspectCampaign({ campaign, card, merchant, category, amount, locationScope, paymentChannel, now, eligibilityContext });
  const normalizedState = ensureReset(campaign, state, now);

  // Dönemi bitmiş sürekli ayrıcalık sessizce kaybolmamalı: başka engel yoksa bilgi amaçlı gösterilir.
  const onlyInactive = inspection.blockers.length > 0 && inspection.blockers.every(b => b.code === 'inactive' || b.kind === 'actionable');
  if (campaign.coreBenefit && onlyInactive && endDatePassed(campaign.endDate, now)) {
    return {
      campaign, eligible: false, potential: false, informational: true, coreExpired: true, inspection, state: normalizedState,
      infoNote: `Bu sürekli ayrıcalığın doğrulanmış dönemi ${campaign.endDate} tarihinde sona erdi; yeni dönem koşulları henüz doğrulanmadı. Resmi sayfayı kontrol et.`
    };
  }

  if (!inspection.eligible) {
    const hardBlockers = inspection.blockers.filter(b => b.kind === 'hard');
    const actionableBlockers = inspection.blockers.filter(b => b.kind === 'actionable');
    const potential = hardBlockers.length === 0 && actionableBlockers.length > 0;
    const minBlock = actionableBlockers.find(b => b.code === 'min_spend');
    const rewardAtThreshold = minBlock ? calcCappedTheoreticalReward(campaign, minBlock.requiredAmount).reward : 0;
    return {
      campaign,
      eligible: false,
      potential,
      inspection,
      state: normalizedState,
      actionableBlockers,
      hardBlockers,
      rewardAtThreshold
    };
  }

  const ruleKind = campaign.rewardRule?.kind || 'unknown';
  if (campaign.rulesComplete === false || ['unknown','non_cash'].includes(ruleKind)) {
    return { campaign, eligible: false, potential: false, informational: true, inspection, state: normalizedState };
  }

  const capped = calcCappedTheoreticalReward(campaign, amount);
  const theoretical = capped.reward;
  if (theoretical <= 0) {
    return { campaign, eligible: false, potential: false, informational: false, inspection: { ...inspection, reasons: [...inspection.reasons, 'Kazanç koşulu oluşmadı.'] }, state: normalizedState };
  }

  const enrollmentMissing = campaign.requiresEnrollment && normalizedState.enrollmentStatus !== 'joined';
  const rawRemainingKnown = normalizedState.remainingLimit !== null && normalizedState.remainingLimit !== undefined;
  const freshnessInfo = freshness(normalizedState, now, staleAfterDays);
  // Kullanıcı uygulama dışında da harcama yapabildiği için eski kalan-limit rakamını kesin hesapta kullanma.
  // Değer ekranda görünmeye devam eder fakat karar motoru onu doğrulanmış kalan hak gibi kabul etmez.
  const remainingKnown = rawRemainingKnown && freshnessInfo.status !== 'stale';
  const progress = progressAssessment(campaign, normalizedState);
  const progressBlocksReward = progress.known && progress.rewardEligibleNow === false;
  const progressUnknown = !progress.known;
  const actualBase = remainingKnown ? Math.min(theoretical, Math.max(0, Number(normalizedState.remainingLimit))) : null;
  const actual = enrollmentMissing || progressBlocksReward ? 0 : (progressUnknown ? null : actualBase);
  const extraWarnings = progress.note ? [progress.note] : [];
  if (capped.periodCapApplied) extraWarnings.push(`İşlem bazlı hesap ${capped.perTransaction.toLocaleString('tr-TR', { maximumFractionDigits: 2 })} olurdu; dönem tavanı ${Number(campaign.periodCap).toLocaleString('tr-TR', { maximumFractionDigits: 2 })} ile sınırlandı.`);
  if (!rawRemainingKnown) extraWarnings.push('Kalan dönem hakkı bilinmiyor; gösterilen değer dönem tavanıyla sınırlı teorik üst sınırdır. Bankadaki kalan hakkı doğrula.');
  if (rawRemainingKnown && freshnessInfo.status === 'stale') extraWarnings.push(`Kalan limit bilgisi eski (${freshnessInfo.label}); bankadaki güncel kalan hakkı doğrulamadan kesin kazanç hesaplanamaz.`);
  const conditional = inspection.warnings.length > 0 || campaign.rulesComplete === false || progressUnknown || freshnessInfo.status === 'stale';

  return {
    campaign,
    eligible: true,
    potential: false,
    inspection: { ...inspection, warnings: [...inspection.warnings, ...extraWarnings] },
    state: normalizedState,
    theoreticalReward: theoretical,
    perTransactionReward: capped.perTransaction,
    periodCapApplied: capped.periodCapApplied,
    actualReward: actual,
    remainingKnown,
    enrollmentMissing,
    progress,
    conditional,
    freshness: freshnessInfo
  };
}

export function recommend({ cards, campaigns, states, merchant, category, amount, locationScope = 'domestic', paymentChannel = 'physical', now = new Date(), staleAfterDays = 3, eligibilityContext = null }) {
  const ctx = eligibilityContext || buildEligibilityContext({ cards });
  return cards.filter(c => c.active !== false).map(card => {
    const allInspections = campaigns
      .filter(campaign => campaignTargetsCard(campaign, card, ctx))
      .map(campaign => evaluateCampaign({
        campaign,
        state: states[campaign.id],
        card,
        merchant,
        category,
        amount,
        locationScope,
        paymentChannel,
        now,
        staleAfterDays,
        eligibilityContext: ctx
      }));

    const evaluations = allInspections
      .filter(e => e.eligible)
      .sort((a, b) => {
        const ar = a.actualReward === null ? a.theoreticalReward : a.actualReward;
        const br = b.actualReward === null ? b.theoreticalReward : b.actualReward;
        if (a.conditional !== b.conditional) return a.conditional ? 1 : -1;
        return br - ar;
      });

    const potentials = allInspections
      .filter(e => e.potential)
      .sort((a, b) => {
        const ag = a.actionableBlockers.find(x => x.code === 'min_spend')?.gap ?? Number.POSITIVE_INFINITY;
        const bg = b.actionableBlockers.find(x => x.code === 'min_spend')?.gap ?? Number.POSITIVE_INFINITY;
        return ag - bg;
      });

    const informational = allInspections.filter(e => e.informational);
    const best = evaluations.find(e => !e.enrollmentMissing) || evaluations[0] || null;
    const rejected = allInspections.filter(e => !e.eligible && !e.potential && !e.informational);
    return { card, best, all: evaluations, potentials, informational, rejected };
  }).sort((a, b) => {
    const score = x => {
      if (!x.best) return x.potentials?.length ? -0.25 : -1;
      if (x.best.enrollmentMissing) return 0;
      const reward = x.best.actualReward === null ? x.best.theoreticalReward * 0.9 : x.best.actualReward;
      return x.best.conditional ? reward * 0.95 : reward;
    };
    return score(b) - score(a);
  });
}
