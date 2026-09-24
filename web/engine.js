export function money(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'Bilinmiyor';
  return new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY', maximumFractionDigits: 2 }).format(Number(value));
}

export function currentPeriodKey(campaign, date = new Date()) {
  const d = new Date(date);
  if (campaign.resetPolicy === 'monthly') {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  if (campaign.resetPolicy === 'campaign') {
    return `${campaign.id}:${campaign.startDate || ''}:${campaign.endDate || ''}`;
  }
  return `${campaign.id}:static`;
}

export function campaignIsActive(campaign, date = new Date()) {
  const now = new Date(date);
  const start = campaign.startDate ? new Date(`${campaign.startDate}T00:00:00`) : null;
  const end = campaign.endDate ? new Date(`${campaign.endDate}T23:59:59`) : null;
  if (start && now < start) return false;
  if (end && now > end) return false;
  return campaign.status !== 'inactive' && campaign.status !== 'expired';
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
  return { recognized: true, canonicalName: best.canonicalName, score: best.score, categories: best.categories || [], matches: [], source: 'registry' };
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
    if (context.source === 'registry' && context.categories.length === 1 && !context.categories.includes(selectedCategory)) {
      effectiveCategory = context.categories[0];
      notices.push(`Kategori uyuşmazlığı: “${context.canonicalName}” güvenilir işyeri sözlüğünde “${effectiveCategory}” olarak tanınıyor. “${selectedCategory}” yerine “${effectiveCategory}” kullanıldı.`);
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

export function resolveSegmentCampaign(campaign, card) {
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

function blocker(code, message, kind = 'hard', meta = {}) {
  return { code, message, kind, ...meta };
}

export function inspectCampaign({ campaign, card, merchant, category, amount, locationScope = 'domestic', paymentChannel = 'physical', now = new Date() }) {
  const blockers = [];
  const warnings = [];

  if (!campaignIsActive(campaign, now)) blockers.push(blocker('inactive', 'Kampanya şu anda aktif değil.', 'hard'));
  if (!campaign.cardProductIds?.includes(card.cardProductId)) blockers.push(blocker('card_product', 'Bu kart tipi kampanyaya dahil değil.', 'hard'));
  if (!segmentMatches(campaign, card)) blockers.push(blocker('segment', `Kart segmenti uygun değil (${card.segment || 'segment bilinmiyor'}).`, 'hard'));
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

export function ensureReset(campaign, state, date = new Date()) {
  const expectedKey = currentPeriodKey(campaign, date);
  // Kampanya ilk kez katalogda görülüyorsa kullanıcının ay/dönem içindeki önceki kullanımını bilemeyiz.
  // Bu nedenle dönem tavanını "kalan hak" diye varsayma; kullanıcı doğrulayana kadar bilinmiyor tut.
  if (!state) {
    return {
      campaignId: campaign.id,
      periodKey: expectedKey,
      enrollmentStatus: campaign.requiresEnrollment ? 'unknown' : 'not_required',
      remainingLimit: null,
      usedAmount: null,
      qualifyingTransactions: null,
      valueSource: 'unknown',
      confirmedAt: null,
      updatedAt: new Date(date).toISOString(),
      notes: 'Kampanya ilk kez görüldü; dönem içindeki önceki kullanım bilinmediği için kalan hak kullanıcı doğrulaması bekliyor.'
    };
  }
  if (state.periodKey !== expectedKey) {
    return {
      campaignId: campaign.id,
      periodKey: expectedKey,
      enrollmentStatus: campaign.requiresEnrollment ? 'unknown' : 'not_required',
      remainingLimit: campaign.periodCap ?? null,
      usedAmount: 0,
      qualifyingTransactions: null,
      valueSource: 'reset',
      confirmedAt: new Date(date).toISOString(),
      updatedAt: new Date(date).toISOString(),
      notes: 'Dönem değişiminde otomatik sıfırlandı.'
    };
  }
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

export function evaluateCampaign({ campaign, state, card, merchant, category, amount, locationScope = 'domestic', paymentChannel = 'physical', now = new Date(), staleAfterDays = 3 }) {
  campaign = resolveSegmentCampaign(campaign, card);
  const inspection = inspectCampaign({ campaign, card, merchant, category, amount, locationScope, paymentChannel, now });
  const normalizedState = ensureReset(campaign, state, now);

  if (!inspection.eligible) {
    const hardBlockers = inspection.blockers.filter(b => b.kind === 'hard');
    const actionableBlockers = inspection.blockers.filter(b => b.kind === 'actionable');
    const potential = hardBlockers.length === 0 && actionableBlockers.length > 0;
    const minBlock = actionableBlockers.find(b => b.code === 'min_spend');
    const rewardAtThreshold = minBlock ? calcTheoreticalReward(campaign, minBlock.requiredAmount) : 0;
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

  const theoretical = calcTheoreticalReward(campaign, amount);
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
  if (rawRemainingKnown && freshnessInfo.status === 'stale') extraWarnings.push(`Kalan limit bilgisi eski (${freshnessInfo.label}); bankadaki güncel kalan hakkı doğrulamadan kesin kazanç hesaplanamaz.`);
  const conditional = inspection.warnings.length > 0 || campaign.rulesComplete === false || progressUnknown || freshnessInfo.status === 'stale';

  return {
    campaign,
    eligible: true,
    potential: false,
    inspection: { ...inspection, warnings: [...inspection.warnings, ...extraWarnings] },
    state: normalizedState,
    theoreticalReward: theoretical,
    actualReward: actual,
    remainingKnown,
    enrollmentMissing,
    progress,
    conditional,
    freshness: freshnessInfo
  };
}

export function recommend({ cards, campaigns, states, merchant, category, amount, locationScope = 'domestic', paymentChannel = 'physical', now = new Date(), staleAfterDays = 3 }) {
  return cards.filter(c => c.active !== false).map(card => {
    const allInspections = campaigns
      .filter(campaign => campaign.cardProductIds?.includes(card.cardProductId))
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
        staleAfterDays
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
