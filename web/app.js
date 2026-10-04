import { initialCards, initialCampaigns, initialStates } from './bootstrap-data.js';
import { recommend, money, ensureReset, freshness, ruleMinSpend, resolveMerchantInput, resolveSegmentCampaign, NETWORK_MERCHANT_WARNING } from './engine.js';
import { calculateLoyalty, campaignRewardLabel, THY_STATUSES, QNB_SEGMENTS, WINGS_TIERS, MAXIMILES_BANDS, CRYSTAL_BANDS, CRYSTAL_CARD_TYPES, TEB_TIERS, formatNumber } from './loyalty.js';
import { CAMPAIGN_BROWSER_CATEGORIES, groupCampaignsByCard, catalogSecondary, merchantScopeInfo, paymentScopeInfo } from './campaign-browser.js';
import { cloudConfigured, cloudConfigSummary, sessionInfo, signUp, signIn, signOut, testCloudConnection, fetchCloudCatalog, fetchCloudUserState, saveCloudUserState, triggerCloudRefresh, requestPasswordReset, updatePassword, captureAuthCallback, getAccessToken } from './cloud-sync.js';
import { BUNDLED_PROFILE_CATALOG, PROFILE_CATALOG_SCHEMA } from './profile-catalog.js';
import { effectiveAttributes, optionDisplayLabel, attributeConfirmationStatus, currentCriteria, REQUIRES_RECONFIRMATION } from './profile-criteria.js';
import { normalizeLegacySettings } from './legacy-option-aliases.js';
import { bankCoverage, allBankCoverage, supportBadge, recommendationCoverageNote } from './coverage.js';
import { normalizeBankRequestName } from './bank-requests.js';
import { legacyCardFields, banksWithoutCardProducts, emptyProfile, normalizeProfile, applicableDimensions, toggleBank, toggleCard, setAttribute, confirmAttribute, confirmPendingAttributes, isProfileComplete, canCompleteOnboarding, profileToEngineCards, profileToLegacySettings, legacyToProfilePrefill, diffProfiles, banksAffectedByAttributeChange, nextOnboardingStep, previousOnboardingStep } from './profile-model.js';
import { createProfileStore, SchemaMissingError, readProfileCache, writeProfileCache } from './profile-store.js';
import { buildEligibilityContext, attributesFromLegacySettings, campaignTargetsCard } from './eligibility.js';
import { mergeCatalogWithCore as mergeCatalogWithCoreRules, reconcileCampaignStates as reconcileStatesRules, invalidateSegmentDependentStates as invalidateSegmentRules, applyCloudRow, isLocalServerMode } from './catalog-state.js';
import { APP_VERSION } from './version.js';
import { resolveRoute, guardRoute, DEFAULT_ROUTE } from './router.js';
import { buildInfoRows, RELEASE_NOTES } from './app-info.js';
import { BUILD_INFO } from './build-info.js';

const STORAGE_KEY = 'banka-kampanya-avcisi-v10';
// v1.4: kişisel yerel veri (kalan limit/katılım/özel kampanya önbelleği) kullanıcı kimliğine göre ayrılır.
let storageKey = STORAGE_KEY;
const LEGACY_CLAIM_KEY = 'bka-legacy-device-data-claimed-by';
const userStorageKey = uid => `${STORAGE_KEY}:u:${uid}`;
// Hesap durumu. mode: 'legacy' (bulut yapılandırılmamış veya profil şeması yok) | 'profile' (hesaba bağlı profil)
// Bulut yapılandırılmışsa ilk çizimden itibaren hesap modundayız: oturum doğrulanana kadar hiçbir kişisel veri gösterilmez.
let account = { mode: cloudConfigured() ? 'profile' : 'legacy', state: cloudConfigured() ? 'loading' : 'ready', userId: null, email: null, profile: null, serverProfile: null, catalog: BUNDLED_PROFILE_CATALOG, master: null, store: null, notice: null };
const REFRESH_API = '';
// /api/* uçları yalnız yerel geliştirme sunucusunda (localhost) vardır; GitHub Pages'te çağrılmaz.
const LOCAL_API = isLocalServerMode();
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

function clone(v) { return JSON.parse(JSON.stringify(v)); }
function esc(v) { return String(v ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }


const CORE_BENEFITS = initialCampaigns.filter(c => c.coreBenefit === true);

function mergeCatalogWithCore(campaigns = [], existingCampaigns = []) {
  return mergeCatalogWithCoreRules(campaigns, { coreBenefits: CORE_BENEFITS, existingCampaigns, now: new Date() });
}

function ensureCoreBenefitsInData() {
  data.campaigns = mergeCatalogWithCore(data.campaigns || [], data.campaigns || []);
  data.states = data.states || {};
  for (const core of CORE_BENEFITS) {
    if (!data.states[core.id] && initialStates[core.id]) data.states[core.id] = clone(initialStates[core.id]);
  }
}

let lastQueryDebug = null;
let runtimeAppVersion = APP_VERSION;
let campaignBrowserState = { category: 'all', search: '', selectedKey: null };

function diagnosticEval(e) {
  if (!e) return null;
  const c = e.campaign || {};
  return {
    campaign: {
      id: c.id, bank: c.bank, title: c.title, categories: c.categories, categorySource: c.categorySource, categoryConfidence: c.categoryConfidence, merchantScope: c.merchantScope,
      cardProductIds: c.cardProductIds, rulesComplete: c.rulesComplete, sourceKey: c.sourceKey, sourceUrl: c.sourceUrl,
      rewardRule: c.rewardRule, transactionRules: c.transactionRules, eligibility: c.eligibility
    },
    eligible: e.eligible, potential: e.potential, informational: e.informational, conditional: e.conditional,
    theoreticalReward: e.theoreticalReward, actualReward: e.actualReward, remainingKnown: e.remainingKnown,
    enrollmentMissing: e.enrollmentMissing,
    blockers: e.inspection?.blockers || [], warnings: e.inspection?.warnings || [], merchant: e.inspection?.merchant || null
  };
}

function setLastQueryDebug(payload) {
  lastQueryDebug = {
    appVersion: runtimeAppVersion,
    generatedAt: new Date().toISOString(),
    catalogGeneratedAt: data?.meta?.catalogGeneratedAt || null,
    catalogMeta: data?.meta?.catalogMeta || null,
    ...payload
  };
  try { localStorage.setItem('banka-kampanya-avcisi-last-query-debug', JSON.stringify(lastQueryDebug)); } catch {}
}

function downloadLastQueryDebug() {
  if (!lastQueryDebug) {
    try { lastQueryDebug = JSON.parse(localStorage.getItem('banka-kampanya-avcisi-last-query-debug') || 'null'); } catch {}
  }
  if (!lastQueryDebug) return alert('Henüz tanı logu oluşturacak bir sorgu yapılmadı. Önce “Kartları karşılaştır” ile bir sorgu yap.');
  const blob = new Blob([JSON.stringify(lastQueryDebug, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const safeMerchant = String(lastQueryDebug?.input?.merchant || 'sorgu').replace(/[^a-zA-Z0-9çğıöşüÇĞİÖŞÜ_-]+/g, '-').slice(0,40);
  a.download = `kampanya-avcisi-tani-${safeMerchant}-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
  a.click(); URL.revokeObjectURL(a.href);
}

function seed() {
  return {
    cards: clone(initialCards),
    campaigns: clone(initialCampaigns),
    states: clone(initialStates),
    settings: { staleAfterDays: 3, thyStatus: 'classic', qnbSegment: 'private', wingsTier: 'black_plus', maximilesBand: 'band_3', crystalBand: 'band_1', crystalCardType: 'crystal', tebTier: 'ultra' },
    meta: { version: 13, createdAt: new Date().toISOString(), catalogGeneratedAt: null }
  };
}

let data = load();
ensureCoreBenefitsInData();
syncCardSegmentsFromSettings();

function load(key = storageKey) {
  try {
    const raw = localStorage.getItem(key);
    const loaded = raw ? JSON.parse(raw) : seed();
    // v1.4.3: cihazdaki eski eşik kodlu bant seçimleri nötr kodlara çevrilir (tek dönüşüm noktası: legacy-option-aliases.js).
    loaded.settings = normalizeLegacySettings({
      staleAfterDays: 3, thyStatus: 'classic', qnbSegment: 'private', wingsTier: 'black_plus',
      maximilesBand: 'band_3', crystalBand: 'band_1', crystalCardType: 'crystal', tebTier: 'ultra',
      ...(loaded.settings || {})
    });
    const previousVersion = Number(loaded.meta?.version || 0);
    loaded.meta = { version: 13, ...(loaded.meta || {}), version: 13 };
    if (previousVersion < 13) {
      // v1.1.1 changes category semantics. Do not keep an old live catalog whose
      // sectors were inferred from page chrome. Preserve user-added private
      // campaigns, settings and progress/limit state; refresh official data.
      const privateCampaigns = (loaded.campaigns || []).filter(c => c.sourceKind === 'user_private');
      loaded.campaigns = [...clone(initialCampaigns), ...privateCampaigns];
      loaded.meta.catalogGeneratedAt = null;
      loaded.meta.catalogMeta = {};
      loaded.meta.categoryMigrationRequired = true;
    }
    return loaded;
  } catch { return seed(); }
}

function syncCardSegmentsFromSettings() {
  // v1.4: hesaba bağlı profil varsa kartlar ve segmentler YALNIZ profilden gelir (profil her zaman kazanır).
  if (account.mode === 'profile' && account.profile) {
    data.cards = profileToEngineCards(account.profile, account.catalog);
    Object.assign(data.settings, profileToLegacySettings(account.profile, account.catalog));
    if (Number.isFinite(Number(account.profile.preferences?.staleAfterDays))) data.settings.staleAfterDays = Number(account.profile.preferences.staleAfterDays);
    data.profileMode = true;
    return;
  }
  if (account.mode === 'profile') { data.cards = []; return; }
  // v1.5.0: ürüne özel dal yok — kart alanları ana veriden (boyut ↔ ayar anahtarı ↔ kart ürünü) türetilir.
  const defaults = seed().settings;
  for (const card of data.cards || []) {
    const f = legacyCardFields(card.cardProductId, data.settings, BUNDLED_PROFILE_CATALOG, defaults);
    if (f.segment != null) { card.segment = f.segment; card.segmentLabel = f.segmentLabel; }
    if (f.cardType !== undefined) card.cardType = f.cardType;
  }
}

function invalidateSegmentDependentStates(bank) {
  data.states = invalidateSegmentRules({ campaigns: data.campaigns || [], states: data.states || {}, bank, now: new Date() });
}

function save() {
  // Hesap modunda oturum yokken hiçbir şey yazılmaz (cihazdaki eski veri ve diğer kullanıcıların önbelleği korunur).
  if (account.mode === 'profile' && !account.userId) return;
  data.meta = {...(data.meta||{}), updatedAt:new Date().toISOString()};
  try { localStorage.setItem(storageKey, JSON.stringify(data)); } catch {}
}

function cardForCampaign(campaign) {
  return (data.cards || []).find(card => campaignTargetsCard(campaign, card)) || null;
}

function effectiveCampaign(campaign) {
  const card = cardForCampaign(campaign);
  return card ? resolveSegmentCampaign(campaign, card, new Date(), eligibilityContext()) : resolveSegmentCampaign(campaign, { segment: null }, new Date(), eligibilityContext());
}

function syncResets() {
  let changed = false;
  for (const rawCampaign of data.campaigns) {
    const campaign = effectiveCampaign(rawCampaign);
    const next = ensureReset(campaign, data.states[campaign.id], new Date());
    if (JSON.stringify(next) !== JSON.stringify(data.states[campaign.id])) {
      data.states[campaign.id] = next;
      changed = true;
    }
  }
  if (changed) save();
}

function badge(text, cls='') { return `<span class="badge ${cls}">${esc(text)}</span>`; }

function rewardRuleSummary(c) {
  const r = c.rewardRule || {};
  const txCap = r.perTransactionCap ?? c.perTransactionCap;
  let main = '';
  if (r.kind === 'percent') main = `%${Math.round(Number(r.rate || 0) * 100)}`;
  else if (r.kind === 'fixed') main = `${campaignRewardLabel(c, r.reward)} sabit`;
  else if (r.kind === 'tiered_percent') main = (r.tiers || []).map(t => `${money(t.min)}${t.max != null ? `–${money(t.max)}` : '+'}: %${Math.round(Number(t.rate || 0) * 100)}`).join(' · ');
  else if (r.kind === 'tiered_fixed') main = (r.tiers || []).map(t => `${money(t.min)}+: ${campaignRewardLabel(c, t.reward)}`).join(' · ');
  else if (r.kind === 'miles') main = `${r.tryPerMile || '?'} TL / Mil`;
  else if (r.kind === 'non_cash') main = 'Nakit/puan dışı avantaj';
  else if (r.kind === 'unknown') main = 'Koşullar bulundu; otomatik hesap henüz kesin değil';

  const min = ruleMinSpend(c);
  const parts = [main];
  if (min > 0) parts.push(`alt limit ${money(min)}`);
  if (txCap != null) parts.push(`işlem tavanı ${money(txCap)}`);
  if (c.periodCap != null) parts.push(`dönem tavanı ${campaignRewardLabel(c, c.periodCap)}`);
  if (c.transactionRules?.rewardStartsFromQualifyingTransaction > 1) parts.push(`${c.transactionRules.rewardStartsFromQualifyingTransaction}. uygun işlemden itibaren ödül`);
  return parts.filter(Boolean).join(' · ');
}

function renderDashboard() {
  $('#cardCount').textContent = data.cards.filter(c => c.active).length;
  $('#campaignCount').textContent = data.campaigns.filter(c => c.status !== 'inactive').length;
  const stale = data.campaigns.filter(c => freshness(data.states[c.id], new Date(), data.settings.staleAfterDays).status === 'stale').length;
  $('#staleCount').textContent = stale;
  const unknown = data.campaigns.filter(c => data.states[c.id]?.remainingLimit === null || data.states[c.id]?.remainingLimit === undefined).length;
  $('#unknownCount').textContent = unknown;

  const health = $('#catalogHealth');
  if (health) {
    const m = data.meta?.catalogMeta || {};
    const generated = data.meta?.catalogGeneratedAt;
    const reports = Array.isArray(m.source_reports) ? m.source_reports : [];
    const errors = reports.reduce((n,r) => n + (r.errors?.length || 0), 0);
    if (generated) {
      const covered = reports.filter(r => (r.kept_count || 0) > 0).length;
      const expectedSources = ['qnb_ms','qnb_private','qnb_card','wings','axess_general','maximiles','world','crystal_special','teb','teb_general'];
      const byKey = new Map(reports.map(r => [r.key, r]));
      const missingSources = expectedSources.filter(k => !byKey.has(k));
      const zeroSources = reports.filter(r => expectedSources.includes(r.key) && Number(r.kept_count || 0) === 0).map(r => r.key);
      const sourceAlert = [...new Set([...missingSources.map(x => `${x}: rapor yok`), ...zeroSources.map(x => `${x}: 0 kayıt`)])];
      const coreCount = data.campaigns.filter(c => c.coreBenefit).length;
      health.innerHTML = `<strong>Canlı katalog:</strong> ${esc(m.campaign_count ?? 0)} canlı kampanya + ${esc(coreCount)} sürekli kart ayrıcalığı · ${esc(covered)}/${esc(reports.length || '?')} resmi kaynakta uygun kayıt · ${esc(errors)} kaynak hatası · son tarama ${esc(formatRefreshTime(generated))} · sürüm ${esc(runtimeAppVersion)}.${sourceAlert.length ? `<br><strong>Kaynak kontrolü:</strong> ${sourceAlert.map(esc).join(' · ')}` : ''}${m.guard && m.guard.verdict && m.guard.verdict !== 'ok' ? `<br><strong>Kalite kapısı:</strong> ${m.guard.verdict === 'repaired' ? `onarıldı — ${esc((m.guard.repairedSources || []).join(', '))} için son başarılı kayıtlar korunuyor` : 'yeni tarama reddedildi; son başarılı katalog gösteriliyor'}` : ''}`;
      health.classList.toggle('warn', errors > 0 || sourceAlert.length > 0 || (m.guard && m.guard.verdict && m.guard.verdict !== 'ok'));
    } else {
      health.innerHTML = '<strong>Başlangıç kataloğu:</strong> Canlı resmi tarama arka planda başlatılıyor. Profil → Veriler ve Özet → Şimdi yenile ile durumu kontrol edebilirsin.';
    }
  }

  $('#cardsGrid').innerHTML = data.cards.map(card => `
    <article class="card-item">
      <div class="bank">${esc(card.bank)}</div>
      <h3>${esc(card.name)}</h3>
      <div class="muted">${esc(card.segmentLabel || card.segment)}</div>
    </article>`).join('');
}

function campaignBrowseKey(card, campaign) {
  return `${card.cardProductId}::${campaign.id}`;
}

function browseSearchMatch(campaign, search) {
  const q = String(search || '').trim().toLocaleLowerCase('tr-TR');
  if (!q) return true;
  const merchant = campaign.merchantScope || {};
  const hay = [
    campaign.title, campaign.bank, campaign.termsSummary,
    ...(campaign.categories || []), ...(merchant.values || []), ...(merchant.excludedValues || [])
  ].filter(Boolean).join(' ').toLocaleLowerCase('tr-TR');
  return hay.includes(q);
}

function campaignTypeBadge(c) {
  if (c.sourceKind === 'user_private') return badge('SANA ÖZEL', 'demo');
  if (c.coreBenefit) return badge('SÜREKLİ KART AYRICALIĞI', 'ok');
  if (c.rulesComplete === false) return badge('RESMİ · KISMİ ÇÖZÜM', 'warn');
  return badge('RESMİ · CANLI', 'ok');
}

function browserEnrollmentBadge(c, s) {
  if (!c.requiresEnrollment) return '';
  return s.enrollmentStatus === 'joined' ? badge('Katıldın', 'ok') : badge('Katılım gerekiyor', 'danger');
}

function categoryAuditInfo(c) {
  const labels = (c.categories || []).map(v => CAMPAIGN_BROWSER_CATEGORIES.find(([x]) => x === v)?.[1] || v);
  const srcMap = {
    official_category_page: 'Bankanın resmi kategori sayfası',
    title_brand: 'Kampanya başlığındaki marka',
    title_keywords: 'Kampanya başlığındaki sektör ifadesi',
    campaign_summary: 'Kısa kampanya özeti',
    unclassified: 'Otomatik sınıflandırma yapılamadı',
  };
  return {
    categories: labels.length ? labels.join(', ') : 'Diğer / sınıflandırılmamış',
    source: srcMap[c.categorySource] || (c.coreBenefit ? 'Doğrulanmış sürekli ayrıcalık' : 'Kaynak belirtilmemiş'),
    low: c.categoryConfidence === 'low' || (c.categories || []).includes('diger'),
  };
}

function campaignCompactHtml(card, c) {
  const s = data.states[c.id] || {};
  const merchant = merchantScopeInfo(c);
  const key = campaignBrowseKey(card, c);
  const selected = campaignBrowserState.selectedKey === key ? ' selected' : '';
  const merchantText = merchant.kind === 'all' ? '' : `<div class="campaign-scope-preview"><strong>${esc(merchant.title)}:</strong> ${esc(merchant.text)}</div>`;
  return `<button type="button" class="campaign-browser-item${selected}" data-browse-select="${esc(key)}">
    <div class="campaign-browser-item-head"><strong>${esc(c.title)}</strong><span class="campaign-chevron">›</span></div>
    <div class="rule-line">${esc(rewardRuleSummary(c))}</div>
    ${merchantText}
    <div class="badges">${c.expiredCore ? badge('Dönem bitti · doğrulama bekliyor', 'warn') : ''}${c.officialDateConflict ? badge('Resmi tarih çelişkisi', 'warn') : ''}${c.liveExtendedValidity ? badge('Yeni dönem · kurallar teyitsiz', 'warn') : ''}${browserEnrollmentBadge(c,s)}${c.coreBenefit ? badge('Sürekli', 'ok') : ''}${c.rulesComplete === false ? badge('Detay eksik', 'warn') : ''}${categoryAuditInfo(c).low ? badge('Kategori teyitsiz', 'warn') : ''}</div>
  </button>`;
}

function campaignTransactionConditions(c) {
  const tx = c.transactionRules || {};
  const bits = [];
  if (tx.sameDaySameMerchantFirstOnly) bits.push('Aynı gün aynı işyerindeki yalnız ilk işlem sayılabilir.');
  if (tx.differentDaysRequired) bits.push('Uygun işlemlerin farklı günlerde yapılması gerekir.');
  if (tx.differentMerchantsRequired) bits.push('Uygun işlemlerin farklı işyerlerinde yapılması gerekir.');
  if (tx.rewardStartsFromQualifyingTransaction > 1) bits.push(`Ödül ${tx.rewardStartsFromQualifyingTransaction}. uygun işlemden itibaren başlar.`);
  if (tx.customerLevel) bits.push('Kampanya müşteri bazındadır.');
  if (tx.cumulativeSpendCampaign) bits.push('Kampanya dönem içi toplam/birikmiş harcamaya bağlıdır.');
  if (tx.nonStackable) bits.push('Başka indirim veya kampanyalarla birleştirilemeyebilir.');
  return bits;
}

function renderCampaignDetail(groups) {
  const panel = $('#campaignDetail');
  if (!panel) return;
  let selected = null;
  for (const group of groups) {
    for (const c of [...group.campaigns, ...(group.informational || [])]) {
      if (campaignBrowseKey(group.card, c) === campaignBrowserState.selectedKey) {
        selected = {card: group.card, campaign: c};
        break;
      }
    }
    if (selected) break;
  }
  if (!selected) {
    panel.innerHTML = '<div class="campaign-detail-empty">Detayını görmek için listeden bir kampanya seç.</div>';
    return;
  }
  const {card, campaign:c} = selected;
  const s = data.states[c.id] || {};
  const f = freshness(s, new Date(), data.settings.staleAfterDays);
  const merchant = merchantScopeInfo(c);
  const payment = paymentScopeInfo(c);
  const tx = c.transactionRules || {};
  const excluded = tx.excludedCategories || [];
  const txnBits = campaignTransactionConditions(c);
  const end = c.endDate || 'Süresiz / güncel koşul';
  const remaining = s.remainingLimit == null ? 'Bilinmiyor' : campaignRewardLabel(c, s.remainingLimit);
  const scopeClass = merchant.kind === 'restricted_unknown' ? 'scope-warning' : 'scope-box';
  const categoryAudit = categoryAuditInfo(c);
  const categoryHtml = `<div class="detail-section ${categoryAudit.low ? 'scope-warning' : ''}"><div class="detail-label">Kategori / sektör</div><div class="detail-value">${esc(categoryAudit.categories)}</div><div class="muted detail-sub">Kaynak: ${esc(categoryAudit.source)}</div>${categoryAudit.low ? '<div class="detail-warning">Kategori güvenle doğrulanamadı; spesifik kategori listelerinde gösterilmez.</div>' : ''}</div>`;
  panel.innerHTML = `<div class="campaign-detail-inner">
    <div class="campaign-detail-head">
      <div><div class="bank">${esc(card.bank)} — ${esc(card.name)}</div><h3>${esc(c.title)}</h3><div class="muted">${esc(card.segmentLabel || card.segment)} · ${esc(c.startDate || '?')} → ${esc(end)}</div></div>
      <div class="badges">${campaignTypeBadge(c)}${browserEnrollmentBadge(c,s)}</div>
    </div>
    <div class="detail-section"><div class="detail-label">Kazanç / koşul</div><div class="detail-value">${esc(rewardRuleSummary(c) || 'Koşul otomatik hesaplanamadı')}</div></div>
    ${categoryHtml}
    <div class="detail-section ${scopeClass}"><div class="detail-label">${esc(merchant.title)}</div><div class="detail-value">${esc(merchant.text)}</div>
      ${merchant.warning ? `<div class="detail-warning">${esc(merchant.warning)}</div>` : ''}
      ${merchant.excluded?.length ? `<div class="muted detail-sub"><strong>Hariç işyerleri/şubeler:</strong> ${esc(merchant.excluded.join(', '))}</div>` : ''}
    </div>
    <div class="detail-grid">
      <div class="detail-section"><div class="detail-label">İşlem yeri</div><div class="detail-value">${esc(payment.location)}</div></div>
      <div class="detail-section"><div class="detail-label">Ödeme kanalı</div><div class="detail-value">${esc(payment.channels.length ? payment.channels.join(', ') : 'Özel kanal şartı belirtilmemiş')}</div></div>
      <div class="detail-section"><div class="detail-label">POS şartı</div><div class="detail-value">${esc(payment.requiredPos || 'Özel POS şartı belirtilmemiş')}</div></div>
      <div class="detail-section"><div class="detail-label">Kalan hak</div><div class="detail-value">${esc(remaining)}</div><div class="muted">${esc(f.label || '')}</div></div>
    </div>
    ${c.requiresEnrollment ? `<div class="detail-section participation-box"><div class="detail-label">Katılım</div><div class="detail-value">${s.enrollmentStatus === 'joined' ? 'Katıldın' : 'Katılım gerekiyor'}</div>${c.enrollmentMethod ? `<div class="muted detail-sub">${esc(c.enrollmentMethod)}</div>` : ''}</div>` : ''}
    ${excluded.length ? `<div class="detail-section"><div class="detail-label">Hariç işlemler / kategoriler</div><div class="detail-value detail-list">${excluded.map(x=>`<span>${esc(x)}</span>`).join('')}</div></div>` : ''}
    ${txnBits.length ? `<div class="detail-section"><div class="detail-label">Diğer önemli koşullar</div><ul class="campaign-detail-list">${txnBits.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
    ${c.termsSummary ? `<div class="detail-section"><div class="detail-label">Özet koşullar</div><div class="detail-value detail-copy">${esc(c.termsSummary)}</div></div>` : ''}
    ${c.expiredCore ? `<div class="detail-warning strong-warning">Bu sürekli ayrıcalığın doğrulanmış dönemi ${esc(c.endDate)} tarihinde sona erdi; yeni dönem koşulları henüz doğrulanmadı. Karar motoru bu kaydı hesaba katmaz; resmi sayfayı kontrol et.</div>` : ''}
    ${(c.officialSources || []).length ? `<div class="detail-section ${c.officialDateConflict ? 'scope-warning' : ''}"><div class="detail-label">Onaylı resmi kaynaklar${c.officialDateConflict ? ' · tarih çelişkisi' : ''}</div><ul class="campaign-detail-list">${c.officialSources.map(x=>`<li><a class="source-link" href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.label || x.url)}</a> — bitiş ${esc(x.endDate || 'belirtilmemiş')}${x.liveUpdated ? ' (canlı görüldü)' : ''}</li>`).join('')}</ul>${c.officialDateConflict ? `<div class="detail-warning">Kullanılan bitiş: ${esc(c.officialDateConflict.chosenEndDate)} (${c.officialDateConflict.policy === 'earliest_official' ? 'en erken' : 'en geç'} resmi tarih). İşlemden önce teyit et.</div>` : ''}</div>` : ''}
    ${(c.decisionWarnings || []).length ? `<div class="detail-section"><div class="detail-label">Karar uyarıları</div><ul class="campaign-detail-list">${c.decisionWarnings.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
    ${c.rulesComplete === false ? `<div class="detail-warning strong-warning">Bu kampanyanın tüm koşulları otomatik olarak kesin çözülememiş. Resmi koşulları kontrol et.</div>` : ''}
    <div class="button-row campaign-detail-actions">
      <button class="secondary small" data-edit-limit="${esc(c.id)}">Kalan hakkı güncelle</button>
      ${c.transactionRules?.rewardStartsFromQualifyingTransaction > 1 ? `<button class="secondary small" data-edit-progress="${esc(c.id)}">İlerlemeyi güncelle</button>` : ''}
      ${c.requiresEnrollment ? `<button class="secondary small" data-toggle-enroll="${esc(c.id)}">${s.enrollmentStatus === 'joined' ? 'Katılımı geri al' : 'Katıldım'}</button>` : ''}
      ${c.sourceUrl ? `<a class="secondary small source-action" href="${esc(c.sourceUrl)}" target="_blank" rel="noopener">Resmi koşulları aç ↗</a>` : ''}
    </div>
  </div>`;
}

function renderCampaigns() {
  const categoryEl = $('#campaignBrowseCategory');
  if (categoryEl && !categoryEl.options.length) {
    categoryEl.innerHTML = CAMPAIGN_BROWSER_CATEGORIES.map(([value,label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join('');
  }
  if (categoryEl) categoryEl.value = campaignBrowserState.category;
  const searchEl = $('#campaignBrowseSearch');
  if (searchEl && searchEl.value !== campaignBrowserState.search) searchEl.value = campaignBrowserState.search;
  const ctx = eligibilityContext();
  const now = new Date();
  const searchOk = c => browseSearchMatch(c, campaignBrowserState.search);
  let groups = groupCampaignsByCard({
    campaigns: data.campaigns,
    cards: data.cards,
    category: campaignBrowserState.category,
    resolveCampaign: (raw, card, when, cx) => resolveSegmentCampaign(raw, card, when, cx),
    now,
    eligibilityContext: ctx
  }).map(group => ({
    ...group,
    campaigns: group.campaigns.filter(searchOk),
    informational: (group.informational || []).filter(searchOk)
  }));
  // v1.5.0: global katalogdaki ama kartlarına kesin uygulanmayan kayıtlar (ayrı, kapalı bölümler).
  const secondary = catalogSecondary({ campaigns: data.campaigns, cards: data.cards, category: campaignBrowserState.category, now, eligibilityContext: ctx,
    bankCodes: account.mode === 'profile' && account.profile ? account.profile.banks : null });
  const unresolved = secondary.unresolved.filter(searchOk);
  const otherCards = secondary.otherCards.filter(searchOk);

  const total = groups.reduce((n,g) => n + g.campaigns.length, 0);
  const categoryLabel = CAMPAIGN_BROWSER_CATEGORIES.find(([v]) => v === campaignBrowserState.category)?.[1] || 'Kategori';
  const summary = $('#campaignBrowseSummary');
  if (summary) summary.innerHTML = `<strong>${esc(categoryLabel)}:</strong> kartlarında kesin geçerli ${esc(total)} kart-kampanya eşleşmesi. Aynı kampanya birden fazla kartında geçerliyse her kart grubunda ayrı görünür. Bilgi amaçlı ve uygunluğu belirsiz kayıtlar aşağıda ayrı bölümlerdedir.`;

  const currentKeys = new Set(groups.flatMap(g => [...g.campaigns, ...g.informational].map(c => campaignBrowseKey(g.card,c))));
  if (campaignBrowserState.selectedKey && !currentKeys.has(campaignBrowserState.selectedKey)) campaignBrowserState.selectedKey = null;

  const secondaryItem = c => `<li class="secondary-campaign"><strong>${esc(c.title)}</strong> <span class="muted">· ${esc(c.bank || '')}</span>${(c.eligibilityResolution?.reasons || [])[0] ? `<div class="muted small">${esc(c.eligibilityResolution.reasons[0])}</div>` : ''}${c.sourceUrl ? ` <a class="source-link" href="${esc(c.sourceUrl)}" target="_blank" rel="noopener">Resmi koşullar ↗</a>` : ''}</li>`;
  const container = $('#campaignList');
  container.innerHTML = groups.map(group => `<section class="campaign-card-group">
    <div class="campaign-card-group-head">
      <div><div class="bank">${esc(group.card.bank)}</div><h3>${esc(group.card.name)}</h3><div class="muted">${esc(group.card.segmentLabel || group.card.segment)}</div></div>
      <span class="campaign-count-pill">${esc(group.campaigns.length)} kampanya</span>
    </div>
    <div class="campaign-browser-items">${group.campaigns.length ? group.campaigns.map(c => campaignCompactHtml(group.card,c)).join('') : '<div class="empty-card-campaigns">Bu kategoride kesin geçerli aktif kampanya bulunamadı.</div>'}</div>
    ${group.informational.length ? `<details class="campaign-secondary info-secondary"><summary>Bilgi amaçlı (${esc(group.informational.length)}) — koşulları tam çözülemedi</summary><div class="campaign-browser-items">${group.informational.map(c => campaignCompactHtml(group.card,c)).join('')}</div></details>` : ''}
  </section>`).join('')
  + (unresolved.length ? `<details class="campaign-secondary unresolved-secondary"><summary>Kart uygunluğu doğrulanamayan kampanyalar (${esc(unresolved.length)})</summary><p class="muted small">Bankalarının resmi kaynağında bulundu; hangi kartlarda geçerli olduğu metinde açık değil. Hiçbir kartın için kesin uygun sayılmaz.</p><ul>${unresolved.map(secondaryItem).join('')}</ul></details>` : '')
  + (otherCards.length ? `<details class="campaign-secondary other-cards-secondary"><summary>Bankalarının diğer kartlarına ait kampanyalar (${esc(otherCards.length)})</summary><p class="muted small">Bu kampanyalar sahip olmadığın veya uygulamada henüz tanımlı olmayan kartlar için.</p><ul>${otherCards.map(secondaryItem).join('')}</ul></details>` : '');

  $$('[data-browse-select]').forEach(btn => btn.addEventListener('click', () => {
    campaignBrowserState.selectedKey = btn.dataset.browseSelect;
    renderCampaigns();
  }));
  renderCampaignDetail(groups);
  $$('[data-edit-limit]').forEach(btn => btn.addEventListener('click', () => editLimit(btn.dataset.editLimit)));
  $$('[data-edit-progress]').forEach(btn => btn.addEventListener('click', () => editProgress(btn.dataset.editProgress)));
  $$('[data-toggle-enroll]').forEach(btn => btn.addEventListener('click', () => toggleEnrollment(btn.dataset.toggleEnroll)));
}

function wireCampaignBrowser() {
  const cat = $('#campaignBrowseCategory');
  if (cat) cat.addEventListener('change', () => { campaignBrowserState.category = cat.value; campaignBrowserState.selectedKey = null; renderCampaigns(); });
  const search = $('#campaignBrowseSearch');
  if (search) search.addEventListener('input', () => { campaignBrowserState.search = search.value; campaignBrowserState.selectedKey = null; renderCampaigns(); });
}

function editLimit(id) {
  const rawCampaign = data.campaigns.find(x => x.id === id);
  const c = effectiveCampaign(rawCampaign);
  const s = data.states[id] || ensureReset(c, null, new Date());
  const current = s.remainingLimit ?? '';
  const raw = prompt(`${c.title}\nKalan kampanya ödül hakkını gir (kampanyanın kendi biriminde).\n(Bilinmiyor yapmak için boş bırak)`, current);
  if (raw === null) return;
  let value = null;
  if (String(raw).trim() !== '') {
    value = Number(String(raw).replace(',', '.'));
    if (!Number.isFinite(value) || value < 0) return alert('Geçerli ve sıfırdan büyük/eşit bir tutar gir.');
  }
  data.states[id] = {
    ...s,
    remainingLimit: value,
    valueSource: 'user_confirmed',
    confirmedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  save(); renderAll();
}

function editProgress(id) {
  const rawCampaign = data.campaigns.find(x => x.id === id);
  const c = effectiveCampaign(rawCampaign);
  const s = data.states[id] || ensureReset(c, null, new Date());
  const current = s.qualifyingTransactions ?? '';
  const raw = prompt(`${c.title}\nBu kampanya döneminde tamamladığın uygun işlem adedini gir.\n(Bilinmiyor yapmak için boş bırak)`, current);
  if (raw === null) return;
  let value = null;
  if (String(raw).trim() !== '') {
    value = Number(raw);
    if (!Number.isInteger(value) || value < 0) return alert('0 veya daha büyük tam sayı gir.');
  }
  data.states[id] = {
    ...s,
    qualifyingTransactions: value,
    valueSource: 'user_confirmed',
    confirmedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  save(); renderAll();
}

function toggleEnrollment(id) {
  const rawCampaign = data.campaigns.find(x => x.id === id);
  const c = effectiveCampaign(rawCampaign);
  const s = data.states[id] || ensureReset(c, null, new Date());
  data.states[id] = {
    ...s,
    enrollmentStatus: s.enrollmentStatus === 'joined' ? 'unknown' : 'joined',
    updatedAt: new Date().toISOString()
  };
  save(); renderAll();
}

function rejectionText(r) {
  if (!r.rejected?.length) return 'Bu işlem için uygun kampanya bulunamadı.';
  const relevant = r.rejected.find(x => x.inspection?.reasons?.some(reason => reason.includes('İşyeri') || reason.includes('kategori'))) || r.rejected[0];
  return relevant?.inspection?.reasons?.join(' ') || 'Bu işlem için uygun kampanya bulunamadı.';
}

function ruleDetailBits(campaign) {
  const min = ruleMinSpend(campaign);
  const txCap = campaign.rewardRule?.perTransactionCap ?? campaign.perTransactionCap;
  return [
    min > 0 ? `Alt limit ${money(min)}` : 'Alt limit yok',
    txCap != null ? `İşlem tavanı ${money(txCap)}` : null,
    campaign.periodCap != null ? `Dönem tavanı ${campaignRewardLabel(campaign, campaign.periodCap)}` : null,
    campaign.eligibility?.segmentLabels?.length ? `Segment ${segmentLabelsDisplay(campaign).join(', ')}` : null
  ].filter(Boolean).join(' · ');
}

// Kampanyanın segment anahtarları (ör. nötr bant kodu) → kullanıcıya güncel ölçüt etiketi.
function segmentLabelsDisplay(campaign) {
  const catalog = account.catalog || BUNDLED_PROFILE_CATALOG;
  const dims = (catalog.dimensions || []).filter(d => d.engineBinding === 'card_segment' && (d.cardCodes || []).some(c => (campaign.cardProductIds || []).includes(c)));
  return (campaign.eligibility?.segmentLabels || []).map(l => {
    const d = dims.find(x => x.options.some(o => o.code === l && (o.engineLabel || o.label) === l));
    return d ? optionDisplayLabel(catalog, d.code, l) : l;
  });
}

function potentialCardHtml(r, p) {
  const blockers = p.actionableBlockers.map(b => `<li>${esc(b.message)}</li>`).join('');
  const state = p.state || {};
  const enrollment = p.campaign.requiresEnrollment && state.enrollmentStatus !== 'joined'
    ? `<div class="danger-text"><strong>Katılım gerekiyor.</strong> Banka uygulamasından kampanyaya katılım durumunu doğrula.</div>` : '';
  const progress = p.campaign.transactionRules?.rewardStartsFromQualifyingTransaction > 1
    ? `<div class="muted">İlerleme: ${state.qualifyingTransactions == null ? 'önceki uygun işlem adedi bilinmiyor' : `${esc(state.qualifyingTransactions)} uygun işlem tamamlandı`}.</div>` : '';
  const thresholdReward = p.rewardAtThreshold > 0
    ? `<div class="potential-reward">Koşul sağlanırsa bu işlem için teorik ödül: <strong>${campaignRewardLabel(p.campaign, p.rewardAtThreshold)}</strong>${p.campaign.transactionRules?.rewardStartsFromQualifyingTransaction > 1 ? ' (işlem sırası koşuluna da bağlı)' : ''}</div>` : '';
  const warnings = p.inspection.warnings.length
    ? `<div class="condition-box"><strong>Diğer koşullar:</strong> ${p.inspection.warnings.map(esc).join(' ')}</div>` : '';

  return `
    <article class="result-card potential-card">
      <div class="rank">?</div>
      <div class="result-body">
        <div class="potential-label">POTANSİYEL KAMPANYA</div>
        <strong>${esc(r.card.bank)} — ${esc(r.card.name)}</strong>
        <div>${esc(p.campaign.title)}</div>
        <div class="rule-line">${esc(ruleDetailBits(p.campaign))}</div>
        <div class="potential-gap"><strong>Şu an koşul sağlanmıyor:</strong><ul>${blockers}</ul></div>
        ${thresholdReward}
        ${enrollment}
        ${progress}
        ${warnings}
      </div>
    </article>`;
}

function loyaltyHtml(card, ctx) {
  const earning = calculateLoyalty({ card, ...ctx, settings: data.settings });
  if (!earning) return '';
  let main = '';
  if (earning.known) {
    if (earning.unit === 'thy_miles') main = `<strong>${formatNumber(earning.amount, 0)} THY Mil</strong>`;
    else if (earning.unit === 'wings_mil_puan') main = `<strong>${formatNumber(earning.amount)} Mil Puan</strong>`;
    else if (earning.unit === 'maximil') main = `<strong>${formatNumber(earning.amount)} MaxiMil</strong>`;
    else if (earning.unit === 'bonus') main = `<strong>${formatNumber(earning.amount)} Bonus</strong>`;
    else if (earning.unit === 'worldpuan') main = `<strong>${formatNumber(earning.amount)} Worldpuan</strong>`;
    else main = `<strong>${formatNumber(earning.amount)}</strong>`;
  } else {
    main = `<span class="warn-text"><strong>Kesin oran hesaplanamadı</strong></span>`;
  }
  let conversions = '';
  if (earning.known && earning.unit === 'wings_mil_puan' && earning.values) {
    conversions = `<div class="loyalty-values">Yurt içi uçak: ${money(earning.values.domesticFlightTry)} · Yurt dışı uçak: ${money(earning.values.internationalFlightTry)} · Otel/tur/araç: ${money(earning.values.hotelTourCarTry)}</div>`;
  } else if (earning.known && earning.unit === 'maximil' && earning.values?.travelTry != null) {
    conversions = `<div class="loyalty-values">Seyahatte 1 MaxiMil = 1 TL → yaklaşık ${money(earning.values.travelTry)} kullanım değeri</div>`;
  }
  return `<div class="loyalty-box"><div class="loyalty-title">Normal kart kazanımı</div><div>${esc(earning.title)}: ${main}</div><div class="muted">${esc(earning.detail || '')}</div>${conversions}${earning.note ? `<div class="muted">${esc(earning.note)}</div>` : ''}</div>`;
}

function renderRecommendation() {
  const form = $('#recommendForm');
  form.addEventListener('submit', e => {
    e.preventDefault();
    const amount = Number($('#amount').value.replace(',', '.'));
    const merchant = $('#merchant').value;
    const selectedCategory = $('#category').value;
    const locationScope = $('#locationScope').value;
    const paymentChannel = $('#paymentChannel').value;
    if (!Number.isFinite(amount) || amount <= 0) return alert('Harcama tutarını gir.');

    const resolvedInput = resolveMerchantInput(data.campaigns, merchant, selectedCategory);
    const merchantContext = resolvedInput.context;
    const inputNotices = resolvedInput.notices;
    if (resolvedInput.needsCategorySelection || !resolvedInput.effectiveCategory) {
      const hint = merchantContext.categories.length ? ` Olası kategoriler: ${merchantContext.categories.join(', ')}.` : '';
      setLastQueryDebug({
        input: { merchant, selectedCategory, amount, locationScope, paymentChannel },
        resolution: resolvedInput,
        aborted: true, abortReason: `Kategori güvenle belirlenemedi.${hint}`
      });
      return alert(String(merchant || '').trim() ? `Kategori güvenle belirlenemedi. Lütfen kategoriyi seç.${hint}` : 'İşyeri girmeden sorgulamak için bir kategori seç.');
    }
    const category = resolvedInput.effectiveCategory;
    const loyaltyCtx = { amount, merchant, category, locationScope, paymentChannel };

    const results = recommend({
      cards: data.cards,
      campaigns: data.campaigns,
      states: data.states,
      merchant,
      category,
      amount,
      locationScope,
      paymentChannel,
      now: new Date(),
      staleAfterDays: data.settings.staleAfterDays,
      eligibilityContext: eligibilityContext()
    });

    setLastQueryDebug({
      input: { merchant, selectedCategory, effectiveCategory: category, amount, locationScope, paymentChannel },
      resolution: resolvedInput,
      catalogCampaignCount: data.campaigns.length,
      results: results.map(r => ({
        card: r.card,
        best: diagnosticEval(r.best),
        eligible: (r.all || []).map(diagnosticEval),
        potentials: (r.potentials || []).map(diagnosticEval),
        informational: (r.informational || []).map(diagnosticEval),
        merchantConditional: (r.merchantConditional || []).map(diagnosticEval),
        merchantSpecific: (r.merchantSpecific || []).map(diagnosticEval),
        rejected: (r.rejected || []).map(diagnosticEval)
      }))
    });

    let rank = 0;
    const activeHtml = results.map(r => {
      if (!r.best) return `
        <article class="result-card muted-result">
          <div class="rank">—</div>
          <div class="result-body">
            <strong>${esc(r.card.bank)} — ${esc(r.card.name)}</strong>
            <div class="muted">Bu tutarda doğrudan kullanılabilir kampanya yok. ${esc(rejectionText(r))}</div>
            ${loyaltyHtml(r.card, loyaltyCtx)}
          </div>
        </article>`;

      rank += 1;
      const b = r.best;
      let rewardLine = '';
      let cls = '';
      if (b.enrollmentMissing) {
        rewardLine = `Katılım gerekiyor · teorik ${campaignRewardLabel(b.campaign, b.theoreticalReward)}`;
        cls = 'danger-text';
      } else if (b.progress?.known && b.progress.rewardEligibleNow === false) {
        rewardLine = `Bu işlem kampanya ilerlemesine sayılır; henüz ödül doğurmaz.`;
        cls = 'warn-text';
      } else if (!b.remainingKnown || b.actualReward === null) {
        const capNote = b.periodCapApplied ? ' (dönem tavanıyla sınırlı)' : '';
        rewardLine = !b.remainingKnown
          ? `Teorik en fazla ${campaignRewardLabel(b.campaign, b.theoreticalReward)}${capNote} · kalan dönem hakkı bilinmiyor`
          : `Teorik ${campaignRewardLabel(b.campaign, b.theoreticalReward)}${capNote} · sonuç işlem sırası doğrulamasına bağlı`;
        cls = 'warn-text';
      } else {
        rewardLine = `${b.conditional ? 'Koşullu avantaj' : 'Hesaplanan avantaj'} ${campaignRewardLabel(b.campaign, b.actualReward)}`;
        if (b.conditional) cls = 'warn-text';
      }
      const fresh = b.freshness.status === 'stale' ? ` · ⚠ ${b.freshness.label}` : ` · ${b.freshness.label}`;
      const warnings = b.inspection.warnings.length ? `<div class="condition-box"><strong>Kontrol et:</strong> ${b.inspection.warnings.map(esc).join(' ')}</div>` : '';
      // Koşullu kademeler (seçilmemiş segmente bağlı): yalnız bilgi — tutara ve sıralamaya KATILMAZ.
      const condRates = (b.conditionalRewards || []).map(x => x.rewardRule?.rate).filter(r => Number.isFinite(r));
      const conditionalHtml = condRates.length ? `<div class="muted conditional-rewards">Segmentini seçersen daha yüksek olabilir: ${condRates.map(r => `%${formatNumber(r * 100)}`).join(', ')} (Profil › Müşteri Profili)</div>` : '';

      return `
        <article class="result-card ${rank === 1 ? 'top' : ''}">
          <div class="rank">${rank}</div>
          <div class="result-body">
            <strong>${esc(r.card.bank)} — ${esc(r.card.name)}</strong>
            <div>${esc(b.campaign.title)}</div>
            <div class="rule-line">${esc(ruleDetailBits(b.campaign))}</div>
            <div class="result-reward ${cls}">${rewardLine}</div>
            ${conditionalHtml}
            <div class="muted">Kalan: ${b.state.remainingLimit == null ? 'Bilinmiyor' : campaignRewardLabel(b.campaign, b.state.remainingLimit)}${fresh}</div>
            ${loyaltyHtml(r.card, loyaltyCtx)}
            ${warnings}
          </div>
        </article>`;
    }).join('');

    const potentials = results.flatMap(r => (r.potentials || []).map(p => ({ r, p })));
    const potentialHtml = potentials.length
      ? `<div class="potential-section"><h3>Potansiyel kampanyalar</h3><p class="muted">Aynı işlem bağlamında yalnız tutar eşiği eksik; tutarı ayarlarsan geçerli olur.</p>${potentials.map(({r,p}) => potentialCardHtml(r,p)).join('')}</div>`
      : '';

    // v1.5.0: işyeri girilmeden yapılan kategori sorgusu — üye işyeri ağına bağlı KOŞULLU sonuçlar (garanti değil)
    // ve belirli markalara özel fırsatlar ayrı bölümlerde; hiçbiri kesin kazanan olarak sıralanmaz.
    const condMerchants = results.flatMap(r => (r.merchantConditional || []).map(e => ({ r, e })));
    const condMerchantHtml = condMerchants.length ? `<div class="info-section merchant-conditional-section"><h3>Üye işyerine bağlı koşullu sonuçlar</h3><p class="muted">${esc(NETWORK_MERCHANT_WARNING)}</p>${condMerchants.map(({r,e}) => `<article class="result-card info-card merchant-conditional-card"><div class="rank">~</div><div class="result-body"><div class="info-label">KOŞULLU · GARANTİ DEĞİL</div><strong>${esc(r.card.bank)} — ${esc(r.card.name)}</strong><div>${esc(e.campaign.title)}</div><div class="rule-line">${esc(ruleDetailBits(e.campaign))}</div><div class="result-reward warn-text">İşyeri dahilse teorik en fazla ${campaignRewardLabel(e.campaign, e.theoreticalReward)}</div>${e.campaign.sourceUrl ? `<a class="source-link" href="${esc(e.campaign.sourceUrl)}" target="_blank" rel="noopener">Üye işyeri listesini aç ↗</a>` : ''}</div></article>`).join('')}</div>` : '';
    const brandSpecific = results.flatMap(r => (r.merchantSpecific || []).map(e => ({ r, e })));
    const brandHtml = brandSpecific.length ? `<div class="info-section merchant-specific-section"><h3>Bu kategoride işyeri özel fırsatlar</h3><p class="muted">Belirli işyerlerinde geçerli; işyeri adını girersen kesin hesaplanır.</p>${brandSpecific.map(({r,e}) => `<article class="result-card info-card merchant-specific-card"><div class="rank">i</div><div class="result-body"><div class="info-label">İŞYERİ ÖZEL</div><strong>${esc(r.card.bank)} — ${esc(r.card.name)}</strong><div>${esc(e.campaign.title)}</div><div class="rule-line">${esc(merchantScopeInfo(e.campaign).text)}</div>${e.rewardIfMerchantMatches > 0 ? `<div class="muted">Bu işyerinde teorik: ${campaignRewardLabel(e.campaign, e.rewardIfMerchantMatches)}</div>` : ''}</div></article>`).join('')}</div>` : '';

    const infos = results.flatMap(r => (r.informational || []).map(i => ({r,i})));
    const infoHtml = infos.length ? `<div class="info-section"><h3>İlgili diğer kampanyalar</h3><p class="muted">Bu kampanyalar resmi kaynakta bulundu ancak otomatik hesap için tüm koşullar güvenle çözümlenemedi. Kaybolmazlar; resmi detayı açıp kontrol edebilirsin.</p>${infos.map(({r,i}) => `<article class="result-card info-card"><div class="rank">i</div><div class="result-body"><div class="info-label">BİLGİ AMAÇLI</div><strong>${esc(r.card.bank)} — ${esc(r.card.name)}</strong><div>${esc(i.campaign.title)}</div><div class="rule-line">${esc(rewardRuleSummary(i.campaign))}</div>${i.infoNote ? `<div class="detail-warning">${esc(i.infoNote)}</div>` : ''}${i.campaign.termsSummary ? `<div class="muted">${esc(i.campaign.termsSummary)}</div>` : ''}${i.campaign.sourceUrl ? `<a class="source-link" href="${esc(i.campaign.sourceUrl)}" target="_blank" rel="noopener">Resmi koşulları aç ↗</a>` : ''}</div></article>`).join('')}</div>` : '';

    const inputNoticeHtml = inputNotices.length
      ? `<div class="input-notice"><strong>Girdi kontrolü:</strong> ${inputNotices.map(esc).join(' ')}</div>`
      : '';
    const coverageNote = account.mode === 'profile' && account.profile ? recommendationCoverageNote(account.profile.banks, coverageCatalog(), { registry: sourceRegistry() }) : null;
    const coverageHtml = coverageNote ? `<div class="coverage-note muted small">${esc(coverageNote)} <a href="#/profil/info">Ayrıntı</a></div>` : '';
    $('#recommendResults').innerHTML = inputNoticeHtml + coverageHtml + activeHtml + condMerchantHtml + brandHtml + potentialHtml + infoHtml;
  });
}

// v1.3: hash tabanlı gezinme. Ana sekmeler: Hangi Kart? (varsayılan) · Kampanyalar · Profil.
// Alt sayfalar (Kampanya ekle, Profil bölümleri) kendi sekmesini aktif tutar; Android geri tuşu çalışır.
function showRoute() {
  const route = guardRoute(resolveRoute(location.hash), account);
  if (route.redirected && location.hash !== route.hash) { history.replaceState(null, '', route.hash); }
  document.body.classList.toggle('gate-mode', Boolean(route.gate));
  $$('.view').forEach(v => v.classList.toggle('active', v.id === route.view));
  $$('.nav-btn').forEach(a => {
    const on = a.dataset.tab === route.tab;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  const title = $('#pageTitle'); if (title) title.textContent = route.title;
  document.title = `${route.title} · Kampanya Avcısı`;
  if (route.view === 'profileInfo') renderInfo();
  if (route.view === 'onboardingView') renderOnboarding();
  if (route.view === 'accountStatusView') renderAccountStatus();
  if (route.view === 'profileCards') openCardsEditor();
  if (route.view === 'profileSegments') openAttributesEditor();
  if (route.view === 'profileAccount') renderAccountSummary();
  window.scrollTo(0, 0);
}

function wireNav() {
  window.addEventListener('hashchange', () => {
    // v1.4.4: açık uygulamaya hash ile gelen Supabase dönüşü (aynı belge içinde gezinme) → yakala, temizle, yeniden yükle.
    if (/(^|[#&?/])(access_token|error_code|error)=/.test(location.hash)) {
      const cb = captureAuthCallback(location);
      if (cb) {
        try { sessionStorage.setItem(AUTH_CALLBACK_KEY, JSON.stringify(cb)); } catch {}
        const target = cb.kind === 'session' ? (cb.type === 'recovery' ? '#/profil/hesap' : DEFAULT_ROUTE) : '#/giris';
        history.replaceState(null, '', `${location.pathname}${target}`);
        location.reload();
        return;
      }
    }
    showRoute();
  });
  if (!location.hash) history.replaceState(null, '', DEFAULT_ROUTE);
  showRoute();
}

// v1.5.0: kaynak kaydı (catalog.meta.sourceRegistry) — kapsam türetmesi bunu kullanır; yoksa beyan üst sınır olarak okunur.
function sourceRegistry() { return data?.meta?.catalogMeta?.sourceRegistry || null; }
function coverageCatalog() { return account.catalog || BUNDLED_PROFILE_CATALOG; }

const FACET_TR = { full: 'Tam', partial: 'Kısmi', none: 'Yok', coming: 'Yakında' };
const FRESH_TR = { verified: 'Güncel', last_known: 'Son başarılı kayıt', stale: 'Eski', unverified: 'Doğrulanmadı' };
const CONF_TR = { high: 'yüksek güven', medium: 'orta güven', low: 'düşük güven', unknown: 'kanıt yok' };
const LEVEL_TR = { full: 'Tam destek', partial: 'Kısmi destek', profile_only: 'Yalnız profil', coming: 'Kampanyalar yakında', unsupported: 'Henüz desteklenmiyor' };

function renderCoverageInfo() {
  const el = $('#coverageInfo'); if (!el) return;
  const catalog = coverageCatalog();
  const rows = allBankCoverage(catalog, { registry: sourceRegistry() });
  el.innerHTML = `<table class="coverage-table"><thead><tr><th>Banka</th><th>Durum</th><th>Kartlar</th><th>Ayrıcalıklar</th><th>Kampanyalar</th><th>Kaynak</th></tr></thead><tbody>${rows.map(c => {
    const name = catalog.banks.find(b => b.code === c.bankCode)?.name || c.bankCode;
    const last = c.lastSuccessfulCrawl ? formatRefreshTime(c.lastSuccessfulCrawl) : '—';
    return `<tr data-bank="${esc(c.bankCode)}" data-level="${esc(c.level)}"><td>${esc(name)}</td><td>${esc(LEVEL_TR[c.level])}</td><td>${esc(FACET_TR[c.facets.cardProducts])}</td><td>${esc(FACET_TR[c.facets.coreBenefits])}</td><td>${esc(FACET_TR[c.facets.campaigns])}</td><td>${esc(c.facets.campaignCrawler === 'full' ? `${FRESH_TR[c.freshness]} · ${last} · kapsam ${CONF_TR[c.sourceConfidence] || CONF_TR.unknown}` : 'Tarayıcı yok')}</td></tr>`;
  }).join('')}</tbody></table>`;
}

function renderInfo() {
  renderCoverageInfo();
  const rowsEl = $('#infoRows');
  if (rowsEl) {
    const rows = buildInfoRows({
      version: runtimeAppVersion,
      build: BUILD_INFO,
      meta: data?.meta || {},
      campaignCount: (data?.campaigns || []).filter(c => !c.coreBenefit && c.sourceKind !== 'user_private').length,
      coreCount: (data?.campaigns || []).filter(c => c.coreBenefit).length,
    });
    rowsEl.innerHTML = rows.map(([k, v]) => `<div class="info-row"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
  }
  const v = $('#runtimeVersion'); if (v) v.textContent = runtimeAppVersion;
  const notes = $('#releaseNotes');
  if (notes && !notes.dataset.rendered) {
    notes.innerHTML = RELEASE_NOTES.map(r => `<div class="release"><div class="release-head"><strong>${esc(r.version)}</strong><span class="muted">${esc(r.date)}</span></div><ul>${r.items.map(i => `<li>${esc(i)}</li>`).join('')}</ul></div>`).join('');
    notes.dataset.rendered = '1';
  }
}

function wireDataTools() {
  const queryLogBtn = $('#downloadQueryLogBtn');
  if (queryLogBtn) queryLogBtn.addEventListener('click', downloadLastQueryDebug);
  $('#exportBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `kampanya-avcisi-yedek-${new Date().toISOString().slice(0,10)}.json`;
    a.click(); URL.revokeObjectURL(a.href);
  });
  $('#importFile').addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (!parsed.cards || !parsed.campaigns || !parsed.states) throw new Error('Şema eksik');
      data = parsed; data.settings = { ...seed().settings, ...(data.settings || {}) }; ensureCoreBenefitsInData(); syncCardSegmentsFromSettings(); save(); renderAll(); alert('Yedek içe aktarıldı.');
    } catch (err) { alert(`Dosya okunamadı: ${err.message}`); }
  });
  $('#resetBtn').addEventListener('click', () => {
    if (!confirm('yerel ayarları başlangıç değerlerine döndürmek istiyor musun?')) return;
    data = seed(); save(); syncResets(); renderAll();
  });
  $('#staleDays').value = data.settings.staleAfterDays;
  $('#staleDays').addEventListener('change', () => {
    const n = Number($('#staleDays').value);
    if (Number.isFinite(n) && n >= 0) {
      data.settings.staleAfterDays = n;
      if (account.mode === 'profile' && account.profile) savePreferences({ staleAfterDays: n });
      save(); renderAll();
    }
  });
  function bindProfileSelect(id, items, settingKey, fallback, bankToInvalidate = null) {
    const el = $(id); if (!el) return;
    el.innerHTML = items.map(x => `<option value="${x.value}">${esc(x.label)}</option>`).join('');
    el.value = data.settings[settingKey] || fallback;
    el.addEventListener('change', () => {
      if (data.settings[settingKey] === el.value) return;
      data.settings[settingKey] = el.value;
      syncCardSegmentsFromSettings();
      if (bankToInvalidate) invalidateSegmentDependentStates(bankToInvalidate);
      save(); renderAll();
    });
  }
  bindProfileSelect('#thyStatus', THY_STATUSES, 'thyStatus', 'classic');
  bindProfileSelect('#qnbSegment', QNB_SEGMENTS, 'qnbSegment', 'private', 'QNB');
  bindProfileSelect('#wingsTier', WINGS_TIERS, 'wingsTier', 'black_plus', 'Akbank');
  bindProfileSelect('#maximilesBand', MAXIMILES_BANDS, 'maximilesBand', 'band_3', 'İş Bankası');
  bindProfileSelect('#crystalBand', CRYSTAL_BANDS, 'crystalBand', 'band_1', 'Yapı Kredi');
  bindProfileSelect('#crystalCardType', CRYSTAL_CARD_TYPES, 'crystalCardType', 'crystal', 'Yapı Kredi');
  bindProfileSelect('#tebTier', TEB_TIERS, 'tebTier', 'ultra', 'TEB');
}

function formatRefreshTime(value) {
  if (!value) return 'yok';
  try { return new Date(value).toLocaleString('tr-TR'); } catch { return value; }
}

function showRefreshStatus(payload) {
  const el = $('#refreshStatus');
  if (!el) return;
  if (!payload || payload.state === 'never_run') { el.textContent = 'Henüz tarama yapılmadı.'; return; }
  const state = payload.state === 'ok' ? 'Başarılı' : payload.state === 'running' ? 'Çalışıyor' : payload.state === 'partial_error' ? 'Kısmi hata' : 'Hata';
  const progress = payload.state === 'running' && payload.source_total
    ? ` · ${payload.current_bank || payload.current_source || ''} ${payload.source_done || 0}/${payload.source_total}`
    : payload.state === 'running' && payload.current_bank ? ` · ${payload.current_bank} kaynak aranıyor` : '';
  el.textContent = `${state}${progress} · katalog ${payload.campaign_count ?? 0} · son: ${formatRefreshTime(payload.last_finished_at || payload.last_started_at)} · değişen ${payload.changed_count ?? 0} · hata ${payload.error_count ?? 0}`;
}

async function loadRefreshStatus() {
  if (!LOCAL_API) {
    const el = $('#refreshStatus');
    if (el) el.textContent = cloudConfigured() ? 'PWA bulut modu: katalog 08:00/18:00 sunucu taramasıyla güncellenir.' : 'PWA dağıtımında katalog statik/bulut kaynaktan okunur.';
    setRefreshButtonRunning(false);
    return;
  }
  try {
    const res = await fetch(`${REFRESH_API}/api/status`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const st = await res.json();
    showRefreshStatus(st);
    setRefreshButtonRunning(st.state === 'running');
  } catch {
    const el = $('#refreshStatus');
    if (el) el.textContent = cloudConfigured() ? 'PWA bulut modu: katalog 08:00/18:00 sunucu taramasıyla güncellenir.' : 'Yerel refresh servisi kapalı. PWA dağıtımında katalog statik/bulut kaynaktan okunur.';
    setRefreshButtonRunning(false);
  }
}

function setRefreshButtonRunning(running) {
  const btn = $('#refreshCampaignsBtn');
  if (!btn) return;
  btn.disabled = !!running;
  btn.textContent = running ? 'Tarama sürüyor…' : 'Şimdi yenile';
}

function wireRefreshTools() {
  const btn = $('#refreshCampaignsBtn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    setRefreshButtonRunning(true);
    try {
      if (!LOCAL_API) throw new Error('local_api_disabled');
      const res = await fetch(`${REFRESH_API}/api/refresh`, { method: 'POST' });
      const payload = await res.json().catch(() => ({}));
      if (res.status === 409 && payload.error === 'refresh_already_running') {
        showRefreshStatus(payload);
        const el = $('#refreshStatus');
        if (el) el.textContent = `Tarama zaten çalışıyor · katalog ${payload.campaign_count ?? 0} · ikinci tarama başlatılmadı.`;
        return;
      }
      if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
      showRefreshStatus(payload.status || {state:'running'});
      const el = $('#refreshStatus');
      if (el) el.textContent = 'Tarama başlatıldı. İlerleme otomatik izleniyor…';
    } catch (err) {
      try {
        const cloud = await triggerCloudRefresh();
        if (cloud.configured) {
          const el=$('#refreshStatus'); if(el) el.textContent='Bulut taraması tetiklendi. Katalog tamamlandığında yeniden yükle.';
        } else {
          await loadLiveCatalog(true);
          const el=$('#refreshStatus'); if(el) el.textContent='PWA kataloğu yeniden yüklendi. Kaynak taraması sunucuda 08:00/18:00 yapılır; anlık tarama endpoint’i henüz bağlı değil.';
        }
      } catch (cloudErr) {
        const el=$('#refreshStatus'); if(el) el.textContent=`Yenileme başlatılamadı: ${cloudErr.message}`;
      } finally { setRefreshButtonRunning(false); }
    }
  });
  loadRefreshStatus();
}

// Ortak uygunluk bağlamı: profil modunda öznitelikler DOĞRUDAN profilden (boyut kodu → seçenek kodu);
// eski modda eski ayarlardan türetilir. card.segment uygunluğun kanonik kaynağı değildir.
function eligibilityContext() {
  if (account.mode === 'profile' && account.profile) {
    // GERÇEK bağlam: yalnız bugün geçerli (onayı güncel) seçimler; yeniden onay bekleyen seçim "bilinmiyor" sayılır.
    return buildEligibilityContext({ cards: data.cards || [], banks: account.profile.banks, attributes: effectiveAttributes(account.profile, account.catalog), catalog: account.catalog });
  }
  return buildEligibilityContext({ cards: data.cards || [], attributes: attributesFromLegacySettings(data.settings || {}, BUNDLED_PROFILE_CATALOG), catalog: BUNDLED_PROFILE_CATALOG });
}

function renderPrivateCardOptions() {
  const sel = $('#privateCard');
  if (!sel || account.mode !== 'profile') return;
  const cards = data.cards || [];
  const html = cards.map(c => `<option value="${esc(c.cardProductId)}|${esc(c.bank)}">${esc(c.bank)} ${esc(c.name)}</option>`).join('');
  if (sel.dataset.rendered !== html) { sel.innerHTML = html || '<option value="">Önce Profil › Bankalarım ve Kartlarım’dan kart ekle</option>'; sel.dataset.rendered = html; }
}

function renderAll() {
  syncCardSegmentsFromSettings();
  renderPrivateCardOptions();
  syncResets();
  renderDashboard();
  renderCampaigns();
  renderInfo();
  $('#staleDays').value = data.settings.staleAfterDays;
  if ($('#thyStatus')) $('#thyStatus').value = data.settings.thyStatus || 'classic';
  if ($('#qnbSegment')) $('#qnbSegment').value = data.settings.qnbSegment || 'private';
  if ($('#wingsTier')) $('#wingsTier').value = data.settings.wingsTier || 'black_plus';
  if ($('#maximilesBand')) $('#maximilesBand').value = data.settings.maximilesBand || 'band_3';
  if ($('#crystalBand')) $('#crystalBand').value = data.settings.crystalBand || 'band_1';
  if ($('#crystalCardType')) $('#crystalCardType').value = data.settings.crystalCardType || 'crystal';
  if ($('#tebTier')) $('#tebTier').value = data.settings.tebTier || 'ultra';
}


function reconcileCampaignStates(nextCampaigns, previousCampaigns = []) {
  // Geçici olarak kaybolan / id'si değişen kampanyanın kullanıcı durumu silinmez (catalog-state.js).
  data.states = reconcileStatesRules({ campaigns: nextCampaigns, states: data.states || {}, previousCampaigns, resolve: effectiveCampaign, now: new Date() });
}

async function loadRuntimeVersion() {
  const v0 = $('#runtimeVersion');
  if (v0) v0.textContent = runtimeAppVersion;
  if (!LOCAL_API) return;
  try {
    const res = await fetch(`${REFRESH_API}/api/version`, { cache: 'no-store' });
    if (!res.ok) return;
    const payload = await res.json();
    if (payload?.version) {
      runtimeAppVersion = payload.version;
      const v = $('#runtimeVersion');
      if (v) v.textContent = runtimeAppVersion;
    }
  } catch {}
}

async function fetchCatalogPayload(force=false) {
  const mode = cloudConfigSummary().catalogMode || 'auto';
  const errors = [];
  if (LOCAL_API && (mode === 'local' || mode === 'auto')) {
    try {
      const res = await fetch(`${REFRESH_API}/api/catalog`, { cache: force ? 'reload' : 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return {payload:await res.json(), source:'local-api'};
    } catch (e) { errors.push(`local: ${e.message}`); }
  }
  if ((mode === 'supabase' || mode === 'auto') && cloudConfigured()) {
    try {
      const payload = await fetchCloudCatalog();
      if (payload?.campaigns?.length) return {payload, source:'supabase'};
      throw new Error('boş snapshot');
    } catch (e) { errors.push(`supabase: ${e.message}`); }
  }
  if (mode === 'static' || mode === 'auto') {
    try {
      const res = await fetch('./data/catalog.json', { cache: force ? 'reload' : 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return {payload:await res.json(), source:'static'};
    } catch (e) { errors.push(`static: ${e.message}`); }
  }
  throw new Error(errors.join(' | ') || 'Katalog kaynağı bulunamadı');
}

async function loadLiveCatalog(force=false) {
  try {
    const {payload, source} = await fetchCatalogPayload(force);
    data.meta = {...(data.meta||{}), catalogSource:source};
    if (payload?.meta?.partial === true) {
      // Tarama staging aşamasındayken mevcut tam kataloğu asla eksik katalogla değiştirme.
      data.meta.refreshPreview = payload.meta;
      save(); renderDashboard();
      return;
    }
    if (Array.isArray(payload.campaigns) && payload.campaigns.length) {
      const previousCampaigns = data.campaigns || [];
      data.campaigns = mergeCatalogWithCore(payload.campaigns, previousCampaigns);
      reconcileCampaignStates(data.campaigns, previousCampaigns);
      data.meta.catalogGeneratedAt = payload.generatedAt || null;
      data.meta.catalogMeta = payload.meta || {};
      save(); renderAll();
    }
  } catch (err) {
    console.warn('Canlı/bulut katalog yüklenemedi, cihazdaki son katalog kullanılıyor:', err);
  }
}

let pendingPrivateCampaign = null;

function duplicateCandidateHtml(c) {
  const dates = [c.startDate, c.endDate].filter(Boolean).join(' → ');
  const src = c.sourceKind === 'user_private' ? 'Daha önce elle eklenmiş' : 'Sistemdeki resmi kampanya';
  return `<article class="duplicate-card">
    <div class="duplicate-badge">OLASI AYNI KAMPANYA · benzerlik %${Math.round((c.score || 0) * 100)}</div>
    <strong>${esc(c.bank || '')} — ${esc(c.title || 'Kampanya')}</strong>
    ${dates ? `<div class="muted">${esc(dates)}</div>` : ''}
    ${c.termsSummary ? `<div class="duplicate-summary">${esc(c.termsSummary)}</div>` : ''}
    <div class="muted">${esc(src)}</div>
    ${c.sourceUrl ? `<a class="source-link" target="_blank" rel="noopener" href="${esc(c.sourceUrl)}">Sistemdeki resmi kampanyayı aç ↗</a>` : ''}
  </article>`;
}

function renderPrivateDuplicateReview(payload, requestObj) {
  const box = $('#privateDuplicateReview');
  const matches = payload.candidateCampaigns || [];
  pendingPrivateCampaign = requestObj;
  box.innerHTML = `<div class="duplicate-review">
    <h3>Bu kampanya sistemde olabilir</h3>
    <p>Eklemek istediğin kampanya aşağıdaki kayıtla eşleşiyor olabilir. Önce mevcut kaydı kontrol et.</p>
    ${matches.map(duplicateCandidateHtml).join('')}
    <div class="button-row">
      <button type="button" id="duplicateSameBtn" class="primary">Evet, bu kampanyaydı — ekleme</button>
      <button type="button" id="duplicateDifferentBtn" class="secondary">Hayır, farklı kampanya — yine de ekle</button>
    </div>
  </div>`;
  $('#duplicateSameBtn').addEventListener('click', () => {
    pendingPrivateCampaign = null;
    box.innerHTML = '';
    $('#privateCampaignStatus').textContent = 'Mevcut kampanya kullanıldı; yeni kayıt eklenmedi.';
  });
  $('#duplicateDifferentBtn').addEventListener('click', async () => {
    const req = pendingPrivateCampaign;
    if (!req) return;
    $('#duplicateDifferentBtn').disabled = true;
    $('#privateCampaignStatus').textContent = 'Farklı kampanya olarak ekleniyor…';
    try {
      const res = await fetch(`${REFRESH_API}/api/custom-campaign`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({...req, forceAdd:true})
      });
      const out = await res.json().catch(()=>({}));
      if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
      box.innerHTML = ''; pendingPrivateCampaign = null;
      $('#privateCampaignStatus').textContent = 'Farklı kampanya olarak eklendi.';
      $('#privateText').value = ''; $('#privateTitle').value = '';
      await loadLiveCatalog(true);
    } catch (err) {
      $('#privateCampaignStatus').textContent = `Eklenemedi: ${err.message}`;
      $('#duplicateDifferentBtn').disabled = false;
    }
  });
}

function wirePrivateCampaign() {
  const form = $('#privateCampaignForm');
  if (!form) return;
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const status = $('#privateCampaignStatus');
    const review = $('#privateDuplicateReview');
    if (review) review.innerHTML = '';
    const [cardProductId, bank] = $('#privateCard').value.split('|');
    const text = $('#privateText').value.trim();
    const title = $('#privateTitle').value.trim();
    if (!text) return alert('Kampanya detay metnini yapıştır.');
    if (!LOCAL_API) {
      status.textContent = 'Özel kampanya analizi şu an yalnız yerel sunucu modunda çalışıyor (bulut uç noktası henüz yok). Mevcut özel kampanyaların korunur.';
      return;
    }
    const requestObj = { bank, cardProductIds:[cardProductId], title, text };
    status.textContent = 'Analiz ediliyor ve mevcut kampanyalarla karşılaştırılıyor…';
    try {
      const res = await fetch(`${REFRESH_API}/api/custom-campaign`, {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify(requestObj)
      });
      const payload = await res.json().catch(()=>({}));
      if (res.status === 409 && payload.error === 'possible_duplicate') {
        status.textContent = 'Olası çift kayıt bulundu; aşağıdaki mevcut kampanyayı kontrol et.';
        renderPrivateDuplicateReview(payload, requestObj);
        return;
      }
      if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
      status.textContent = payload.campaign?.rulesComplete ? 'Kampanya eklendi ve koşullar çözümlendi.' : 'Kampanya eklendi; bazı koşullar manuel doğrulama gerektiriyor.';
      $('#privateText').value = ''; $('#privateTitle').value = '';
      await loadLiveCatalog(true);
    } catch (err) { status.textContent = `Eklenemedi: ${err.message}`; }
  });
}


function personalCloudPayload() {
  return {
    settings: clone(data.settings || {}),
    campaignStates: clone(data.states || {}),
    privateCampaigns: clone((data.campaigns || []).filter(c => c.sourceKind === 'user_private'))
  };
}

function applyCloudPayload(row) {
  if (!row) return false;
  // Bulut satırındaki boş/eksik özel kampanya listesi cihazdaki özel kampanyaları silmez; birleşim yapılır.
  data = applyCloudRow(data, row, seed().settings);
  data.settings = normalizeLegacySettings(data.settings);
  ensureCoreBenefitsInData(); syncCardSegmentsFromSettings(); save(); renderAll();
  return true;
}

async function refreshCloudUi(message='') {
  const c = cloudConfigSummary();
  const status = $('#cloudConfigStatus');
  const syncStatus = $('#cloudSyncStatus');
  const email = $('#cloudEmail'); const pass = $('#cloudPassword');
  const signInBtn=$('#cloudSignInBtn'), signUpBtn=$('#cloudSignUpBtn'), signOutBtn=$('#cloudSignOutBtn');
  const up=$('#cloudUploadBtn'), down=$('#cloudDownloadBtn');
  if (!status) return;
  if (!c.configured) {
    status.innerHTML = '<strong>Bulut bağlantısı henüz yapılandırılmadı.</strong> PWA yerel cihaz verisiyle çalışır. Supabase Project URL + anon/publishable key bağlandığında senkron açılır.';
    [email,pass,signInBtn,signUpBtn,up,down].forEach(x=>{if(x)x.disabled=true;});
    if(signOutBtn) signOutBtn.hidden=true;
    if(syncStatus && message) syncStatus.textContent=message;
    return;
  }
  try {
    const probe=await testCloudConnection();
    const info=await sessionInfo();
    const cat = probe.snapshotPresent ? ' · Bulut kataloğu hazır' : ' · Katalog snapshot henüz boş';
    status.innerHTML = info.signedIn ? `<strong>Supabase bağlantısı doğrulandı.</strong> Oturum: ${esc(info.email || info.userId || 'kullanıcı')}${cat}` : `<strong>Supabase bağlantısı doğrulandı.</strong> Cihaz senkronu için giriş yap.${cat}`;
    if(email) email.disabled=info.signedIn; if(pass) pass.disabled=info.signedIn;
    if(signInBtn){signInBtn.hidden=info.signedIn;signInBtn.disabled=false;} if(signUpBtn){signUpBtn.hidden=info.signedIn;signUpBtn.disabled=false;}
    if(signOutBtn) signOutBtn.hidden=!info.signedIn;
    if(up) up.disabled=!info.signedIn; if(down) down.disabled=!info.signedIn;
    if(syncStatus && message) syncStatus.textContent=message;
  } catch(e) {
    status.textContent=`Bulut bağlantısı hatası: ${e.message}`;
  }
}

function wireCloudTools() {
  const signInBtn=$('#cloudSignInBtn'), signUpBtn=$('#cloudSignUpBtn'), signOutBtn=$('#cloudSignOutBtn');
  const upload=$('#cloudUploadBtn'), download=$('#cloudDownloadBtn');
  const creds=()=>({email:$('#cloudEmail')?.value.trim(),password:$('#cloudPassword')?.value||''});
  signInBtn?.addEventListener('click',async()=>{try{const c=creds(); if(!c.email||!c.password) throw new Error('E-posta ve şifre gerekli.'); await signIn(c.email,c.password); await refreshCloudUi('Giriş yapıldı.');}catch(e){await refreshCloudUi(`Giriş başarısız: ${e.message}`);}});
  signUpBtn?.addEventListener('click',async()=>{try{const c=creds(); if(!c.email||c.password.length<8) throw new Error('Geçerli e-posta ve en az 8 karakter şifre gerekli.'); const out=await signUp(c.email,c.password); await refreshCloudUi(out.access_token?'Hesap oluşturuldu ve giriş yapıldı.':'Hesap oluşturuldu. Supabase e-posta doğrulaması açıksa gelen kutundan doğrula.');}catch(e){await refreshCloudUi(`Kayıt başarısız: ${e.message}`);}});
  signOutBtn?.addEventListener('click',async()=>{ if (account.mode === 'profile') { await doSignOut(); return; } await signOut(); await refreshCloudUi('Bulut oturumu kapatıldı.');});
  upload?.addEventListener('click',async()=>{try{upload.disabled=true; const out=await saveCloudUserState(personalCloudPayload()); await refreshCloudUi(`Bu cihazın kişisel ayarları buluta gönderildi · ${formatRefreshTime(out.updated_at)}`);}catch(e){await refreshCloudUi(`Buluta gönderilemedi: ${e.message}`);}});
  download?.addEventListener('click',async()=>{try{download.disabled=true; const row=await fetchCloudUserState(); if(!row){await refreshCloudUi('Bulutta kayıtlı kişisel veri bulunamadı.');return;} if(!confirm('Buluttaki profil/limit/katılım verisini bu cihaza uygulamak istiyor musun?')){await refreshCloudUi('Buluttan alma iptal edildi.');return;} applyCloudPayload(row); await refreshCloudUi(`Bulut verisi bu cihaza alındı · ${formatRefreshTime(row.updated_at)}`);}catch(e){await refreshCloudUi(`Buluttan alınamadı: ${e.message}`);}});
  refreshCloudUi();
}

// =====================================================================================
// v1.4 — Hesap, kişisel profil ve onboarding
// Akış: oturum yok → Giriş · oturum var + profil tamam değil → Profilini oluştur · profil tamam → Hangi Kart?
// Profil Supabase'de kullanıcıya bağlıdır (RLS: auth.uid() = user_id). Cihazda yalnız hızlı açılış önbelleği tutulur.
// =====================================================================================
function profileStore() {
  const c = cloudConfigSummary();
  const cfg = window.BKA_CONFIG || {};
  return createProfileStore({ baseUrl: c.url, apiKey: cfg.supabaseAnonKey, getAccessToken });
}

function setAccountState(state, extra = {}) {
  account = { ...account, ...extra, state };
  applyModeUi();
  showRoute();
}

function applyModeUi() {
  const profileMode = account.mode === 'profile';
  const signedIn = profileMode && Boolean(account.userId);
  const show = (sel, on) => { const el = $(sel); if (el) el.hidden = !on; };
  show('#profileCardsEditor', profileMode && signedIn);
  show('#profileCardsSaveBar', profileMode && signedIn);
  show('#legacyCardsInfo', !profileMode);
  show('#profileAttributesEditor', profileMode && signedIn);
  show('#profileAttributesSaveBar', profileMode && signedIn);
  show('#legacySegmentSelectors', !profileMode);
  show('#accountSummaryCard', signedIn);
  show('#legacyCloudAuth', !profileMode);
}

// Kullanıcıya özel yerel veri. Bu cihazdaki eski (hesapsız) veriyi yalnız İLK giriş yapan hesap devralır;
// devralınan yalnız kalan limit/katılım/özel kampanya durumudur — kart portföyü ve segmentler profilden gelir.
function activateUserData(uid) {
  storageKey = userStorageKey(uid);
  let hasUserData = false;
  try { hasUserData = localStorage.getItem(storageKey) !== null; } catch {}
  if (!hasUserData) {
    let legacyRaw = null, claimedBy = null;
    try { legacyRaw = localStorage.getItem(STORAGE_KEY); claimedBy = localStorage.getItem(LEGACY_CLAIM_KEY); } catch {}
    if (legacyRaw && !claimedBy) {
      try { localStorage.setItem(storageKey, legacyRaw); localStorage.setItem(LEGACY_CLAIM_KEY, uid); account.claimedLegacy = true; } catch {}
    }
  }
  data = load(storageKey);
  ensureCoreBenefitsInData();
}

async function initAccount() {
  if (authCallback?.kind === 'session') {
    if (authCallback.type === 'recovery') account.notice = 'Yeni şifreni bu ekrandan belirleyebilirsin.';
    else if (authCallback.type === 'signup') showPwaToast('E-posta adresin doğrulandı.');
  }
  if (!cloudConfigured()) { account = { ...account, mode: 'legacy', state: 'ready' }; applyModeUi(); showRoute(); return; }
  account = { ...account, mode: 'profile', state: 'loading' };
  applyModeUi(); showRoute();
  let info = { signedIn: false };
  try { info = await sessionInfo(); } catch { info = { signedIn: false }; }
  if (!info.signedIn) {
    data.cards = []; setAccountState('signed_out', { userId: null, email: null, profile: null });
    const st = $('#authStatus');
    if (st && authCallback?.kind === 'error') {
      st.textContent = /expired|otp/i.test(`${authCallback.code} ${authCallback.description}`)
        ? 'Doğrulama bağlantısının süresi dolmuş veya bağlantı daha önce kullanılmış. Hesabın doğrulanmış olabilir: e-posta ve şifrenle giriş yap. Gerekirse “Şifremi unuttum” ile yeni bağlantı iste.'
        : 'Doğrulama bağlantısı geçersiz. E-posta ve şifrenle giriş yapmayı dene; olmazsa yeni bağlantı iste.';
    } else if (st && (authCallback?.kind === 'signin_required' || authCallback?.kind === 'session')) {
      st.textContent = 'E-posta adresin doğrulandı. Devam etmek için giriş yap.';
    }
    return;
  }
  await enterSignedIn(info);
  // Şifre sıfırlama dönüşü: yükleme ekranı (#/durum) ara adresi ezdiği için, profil hazır olunca Hesap ekranına geç.
  if (authCallback?.kind === 'session' && authCallback.type === 'recovery' && account.state === 'ready' && location.hash !== '#/profil/hesap') {
    history.replaceState(null, '', `${location.pathname}#/profil/hesap`);
    showRoute();
  }
}

async function enterSignedIn(info) {
  account = { ...account, mode: 'profile', userId: info.userId, email: info.email, profile: null, serverProfile: null, error: null };
  activateUserData(info.userId);
  // v1.5.0: katalog GLOBALDİR; kullanıcıya özel yerel veriye geçince güncel global katalog yeniden yüklenir
  // (aksi halde ilk girişte yalnız paketli çekirdek kayıtlar görünürdü).
  loadLiveCatalog();
  const cached = readProfileCache(localStorage, info.userId);
  const cacheReady = cached?.profile && isProfileComplete(cached.profile);
  if (cacheReady) {
    // v1.4.2 ve öncesinin önbelleğe aldığı katalog eşik kodlu seçenekler taşır; kullanılmaz (paketli katalog + sunucu).
    account.catalog = cached.catalog?.schema === PROFILE_CATALOG_SCHEMA ? cached.catalog : BUNDLED_PROFILE_CATALOG;
    account.profile = normalizeProfile(cached.profile, account.catalog);
    account.serverProfile = clone(account.profile);
    renderAll();
    setAccountState('ready');
  } else {
    setAccountState('loading');
  }
  try {
    const store = profileStore();
    const master = await store.loadMaster();
    const serverProfile = await store.loadProfile(info.userId, master);
    account.store = store; account.master = master; account.catalog = master.catalog;
    if (!serverProfile || !isProfileComplete(serverProfile)) {
      account.serverProfile = serverProfile ? normalizeProfile(serverProfile, master.catalog) : null;
      account.profile = null;
      account.draft = await buildOnboardingDraft(serverProfile);
      account.onbStep = 'banks';
      data.cards = [];
      setAccountState('needs_onboarding');
      return;
    }
    account.profile = normalizeProfile(serverProfile, master.catalog);
    account.serverProfile = clone(account.profile);
    writeProfileCache(localStorage, info.userId, { profile: account.profile, catalog: master.catalog, savedAt: new Date().toISOString() });
    renderAll();
    if (account.state !== 'ready') setAccountState('ready'); else { applyModeUi(); renderAccountSummary(); }
  } catch (e) {
    if (e instanceof SchemaMissingError) { enterLegacyFallback(); return; }
    if (cacheReady) { showPwaToast('Profil sunucusuna ulaşılamadı; cihazdaki son profil kullanılıyor.'); return; }
    // Ağ/sunucu hatası onboarding'i ASLA tetiklemez: kullanıcı profilini yeniden oluşturmak zorunda kalmamalı.
    setAccountState('error', { error: e.message || String(e) });
  }
}

function enterLegacyFallback() {
  account = { ...account, mode: 'legacy', state: 'ready', profile: null, notice: 'Hesaba bağlı profil sunucuda henüz etkin değil (migration 008–010). Uygulama eski tek-kullanıcı modunda çalışıyor.' };
  data.profileMode = false;
  if (!(data.cards || []).length) data.cards = clone(initialCards);
  renderAll();
  applyModeUi(); showRoute();
  showPwaToast('Profil sunucusu hazır değil; eski modda çalışılıyor.');
}

async function buildOnboardingDraft(serverProfile) {
  const catalog = account.catalog;
  if (serverProfile && ((serverProfile.banks || []).length || (serverProfile.cards || []).length)) return normalizeProfile({ ...serverProfile, onboardingCompletedAt: null }, catalog);
  // Ön-doldurma (onaysız kaydedilmez): kullanıcının kendi bulut satırındaki ayarlar + bu cihazdan devraldığı eski veri.
  let settings = {};
  try { const row = await fetchCloudUserState(); if (row?.settings) settings = row.settings; } catch {}
  let claimedBy = null, legacy = null;
  try { claimedBy = localStorage.getItem(LEGACY_CLAIM_KEY); legacy = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch {}
  const mine = claimedBy === account.userId && legacy;
  const legacyCards = mine ? (legacy.cards || []) : [];
  const legacySettings = mine ? (legacy.settings || {}) : {};
  const prefill = legacyToProfilePrefill({ settings: { ...legacySettings, ...settings }, cards: legacyCards }, catalog);
  return { ...prefill, onboardingCompletedAt: null };
}

async function doSignOut() {
  await signOut();
  try { localStorage.removeItem('banka-kampanya-avcisi-last-query-debug'); } catch {}
  lastQueryDebug = null;
  storageKey = STORAGE_KEY;
  data = load('__signed_out__'); data.cards = []; ensureCoreBenefitsInData();
  const results = $('#recommendResults'); if (results) results.innerHTML = '';
  account = { ...account, userId: null, email: null, profile: null, serverProfile: null, draft: null, store: null, master: null, claimedLegacy: false, notice: null };
  if (cloudConfigured()) setAccountState('signed_out'); else { applyModeUi(); showRoute(); }
  showPwaToast('Çıkış yapıldı.');
}

// ---------- Giriş / kayıt ----------
let authMode = 'signin';
function renderAuthMode() {
  const signup = authMode === 'signup';
  $('#authTitle').textContent = signup ? 'Hesap oluştur' : 'Giriş yap';
  $('#authSubmitBtn').textContent = signup ? 'Hesap oluştur' : 'Giriş yap';
  $('#authModeToggle').textContent = signup ? 'Zaten hesabın var mı? Giriş yap' : 'Hesabın yok mu? Hesap oluştur';
  $('#authPassword').setAttribute('autocomplete', signup ? 'new-password' : 'current-password');
}

function wireAuth() {
  renderAuthMode();
  $('#authModeToggle').addEventListener('click', () => { authMode = authMode === 'signin' ? 'signup' : 'signin'; renderAuthMode(); $('#authStatus').textContent = ''; });
  $('#authForgotBtn').addEventListener('click', async () => {
    const email = $('#authEmail').value.trim();
    const st = $('#authStatus');
    if (!email) { st.textContent = 'Şifre sıfırlama bağlantısı için e-postanı yaz.'; return; }
    try { await requestPasswordReset(email); st.textContent = 'Şifre sıfırlama bağlantısı e-postana gönderildi.'; }
    catch (e) { st.textContent = e.message; }
  });
  $('#authForm').addEventListener('submit', async e => {
    e.preventDefault();
    const email = $('#authEmail').value.trim();
    const password = $('#authPassword').value;
    const st = $('#authStatus');
    const btn = $('#authSubmitBtn');
    if (!email || password.length < 8) { st.textContent = 'Geçerli bir e-posta ve en az 8 karakterli şifre gir.'; return; }
    btn.disabled = true; st.textContent = authMode === 'signup' ? 'Hesap oluşturuluyor…' : 'Giriş yapılıyor…';
    try {
      if (authMode === 'signup') {
        const out = await signUp(email, password);
        if (!out.access_token) { st.textContent = 'Hesap oluşturuldu. E-postana gelen bağlantıyla doğrula, sonra giriş yap.'; authMode = 'signin'; renderAuthMode(); return; }
      } else {
        await signIn(email, password);
      }
      $('#authPassword').value = '';
      st.textContent = '';
      await enterSignedIn(await sessionInfo());
    } catch (err) {
      st.textContent = `${authMode === 'signup' ? 'Kayıt' : 'Giriş'} başarısız: ${err.message}`;
    } finally { btn.disabled = false; }
  });
}

// ---------- Ortak profil düzenleyicileri (onboarding + Profil ekranları) ----------
function toggleRow({ action, code, on, title, subtitle = '' }) {
  return `<button type="button" class="toggle-row${on ? ' on' : ''}" role="switch" aria-checked="${on}" data-action="${action}" data-code="${esc(code)}">
    <span class="toggle-text"><strong>${esc(title)}</strong>${subtitle ? `<small>${esc(subtitle)}</small>` : ''}</span><span class="toggle-check" aria-hidden="true">${on ? '✓' : ''}</span></button>`;
}

function banksHtml(profile, catalog) {
  const banks = [...catalog.banks].sort((a, b) => (a.sortOrder ?? 100) - (b.sortOrder ?? 100));
  const registry = sourceRegistry();
  return `<div class="toggle-list">${banks.map(b => {
    const n = catalog.cardProducts.filter(c => c.bankCode === b.code).length;
    const badge = supportBadge(bankCoverage(b.code, catalog, { registry }).level);
    return toggleRow({ action: 'bank', code: b.code, on: profile.banks.includes(b.code), title: b.name,
      subtitle: [n ? `${n} kart ürünü` : 'Kart listesi hazırlanıyor', badge].filter(Boolean).join(' · ') });
  }).join('')}</div>${bankRequestHtml()}`;
}

// v1.5.0 — "Bankam listede yok": yalnız destek İSTEĞİ oluşturur; banka/kart/kampanya oluşturmaz.
function bankRequestHtml() {
  if (account.mode !== 'profile' || !account.userId) return '';
  return `<details class="bank-request"><summary>Bankam listede yok</summary>
    <p class="muted small">Bankanın adını yaz; en çok istenen bankalar önceliklendirilir. Bu istek profilini veya banka listesini değiştirmez.</p>
    <div class="bank-request-row"><input type="text" class="bank-request-name" maxlength="80" placeholder="ör. ING, Kuveyt Türk" aria-label="Banka adı">
    <button type="button" class="secondary" data-action="bank-request-send">Gönder</button></div>
    <p class="muted small bank-request-status" role="status"></p></details>`;
}

async function sendBankRequest(btn) {
  const box = btn.closest('.bank-request');
  const input = box?.querySelector('.bank-request-name');
  const st = box?.querySelector('.bank-request-status');
  const name = String(input?.value || '').trim();
  if (!normalizeBankRequestName(name)) { if (st) st.textContent = 'Geçerli bir banka adı yaz.'; return; }
  if (!account.store) { if (st) st.textContent = 'Sunucuya bağlanılamadı; daha sonra tekrar dene.'; return; }
  btn.disabled = true;
  try {
    await account.store.requestBankSupport(account.userId, name);
    if (st) st.textContent = 'Teşekkürler, isteğin kaydedildi.';
    if (input) input.value = '';
  } catch (e) {
    if (st) st.textContent = e?.name === 'SchemaMissingError' ? 'Banka istekleri sunucuda henüz etkin değil.' : `Kaydedilemedi: ${e.message}`;
  } finally { btn.disabled = false; }
}

function cardsHtml(profile, catalog, { showAllBanks = false } = {}) {
  const banks = [...catalog.banks].sort((a, b) => (a.sortOrder ?? 100) - (b.sortOrder ?? 100)).filter(b => showAllBanks || profile.banks.includes(b.code));
  if (!banks.length) return '<p class="muted">Önce banka seç.</p>';
  return banks.map(b => {
    const cards = catalog.cardProducts.filter(c => c.bankCode === b.code).sort((x, y) => (x.sortOrder ?? 100) - (y.sortOrder ?? 100));
    if (!cards.length) return `<div class="bank-group" data-bank="${esc(b.code)}"><h4>${esc(b.name)}</h4><p class="muted small no-cards">Bu banka için kart listesi henüz hazırlanmadı. Bankayı profilinde tutabilirsin; kartlar ve kampanyalar eklendiğinde burada görünecek.</p></div>`;
    return `<div class="bank-group"><h4>${esc(b.name)}</h4><div class="toggle-list">${cards.map(c => toggleRow({ action: 'card', code: c.code, on: profile.cards.includes(c.code), title: c.name })).join('')}</div></div>`;
  }).join('');
}

function attributesHtml(profile, catalog) {
  const dims = applicableDimensions(profile, catalog);
  if (!dims.length) return '<p class="muted">Seçtiğin kartlar için ek segment/statü sorusu yok.</p>';
  return dims.map(d => {
    const current = profile.attributes[d.code] ?? null;
    const opts = [...d.options].sort((a, b) => (a.sortOrder ?? 100) - (b.sortOrder ?? 100));
    const st = attributeConfirmationStatus(profile, catalog, d.code);
    // Ölçütün kaynağı ve doğrulama durumu (tutar sorulmaz; yalnız bant seçilir).
    const crit = current ? currentCriteria(catalog, d.code, current) : null;
    const source = crit ? `<p class="muted small attr-source">Kaynak: <a href="${esc(crit.sourceUrl)}" target="_blank" rel="noopener">resmi sayfa</a> · ${crit.verifiedAt ? `doğrulandı ${esc(String(crit.verifiedAt).slice(0, 10))}` : 'yeniden doğrulanmadı'}</p>` : '';
    const attention = REQUIRES_RECONFIRMATION.has(st.status)
      ? `<div class="attr-reconfirm" data-dim="${esc(d.code)}"><p class="small">Bu bandın tanımı (eşikleri) seçimini onayladığından beri güncellendi. Hâlâ bu bantta mısın? Onaylayana kadar bu seçim hesaplamalarda “bilinmiyor” sayılır.</p>
         <button type="button" class="chip on" data-action="confirm-attr" data-dim="${esc(d.code)}">Evet, ${esc(optionDisplayLabel(catalog, d.code, current))}</button></div>`
      : st.status === 'criteria_unavailable' ? '<p class="small attr-reconfirm">Bu bandın güncel tanımı şu an mevcut değil; seçimin hesaplamalarda “bilinmiyor” sayılır.</p>' : '';
    return `<fieldset class="attr-group" data-status="${esc(st.status)}"><legend>${esc(d.label)}</legend>${attention}<div class="chip-row">
      ${opts.map(o => `<button type="button" class="chip${current === o.code ? ' on' : ''}" aria-pressed="${current === o.code}" data-action="attr" data-dim="${esc(d.code)}" data-code="${esc(o.code)}">${esc(optionDisplayLabel(catalog, d.code, o.code))}</button>`).join('')}
      <button type="button" class="chip chip-muted${current === null ? ' on' : ''}" aria-pressed="${current === null}" data-action="attr" data-dim="${esc(d.code)}" data-code="">Bilmiyorum</button>
    </div>${source}</fieldset>`;
  }).join('') + '<p class="muted small">Segment seçilmezse o segmente özel kampanyalar ve oranlar kesin hesaplanmaz.</p>';
}

function applyEditorAction(profile, el, catalog) {
  const { action, code, dim } = el.dataset;
  if (action === 'bank') return toggleBank(profile, code, !profile.banks.includes(code), catalog);
  if (action === 'card') return toggleCard(profile, code, !profile.cards.includes(code), catalog);
  if (action === 'attr') return setAttribute(profile, dim, code || null, catalog);
  if (action === 'confirm-attr') return confirmAttribute(profile, dim, catalog);
  return profile;
}

async function persistProfile(next, { statusEl } = {}) {
  if (!account.store || !account.master) throw new Error('Profil sunucusuna bağlanılamadı; değişiklik kaydedilemedi.');
  const before = account.serverProfile || emptyProfile();
  const diff = diffProfiles(before, next);
  await account.store.saveProfile(account.userId, diff, next, account.master);
  // Daha önce etkin olan segmentler: kayıtlı profil; ilk kurulumda bu cihazdaki önceki (eski mod) ayarlar.
  // Yalnız gerçekten DEĞİŞEN segmentlerin bankalarında kalan-limit doğrulaması sıfırlanır.
  const previousEffective = account.profile || { attributes: Object.fromEntries((account.catalog.dimensions || [])
    .filter(d => d.settingKey && data.settings?.[d.settingKey] != null).map(d => [d.code, data.settings[d.settingKey]])) };
  const affectedBanks = banksAffectedByAttributeChange(previousEffective, next, account.catalog);
  account.profile = clone(next);
  account.serverProfile = clone(next);
  writeProfileCache(localStorage, account.userId, { profile: account.profile, catalog: account.catalog, savedAt: new Date().toISOString() });
  syncCardSegmentsFromSettings();
  for (const bank of affectedBanks) invalidateSegmentDependentStates(bank);
  save(); renderAll();
  if (statusEl) statusEl.textContent = 'Kaydedildi ✓';
}

async function savePreferences(patch) {
  if (!account.profile) return;
  const next = { ...account.profile, preferences: { ...(account.profile.preferences || {}), ...patch } };
  try { await persistProfile(next); } catch (e) { showPwaToast(`Tercih kaydedilemedi: ${e.message}`); }
}

// ---------- Onboarding ----------
function renderOnboarding() {
  const body = $('#onboardingBody'); if (!body) return;
  const draft = account.draft || emptyProfile();
  const step = account.onbStep || 'banks';
  $$('#onboardingSteps li').forEach(li => { li.classList.toggle('current', li.dataset.step === step); });
  const intro = {
    banks: ['Hangi bankaları kullanıyorsun?', 'Kartlarını seçebilmen için önce bankalarını işaretle.'],
    cards: ['Hangi kartların var?', 'Yalnız sahip olduğun kartlar karşılaştırılır.'],
    attributes: ['Segment ve statülerin', 'Bunlar kampanya uygunluğunu ve oranları belirler. Emin değilsen “Bilmiyorum” seç.'],
    review: ['Profilini kontrol et', 'Bu seçimleri daha sonra Profil ekranından istediğin zaman değiştirebilirsin.'],
  }[step];
  let content = '';
  if (step === 'banks') content = banksHtml(draft, account.catalog);
  else if (step === 'cards') content = cardsHtml(draft, account.catalog);
  else if (step === 'attributes') content = attributesHtml(draft, account.catalog);
  else content = reviewHtml(draft, account.catalog);
  body.innerHTML = `<h2 class="onb-title">${esc(intro[0])}</h2><p class="muted">${esc(intro[1])}</p>${content}`;
  $('#onbBack').hidden = step === 'banks';
  $('#onbNext').hidden = step === 'review';
  $('#onbFinish').hidden = step !== 'review';
  $('#onbFinish').disabled = !canCompleteOnboarding(draft, account.catalog);
}

function reviewHtml(profile, catalog) {
  const engineCards = profileToEngineCards(profile, catalog);
  const dims = applicableDimensions(profile, catalog);
  const attrs = dims.map(d => { const o = d.options.find(x => x.code === profile.attributes[d.code]); return `<li><span>${esc(d.label)}</span><strong>${esc(o ? optionDisplayLabel(catalog, d.code, o.code) : 'Seçilmedi')}</strong></li>`; }).join('');
  return `<div class="review"><h4>Kartların</h4><ul class="review-list">${engineCards.map(c => `<li><span>${esc(c.bank)}</span><strong>${esc(c.name)}</strong></li>`).join('') || '<li>Kart seçilmedi</li>'}</ul>
    ${attrs ? `<h4>Segment ve statüler</h4><ul class="review-list">${attrs}</ul>` : ''}</div>`;
}

function wireOnboarding() {
  $('#onboardingBody').addEventListener('click', e => {
    const el = e.target.closest('[data-action]'); if (!el) return;
    if (el.dataset.action === 'bank-request-send') { sendBankRequest(el); return; }
    account.draft = applyEditorAction(account.draft || emptyProfile(), el, account.catalog);
    $('#onboardingStatus').textContent = '';
    renderOnboarding();
  });
  $('#onbNext').addEventListener('click', () => {
    const r = nextOnboardingStep(account.onbStep || 'banks', account.draft || emptyProfile(), account.catalog);
    $('#onboardingStatus').textContent = r.error || '';
    account.onbStep = r.step; renderOnboarding(); window.scrollTo(0, 0);
  });
  $('#onbBack').addEventListener('click', () => {
    account.onbStep = previousOnboardingStep(account.onbStep || 'banks', account.draft || emptyProfile(), account.catalog);
    $('#onboardingStatus').textContent = ''; renderOnboarding(); window.scrollTo(0, 0);
  });
  $('#onbFinish').addEventListener('click', async () => {
    const st = $('#onboardingStatus');
    const draft = account.draft || emptyProfile();
    if (!canCompleteOnboarding(draft, account.catalog)) { st.textContent = 'En az bir kart seç.'; return; }
    $('#onbFinish').disabled = true; st.textContent = 'Profil kaydediliyor…';
    try {
      // İnceleme ekranında gösterilen (güncel ölçüt etiketli) seçimler bu adımda onaylanmış olur.
      await persistProfile({ ...confirmPendingAttributes(draft, account.catalog), onboardingCompletedAt: new Date().toISOString() });
      account.draft = null;
      history.replaceState(null, '', DEFAULT_ROUTE);
      setAccountState('ready');
      showPwaToast('Profilin hazır.');
    } catch (e) { st.textContent = `Kaydedilemedi: ${e.message}`; $('#onbFinish').disabled = false; }
  });
  $('#onbSignOut').addEventListener('click', doSignOut);
}

// ---------- Profil › Bankalarım ve Kartlarım / Müşteri Profili ----------
const editors = { cards: null, attrs: null };
function editorDirty(key) { return editors[key] && JSON.stringify(editors[key]) !== JSON.stringify(account.profile); }

function openCardsEditor() {
  if (account.mode !== 'profile' || !account.profile) return;
  if (!editorDirty('cards')) editors.cards = clone(account.profile);
  renderCardsEditor();
}
function renderCardsEditor() {
  const el = $('#profileCardsEditor'); if (!el || !editors.cards) return;
  el.innerHTML = `<div class="settings-card"><h3>Bankalarım</h3>${banksHtml(editors.cards, account.catalog)}</div>
    <div class="settings-card"><h3>Kartlarım</h3>${cardsHtml(editors.cards, account.catalog)}</div>`;
  const dirty = editorDirty('cards');
  $('#profileCardsStatus').textContent = dirty ? 'Kaydedilmemiş değişiklik var' : 'Kaydedildi ✓';
  $('#profileCardsSave').disabled = !dirty;
}
function openAttributesEditor() {
  if (account.mode !== 'profile' || !account.profile) return;
  if (!editorDirty('attrs')) editors.attrs = clone(account.profile);
  renderAttributesEditor();
}
function renderAttributesEditor() {
  const el = $('#profileAttributesEditor'); if (!el || !editors.attrs) return;
  el.innerHTML = `<div class="settings-card">${attributesHtml(editors.attrs, account.catalog)}</div>`;
  const dirty = editorDirty('attrs');
  $('#profileAttributesStatus').textContent = dirty ? 'Kaydedilmemiş değişiklik var' : 'Kaydedildi ✓';
  $('#profileAttributesSave').disabled = !dirty;
}

function wireProfileEditors() {
  $('#profileCardsEditor').addEventListener('click', e => {
    const el = e.target.closest('[data-action]'); if (!el || !editors.cards) return;
    if (el.dataset.action === 'bank-request-send') { sendBankRequest(el); return; }
    editors.cards = applyEditorAction(editors.cards, el, account.catalog); renderCardsEditor();
  });
  $('#profileAttributesEditor').addEventListener('click', e => {
    const el = e.target.closest('[data-action]'); if (!el || !editors.attrs) return;
    editors.attrs = applyEditorAction(editors.attrs, el, account.catalog); renderAttributesEditor();
  });
  $('#profileCardsSave').addEventListener('click', async () => {
    const st = $('#profileCardsStatus');
    if (!canCompleteOnboarding(editors.cards, account.catalog)) { st.textContent = 'En az bir kart seçili kalmalı.'; return; }
    st.textContent = 'Kaydediliyor…'; $('#profileCardsSave').disabled = true;
    try { await persistProfile(editors.cards, { statusEl: st }); editors.cards = clone(account.profile); renderCardsEditor(); }
    catch (e) { st.textContent = `Kaydedilemedi: ${e.message}`; $('#profileCardsSave').disabled = false; }
  });
  $('#profileAttributesSave').addEventListener('click', async () => {
    const st = $('#profileAttributesStatus');
    st.textContent = 'Kaydediliyor…'; $('#profileAttributesSave').disabled = true;
    try { await persistProfile(editors.attrs, { statusEl: st }); editors.attrs = clone(account.profile); renderAttributesEditor(); }
    catch (e) { st.textContent = `Kaydedilemedi: ${e.message}`; $('#profileAttributesSave').disabled = false; }
  });
}

// ---------- Hesap ekranı ve durum ekranı ----------
function renderAccountSummary() {
  const dl = $('#accountSummary'); if (!dl) return;
  applyModeUi();
  if (account.mode !== 'profile' || !account.userId) {
    if (account.notice) { const st = $('#cloudSyncStatus'); if (st) st.textContent = account.notice; }
    return;
  }
  const rows = [
    ['E-posta', account.email || '—'],
    ['Oturum', 'Bu cihazda açık'],
    ['Profil', account.profile?.onboardingCompletedAt ? `Tamamlandı (${formatRefreshTime(account.profile.onboardingCompletedAt)})` : 'Tamamlanmadı'],
    ['Kartlar', String((account.profile?.cards || []).length)],
    ['Profil verisi', account.catalog?.source === 'supabase' ? 'Sunucudan yüklendi' : 'Cihazdaki önbellek'],
  ];
  dl.innerHTML = rows.map(([k, v]) => `<div class="info-row"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
  refreshCloudUi();
  if (account.notice) { $('#changePasswordStatus').textContent = account.notice; account.notice = null; }
}

function renderAccountStatus() {
  const t = $('#accountStatusText'); if (!t) return;
  const err = account.state === 'error';
  t.textContent = err ? `Profil yüklenemedi: ${account.error || 'bilinmeyen hata'}. Bağlantını kontrol edip tekrar dene. Profilin silinmedi.` : 'Profil yükleniyor…';
  $('#accountRetryBtn').hidden = !err;
  $('#accountStatusSignOut').hidden = !err;
}

function wireAccountScreens() {
  $('#accountSignOutBtn').addEventListener('click', doSignOut);
  $('#accountStatusSignOut').addEventListener('click', doSignOut);
  $('#accountRetryBtn').addEventListener('click', async () => {
    let info = { signedIn: false };
    try { info = await sessionInfo(); } catch {}
    if (!info.signedIn) { setAccountState('signed_out'); return; }
    await enterSignedIn(info);
  });
  $('#changePasswordForm').addEventListener('submit', async e => {
    e.preventDefault();
    const v = $('#changePasswordValue').value; const st = $('#changePasswordStatus');
    if (v.length < 8) { st.textContent = 'Şifre en az 8 karakter olmalı.'; return; }
    try { await updatePassword(v); $('#changePasswordValue').value = ''; st.textContent = 'Şifren güncellendi.'; }
    catch (err) { st.textContent = err.message; }
  });
}

let deferredInstallPrompt=null;
function pwaStandalone(){return window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone===true;}
function showPwaToast(msg){const el=$('#pwaToast'); if(!el)return; el.textContent=msg; el.hidden=false; clearTimeout(showPwaToast.t); showPwaToast.t=setTimeout(()=>el.hidden=true,4500);}
function setInstallButtons(show){['#installPwaBtn','#settingsInstallPwaBtn'].forEach(sel=>{const el=$(sel); if(el) el.hidden=!show;});}
async function runPwaInstall(){
  if(deferredInstallPrompt){deferredInstallPrompt.prompt(); const choice=await deferredInstallPrompt.userChoice.catch(()=>null); deferredInstallPrompt=null; setInstallButtons(false); if(choice?.outcome==='accepted')showPwaToast('Uygulama ana ekrana kuruluyor.'); return;}
  const isiOS=/iphone|ipad|ipod/i.test(navigator.userAgent);
  showPwaToast(isiOS?'Safari paylaş menüsü → Ana Ekrana Ekle seçeneğini kullan.':'Tarayıcı menüsünden “Uygulamayı yükle / Ana ekrana ekle” seçeneğini kullan.');
}
function wirePwaInstall(){
  const hint=$('#pwaInstallHint');
  if(pwaStandalone()){setInstallButtons(false); if(hint)hint.textContent='Uygulama kurulu modda çalışıyor.';} else if(hint) hint.textContent='HTTPS adresinden açıldığında Android’de “Uygulamayı yükle”, iPhone’da Safari → Paylaş → Ana Ekrana Ekle ile kurulabilir.';
  window.addEventListener('beforeinstallprompt',e=>{e.preventDefault(); deferredInstallPrompt=e; setInstallButtons(true);});
  window.addEventListener('appinstalled',()=>{deferredInstallPrompt=null;setInstallButtons(false);showPwaToast('Banka Kampanya Avcısı kuruldu.');});
  $('#installPwaBtn')?.addEventListener('click',runPwaInstall); $('#settingsInstallPwaBtn')?.addEventListener('click',runPwaInstall);
  const updateNet=()=>{const b=$('#networkBadge');if(!b)return;b.textContent=navigator.onLine?'Çevrimiçi':'Çevrimdışı';b.classList.toggle('offline',!navigator.onLine);};
  window.addEventListener('online',updateNet);window.addEventListener('offline',updateNet);updateNet();
}

// v1.4.4: Supabase dönüşü (e-posta doğrulama / şifre sıfırlama) yönlendirici adresi değiştirmeden ÖNCE yakalanır.
// Adres çubuğundan jeton/hata parametreleri temizlenir; yol (ör. /Campaign-Hunter/) korunur.
const AUTH_CALLBACK_KEY = 'bka-auth-callback-v1';
const authCallback = captureAuthCallback(location) || (() => {
  // Aynı sekmede açık uygulamaya yalnız hash değişimiyle gelen dönüş: hashchange'te yakalanıp sayfa yeniden yüklenir.
  try { const v = JSON.parse(sessionStorage.getItem(AUTH_CALLBACK_KEY) || 'null'); sessionStorage.removeItem(AUTH_CALLBACK_KEY); return v; } catch { return null; }
})();
if (authCallback) {
  const target = authCallback.kind === 'session' ? (authCallback.type === 'recovery' ? '#/profil/hesap' : DEFAULT_ROUTE) : '#/giris';
  history.replaceState(null, '', `${location.pathname}${target}`);
}

syncResets();
wireNav();
wireCampaignBrowser();
renderRecommendation();
wireDataTools();
wireRefreshTools();
wirePrivateCampaign();
wireCloudTools();
wirePwaInstall();
wireAuth();
wireOnboarding();
wireProfileEditors();
wireAccountScreens();
renderAll();
loadRuntimeVersion().then(() => renderDashboard());
initAccount().finally(() => loadLiveCatalog());

// Ayrı .bat ile başlatılan canlı taramayı da izle. Tarama sırasında karar motoru
// son başarılı tam kataloğu kullanmaya devam eder; yeni katalog yalnız tarama bitince alınır.
let lastObservedRefreshState = null;
let lastObservedCampaignCount = 0;
if (LOCAL_API) setInterval(async () => {
  try {
    const res = await fetch(`${REFRESH_API}/api/status`, { cache: 'no-store' });
    if (!res.ok) return;
    const st = await res.json();
    showRefreshStatus(st);
    setRefreshButtonRunning(st.state === 'running');
    const count = Number(st.campaign_count || 0);
    if (st.state === 'running') lastObservedCampaignCount = Math.max(lastObservedCampaignCount, count);
    if (lastObservedRefreshState === 'running' && st.state !== 'running') {
      await loadLiveCatalog(true);
    }
    lastObservedRefreshState = st.state;
  } catch {}
}, 3000);

// Service worker: her dağıtımda CACHE adı (sürüm + build) değişir; tarayıcı yeni sw.js'i görünce kurar,
// skipWaiting/clients.claim ile hemen devreye girer ve eski önbellekleri siler. Açılışta güncelleme de kontrol edilir.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').then(reg => { try { reg.update(); } catch {} }).catch(() => {});
  let reloadedForUpdate = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadedForUpdate || !navigator.serviceWorker.controller) return;
    reloadedForUpdate = true;
    showPwaToast(`Uygulama güncellendi (${runtimeAppVersion}).`);
  });
}
