import { initialCards, initialCampaigns, initialStates } from './bootstrap-data.js';
import { recommend, money, ensureReset, freshness, ruleMinSpend, resolveMerchantInput, resolveSegmentCampaign } from './engine.js';
import { calculateLoyalty, campaignRewardLabel, THY_STATUSES, QNB_SEGMENTS, WINGS_TIERS, MAXIMILES_BANDS, CRYSTAL_BANDS, CRYSTAL_CARD_TYPES, TEB_TIERS, formatNumber } from './loyalty.js';
import { CAMPAIGN_BROWSER_CATEGORIES, groupCampaignsByCard, merchantScopeInfo, paymentScopeInfo } from './campaign-browser.js';
import { cloudConfigured, cloudConfigSummary, sessionInfo, signUp, signIn, signOut, testCloudConnection, fetchCloudCatalog, fetchCloudUserState, saveCloudUserState, triggerCloudRefresh } from './cloud-sync.js';

const STORAGE_KEY = 'banka-kampanya-avcisi-v10';
const REFRESH_API = '';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

function clone(v) { return JSON.parse(JSON.stringify(v)); }
function esc(v) { return String(v ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }


const CORE_BENEFITS = initialCampaigns.filter(c => c.coreBenefit === true);
function normSourceUrl(u) { return String(u || '').trim().replace(/\/+$/, '').toLowerCase(); }
const NAV_MERCHANT_NOISE = /^(?:ana sayfa|bireysel bankacılık|krediler|kartlar|kredi kartları|mevduat ürünleri|yatırım ürünleri|ödemeler ve hizmetler|sigorta ve emeklilik|hesaplama araçları|şube ve|atm(?:'ler|ler)?|kendim için|işim için|geri)$/i;

function safeMerchantScope(core, live) {
  const cs = core?.merchantScope || { kind: 'all' };
  const ls = live?.merchantScope || null;
  if (!ls || cs.kind !== 'contains' || ls.kind !== 'contains') return cs;
  const liveValues = (ls.values || []).filter(v => v && !NAV_MERCHANT_NOISE.test(String(v).trim()));
  if (!liveValues.length) return cs;
  const values = [...new Set([...(cs.values || []), ...liveValues])];
  const excludedValues = [...new Set([...(cs.excludedValues || []), ...(ls.excludedValues || [])])];
  return { ...cs, ...ls, values, excludedValues, requiresBranchConfirmation: cs.requiresBranchConfirmation === true || ls.requiresBranchConfirmation === true };
}

function mergeCatalogWithCore(campaigns = []) {
  const live = clone(Array.isArray(campaigns) ? campaigns : []);
  const consumed = new Set();
  const cores = CORE_BENEFITS.map(core => {
    const i = live.findIndex((c, idx) => !consumed.has(idx) && (
      (core.sourceUrl && normSourceUrl(c.sourceUrl) === normSourceUrl(core.sourceUrl)) || c.id === core.id
    ));
    const observed = i >= 0 ? live[i] : null;
    if (i >= 0) consumed.add(i);
    // Sürekli kart ayrıcalığının finansal/segment kuralları doğrulanmış core kayıttan gelir.
    // Canlı kaynak yalnızca işyeri kapsamı ve son görülme bilgisini zenginleştirir; bozuk parser core kuralını silemez.
    return {
      ...(observed || {}),
      ...clone(core),
      merchantScope: safeMerchantScope(core, observed),
      verifiedAt: observed?.verifiedAt || core.verifiedAt,
      rawTextDigest: observed?.rawTextDigest || core.rawTextDigest,
      sourceKind: 'core_benefit',
      coreBenefit: true,
      liveObserved: Boolean(observed),
    };
  });
  return [...cores, ...live.filter((_, idx) => !consumed.has(idx) && !CORE_BENEFITS.some(core => core.id === live[idx]?.id))];
}

function ensureCoreBenefitsInData() {
  data.campaigns = mergeCatalogWithCore(data.campaigns || []);
  data.states = data.states || {};
  for (const core of CORE_BENEFITS) {
    if (!data.states[core.id] && initialStates[core.id]) data.states[core.id] = clone(initialStates[core.id]);
  }
}

let lastQueryDebug = null;
let runtimeAppVersion = 'v1.2.0-pwa';
let campaignBrowserState = { category: 'all', search: '', onlyComplete: false, selectedKey: null };

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
    settings: { staleAfterDays: 3, thyStatus: 'classic', qnbSegment: 'private', wingsTier: 'black_plus', maximilesBand: '4m_8m', crystalBand: 'under_1m', crystalCardType: 'crystal', tebTier: 'ultra' },
    meta: { version: 13, createdAt: new Date().toISOString(), catalogGeneratedAt: null }
  };
}

let data = load();
ensureCoreBenefitsInData();
syncCardSegmentsFromSettings();

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const loaded = raw ? JSON.parse(raw) : seed();
    loaded.settings = {
      staleAfterDays: 3, thyStatus: 'classic', qnbSegment: 'private', wingsTier: 'black_plus',
      maximilesBand: '4m_8m', crystalBand: 'under_1m', crystalCardType: 'crystal', tebTier: 'ultra',
      ...(loaded.settings || {})
    };
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

function selectedLabel(items, value, fallbackValue) {
  return (items.find(x => x.value === value) || items.find(x => x.value === fallbackValue) || items[0])?.cardLabel
    || (items.find(x => x.value === value) || items.find(x => x.value === fallbackValue) || items[0])?.label
    || '';
}

function syncCardSegmentsFromSettings() {
  for (const card of data.cards || []) {
    if (card.cardProductId === 'qnb-ms-private') card.segment = selectedLabel(QNB_SEGMENTS, data.settings.qnbSegment, 'private');
    else if (card.cardProductId === 'akbank-wings-elite' || card.cardProductId === 'akbank-wings-black') card.segment = selectedLabel(WINGS_TIERS, data.settings.wingsTier, 'black_plus').replace(/^Standart\s*\//, 'Classic /');
    else if (card.cardProductId === 'is-maximiles-black') card.segment = selectedLabel(MAXIMILES_BANDS, data.settings.maximilesBand, '4m_8m');
    else if (card.cardProductId === 'ykb-crystal') card.segment = data.settings.crystalCardType === 'metal_crystal' ? 'Metal Crystal' : selectedLabel(CRYSTAL_BANDS, data.settings.crystalBand, 'under_1m');
    else if (card.cardProductId === 'teb-infinite') card.segment = selectedLabel(TEB_TIERS, data.settings.tebTier, 'ultra');
  }
}

function invalidateSegmentDependentStates(bank) {
  const now = new Date().toISOString();
  for (const campaign of data.campaigns || []) {
    if (campaign.bank !== bank) continue;
    const dependsOnSegment = (campaign.eligibility?.segmentLabels?.length || 0) > 0 || Boolean(campaign.segmentRules);
    if (!dependsOnSegment) continue;
    const prev = data.states[campaign.id] || {};
    data.states[campaign.id] = { ...prev, remainingLimit: null, lastUpdatedAt: now, source: 'segment_change', note: 'Segment değişti; kalan kampanya hakkı yeniden doğrulanmalı.' };
  }
}

function save() { data.meta = {...(data.meta||{}), updatedAt:new Date().toISOString()}; localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); }

function cardForCampaign(campaign) {
  return (data.cards || []).find(card => campaign.cardProductIds?.includes(card.cardProductId)) || null;
}

function effectiveCampaign(campaign) {
  const card = cardForCampaign(campaign);
  return card ? resolveSegmentCampaign(campaign, card) : campaign;
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
      health.innerHTML = `<strong>Canlı katalog:</strong> ${esc(m.campaign_count ?? 0)} canlı kampanya + ${esc(coreCount)} sürekli kart ayrıcalığı · ${esc(covered)}/${esc(reports.length || '?')} resmi kaynakta uygun kayıt · ${esc(errors)} kaynak hatası · son tarama ${esc(formatRefreshTime(generated))} · sürüm ${esc(runtimeAppVersion)}.${sourceAlert.length ? `<br><strong>Kaynak kontrolü:</strong> ${sourceAlert.map(esc).join(' · ')}` : ''}`;
      health.classList.toggle('warn', errors > 0 || sourceAlert.length > 0);
    } else {
      health.innerHTML = '<strong>Başlangıç kataloğu:</strong> Canlı resmi tarama arka planda başlatılıyor. Ayarlar → Şimdi yenile ile durumu kontrol edebilirsin.';
    }
  }

  $('#cardsGrid').innerHTML = data.cards.map(card => `
    <article class="card-item">
      <div class="bank">${esc(card.bank)}</div>
      <h3>${esc(card.name)}</h3>
      <div class="muted">${esc(card.segment)}</div>
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
    <div class="badges">${browserEnrollmentBadge(c,s)}${c.coreBenefit ? badge('Sürekli', 'ok') : ''}${c.rulesComplete === false ? badge('Detay eksik', 'warn') : ''}${categoryAuditInfo(c).low ? badge('Kategori teyitsiz', 'warn') : ''}</div>
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
    for (const c of group.campaigns) {
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
      <div><div class="bank">${esc(card.bank)} — ${esc(card.name)}</div><h3>${esc(c.title)}</h3><div class="muted">${esc(card.segment)} · ${esc(c.startDate || '?')} → ${esc(end)}</div></div>
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
  const completeEl = $('#campaignBrowseOnlyComplete');
  if (completeEl) completeEl.checked = campaignBrowserState.onlyComplete;

  let groups = groupCampaignsByCard({
    campaigns: data.campaigns,
    cards: data.cards,
    category: campaignBrowserState.category,
    resolveCampaign: (raw, card) => resolveSegmentCampaign(raw, card),
    now: new Date()
  }).map(group => ({
    ...group,
    campaigns: group.campaigns.filter(c => (!campaignBrowserState.onlyComplete || c.rulesComplete !== false) && browseSearchMatch(c, campaignBrowserState.search))
  }));

  const total = groups.reduce((n,g) => n + g.campaigns.length, 0);
  const categoryLabel = CAMPAIGN_BROWSER_CATEGORIES.find(([v]) => v === campaignBrowserState.category)?.[1] || 'Kategori';
  const summary = $('#campaignBrowseSummary');
  if (summary) summary.innerHTML = `<strong>${esc(categoryLabel)}:</strong> ${esc(total)} kart-kampanya eşleşmesi gösteriliyor. Aynı kampanya birden fazla kartında geçerliyse her kart grubunda ayrı görünür.`;

  const currentKeys = new Set(groups.flatMap(g => g.campaigns.map(c => campaignBrowseKey(g.card,c))));
  if (campaignBrowserState.selectedKey && !currentKeys.has(campaignBrowserState.selectedKey)) campaignBrowserState.selectedKey = null;

  const container = $('#campaignList');
  container.innerHTML = groups.map(group => `<section class="campaign-card-group">
    <div class="campaign-card-group-head">
      <div><div class="bank">${esc(group.card.bank)}</div><h3>${esc(group.card.name)}</h3><div class="muted">${esc(group.card.segment)}</div></div>
      <span class="campaign-count-pill">${esc(group.campaigns.length)} kampanya</span>
    </div>
    <div class="campaign-browser-items">${group.campaigns.length ? group.campaigns.map(c => campaignCompactHtml(group.card,c)).join('') : '<div class="empty-card-campaigns">Bu kategoride aktif kampanya bulunamadı.</div>'}</div>
  </section>`).join('');

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
  const complete = $('#campaignBrowseOnlyComplete');
  if (complete) complete.addEventListener('change', () => { campaignBrowserState.onlyComplete = complete.checked; campaignBrowserState.selectedKey = null; renderCampaigns(); });
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
    campaign.eligibility?.segmentLabels?.length ? `Segment ${campaign.eligibility.segmentLabels.join(', ')}` : null
  ].filter(Boolean).join(' · ');
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
      return alert(`Kategori güvenle belirlenemedi. Lütfen kategoriyi seç.${hint}`);
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
      staleAfterDays: data.settings.staleAfterDays
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
        rewardLine = `Teorik ${campaignRewardLabel(b.campaign, b.theoreticalReward)} · sonuç kalan limit/işlem sırası doğrulamasına bağlı`;
        cls = 'warn-text';
      } else {
        rewardLine = `${b.conditional ? 'Koşullu avantaj' : 'Hesaplanan avantaj'} ${campaignRewardLabel(b.campaign, b.actualReward)}`;
        if (b.conditional) cls = 'warn-text';
      }
      const fresh = b.freshness.status === 'stale' ? ` · ⚠ ${b.freshness.label}` : ` · ${b.freshness.label}`;
      const warnings = b.inspection.warnings.length ? `<div class="condition-box"><strong>Kontrol et:</strong> ${b.inspection.warnings.map(esc).join(' ')}</div>` : '';

      return `
        <article class="result-card ${rank === 1 ? 'top' : ''}">
          <div class="rank">${rank}</div>
          <div class="result-body">
            <strong>${esc(r.card.bank)} — ${esc(r.card.name)}</strong>
            <div>${esc(b.campaign.title)}</div>
            <div class="rule-line">${esc(ruleDetailBits(b.campaign))}</div>
            <div class="result-reward ${cls}">${rewardLine}</div>
            <div class="muted">Kalan: ${b.state.remainingLimit == null ? 'Bilinmiyor' : campaignRewardLabel(b.campaign, b.state.remainingLimit)}${fresh}</div>
            ${loyaltyHtml(r.card, loyaltyCtx)}
            ${warnings}
          </div>
        </article>`;
    }).join('');

    const potentials = results.flatMap(r => (r.potentials || []).map(p => ({ r, p })));
    const potentialHtml = potentials.length
      ? `<div class="potential-section"><h3>Potansiyel kampanyalar</h3><p class="muted">Mevcut işlem kampanyayı henüz sağlamıyor; aşağıda hangi koşulun eksik olduğu gösteriliyor.</p>${potentials.map(({r,p}) => potentialCardHtml(r,p)).join('')}</div>`
      : '';

    const infos = results.flatMap(r => (r.informational || []).map(i => ({r,i})));
    const infoHtml = infos.length ? `<div class="info-section"><h3>İlgili diğer kampanyalar</h3><p class="muted">Bu kampanyalar resmi kaynakta bulundu ancak otomatik hesap için tüm koşullar güvenle çözümlenemedi. Kaybolmazlar; resmi detayı açıp kontrol edebilirsin.</p>${infos.map(({r,i}) => `<article class="result-card info-card"><div class="rank">i</div><div class="result-body"><div class="info-label">BİLGİ AMAÇLI</div><strong>${esc(r.card.bank)} — ${esc(r.card.name)}</strong><div>${esc(i.campaign.title)}</div><div class="rule-line">${esc(rewardRuleSummary(i.campaign))}</div>${i.campaign.termsSummary ? `<div class="muted">${esc(i.campaign.termsSummary)}</div>` : ''}${i.campaign.sourceUrl ? `<a class="source-link" href="${esc(i.campaign.sourceUrl)}" target="_blank" rel="noopener">Resmi koşulları aç ↗</a>` : ''}</div></article>`).join('')}</div>` : '';

    const inputNoticeHtml = inputNotices.length
      ? `<div class="input-notice"><strong>Girdi kontrolü:</strong> ${inputNotices.map(esc).join(' ')}</div>`
      : '';
    $('#recommendResults').innerHTML = inputNoticeHtml + activeHtml + potentialHtml + infoHtml;
  });
}

function wireNav() {
  $$('.nav-btn').forEach(btn => btn.addEventListener('click', () => {
    $$('.nav-btn').forEach(x => x.classList.remove('active'));
    btn.classList.add('active');
    $$('.view').forEach(v => v.classList.remove('active'));
    $(`#${btn.dataset.view}`).classList.add('active');
  }));
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
    if (Number.isFinite(n) && n >= 0) { data.settings.staleAfterDays = n; save(); renderAll(); }
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
  bindProfileSelect('#maximilesBand', MAXIMILES_BANDS, 'maximilesBand', '4m_8m', 'İş Bankası');
  bindProfileSelect('#crystalBand', CRYSTAL_BANDS, 'crystalBand', 'under_1m', 'Yapı Kredi');
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

function renderAll() {
  syncCardSegmentsFromSettings();
  syncResets();
  renderDashboard();
  renderCampaigns();
  $('#staleDays').value = data.settings.staleAfterDays;
  if ($('#thyStatus')) $('#thyStatus').value = data.settings.thyStatus || 'classic';
  if ($('#qnbSegment')) $('#qnbSegment').value = data.settings.qnbSegment || 'private';
  if ($('#wingsTier')) $('#wingsTier').value = data.settings.wingsTier || 'black_plus';
  if ($('#maximilesBand')) $('#maximilesBand').value = data.settings.maximilesBand || '4m_8m';
  if ($('#crystalBand')) $('#crystalBand').value = data.settings.crystalBand || 'under_1m';
  if ($('#crystalCardType')) $('#crystalCardType').value = data.settings.crystalCardType || 'crystal';
  if ($('#tebTier')) $('#tebTier').value = data.settings.tebTier || 'ultra';
}


function reconcileCampaignStates(nextCampaigns) {
  const nextStates = {};
  for (const rawCampaign of nextCampaigns) {
    const c = effectiveCampaign(rawCampaign);
    nextStates[c.id] = ensureReset(c, data.states[c.id], new Date());
  }
  data.states = nextStates;
}

async function loadRuntimeVersion() {
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
  if (mode === 'local' || mode === 'auto') {
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
      data.campaigns = mergeCatalogWithCore(payload.campaigns);
      reconcileCampaignStates(data.campaigns);
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
  data.settings = {...seed().settings, ...(row.settings || {})};
  data.states = {...(data.states || {}), ...(row.campaign_states || {})};
  const privateItems = Array.isArray(row.private_campaigns) ? row.private_campaigns : [];
  data.campaigns = [...(data.campaigns || []).filter(c => c.sourceKind !== 'user_private'), ...privateItems];
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
  signOutBtn?.addEventListener('click',async()=>{signOut(); await refreshCloudUi('Bulut oturumu kapatıldı.');});
  upload?.addEventListener('click',async()=>{try{upload.disabled=true; const out=await saveCloudUserState(personalCloudPayload()); await refreshCloudUi(`Bu cihazın kişisel ayarları buluta gönderildi · ${formatRefreshTime(out.updated_at)}`);}catch(e){await refreshCloudUi(`Buluta gönderilemedi: ${e.message}`);}});
  download?.addEventListener('click',async()=>{try{download.disabled=true; const row=await fetchCloudUserState(); if(!row){await refreshCloudUi('Bulutta kayıtlı kişisel veri bulunamadı.');return;} if(!confirm('Buluttaki profil/limit/katılım verisini bu cihaza uygulamak istiyor musun?')){await refreshCloudUi('Buluttan alma iptal edildi.');return;} applyCloudPayload(row); await refreshCloudUi(`Bulut verisi bu cihaza alındı · ${formatRefreshTime(row.updated_at)}`);}catch(e){await refreshCloudUi(`Buluttan alınamadı: ${e.message}`);}});
  refreshCloudUi();
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

syncResets();
wireNav();
wireCampaignBrowser();
renderRecommendation();
wireDataTools();
wireRefreshTools();
wirePrivateCampaign();
wireCloudTools();
wirePwaInstall();
renderAll();
loadRuntimeVersion().then(() => renderDashboard());
loadLiveCatalog();

// Ayrı .bat ile başlatılan canlı taramayı da izle. Tarama sırasında karar motoru
// son başarılı tam kataloğu kullanmaya devam eder; yeni katalog yalnız tarama bitince alınır.
let lastObservedRefreshState = null;
let lastObservedCampaignCount = 0;
setInterval(async () => {
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

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
