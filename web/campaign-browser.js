export const CAMPAIGN_BROWSER_CATEGORIES = [
  ['all','Tüm kategoriler'],
  ['akaryakit','Akaryakıt / Otogaz'],
  ['sarj','Elektrikli Araç Şarj'],
  ['restoran','Restoran'],
  ['market','Market'],
  ['giyim','Giyim / Kozmetik'],
  ['e-ticaret','E-ticaret'],
  ['seyahat','Seyahat / Uçak'],
  ['otel','Otel'],
  ['egitim','Eğitim / Kırtasiye'],
  ['saglik','Sağlık'],
  ['sigorta','Sigorta / BES'],
  ['otomotiv','Otomotiv / Servis'],
  ['elektronik','Elektronik / Beyaz eşya'],
  ['ev','Mobilya / Yapı market'],
  ['eglence','Sinema / Etkinlik'],
  ['ulasim','Ulaşım'],
  ['otopark','Otopark'],
  ['dijital','Dijital platform'],
  ['diger','Diğer / sınıflandırılmamış'],
];

function fold(v='') {
  return String(v).toLocaleLowerCase('tr-TR')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g,'')
    .replace(/ı/g,'i').replace(/ş/g,'s').replace(/ğ/g,'g').replace(/ü/g,'u').replace(/ö/g,'o').replace(/ç/g,'c')
    .replace(/[^a-z0-9]+/g,' ').trim();
}

export function campaignCategories(campaign) {
  const cats = Array.isArray(campaign?.categories) && campaign.categories.length
    ? campaign.categories
    : [campaign?.category || 'all'];
  return [...new Set(cats.map(x => String(x || '').trim()).filter(Boolean))];
}

export function campaignMatchesCategory(campaign, category) {
  if (!category || category === 'all') return true;
  const wanted = fold(category);
  return campaignCategories(campaign).some(c => fold(c) === wanted);
}

export function campaignActiveNow(campaign, now = new Date()) {
  if (!campaign || campaign.status === 'inactive') return false;
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (campaign.startDate) {
    const start = new Date(`${campaign.startDate}T00:00:00`);
    if (!Number.isNaN(start.getTime()) && day < start) return false;
  }
  if (campaign.endDate) {
    const end = new Date(`${campaign.endDate}T23:59:59`);
    if (!Number.isNaN(end.getTime()) && day > end) return false;
  }
  return true;
}

export function campaignAppliesToCard(campaign, card) {
  if (!campaign || !card?.active) return false;
  const ids = campaign.cardProductIds || [];
  if (ids.length && !ids.includes(card.cardProductId)) return false;
  const labels = campaign.eligibility?.segmentLabels || [];
  if (labels.length) {
    const current = fold(card.segment);
    if (!labels.some(x => fold(x) === current)) return false;
  }
  return true;
}

export function merchantScopeInfo(campaign) {
  const scope = campaign?.merchantScope || {kind:'all'};
  const values = (scope.values || []).filter(Boolean);
  const excluded = (scope.excludedValues || []).filter(Boolean);
  if (scope.kind === 'all') {
    return { kind:'all', title:'İşyeri kapsamı', text:'Kategori koşulunu sağlayan tüm uygun işyerleri.', values:[], excluded, warning:null };
  }
  if (scope.kind === 'contains' || scope.kind === 'exact') {
    const noun = campaignCategories(campaign).includes('akaryakit') ? 'Geçerli istasyon / markalar' : 'Geçerli işyerleri';
    return {
      kind:scope.kind, title:noun,
      text: values.length ? values.join(', ') : 'Seçili/anlaşmalı işyerlerinde geçerli.',
      values, excluded,
      warning: scope.requiresBranchConfirmation ? 'Şube/POS kapsamı ayrıca doğrulanmalı.' : null
    };
  }
  if (scope.kind === 'restricted_unknown') {
    return {
      kind:'restricted_unknown', title:'İşyeri kapsamı',
      text:'Yalnız seçili/anlaşmalı işyerlerinde geçerli. İşyeri listesi katalogda tam ayrıştırılamadı.',
      values:[], excluded,
      warning:'Kesin işyeri/istasyon listesi için resmi koşulları aç.'
    };
  }
  return { kind:scope.kind || 'unknown', title:'İşyeri kapsamı', text:'İşyeri kapsamı otomatik olarak doğrulanamadı.', values, excluded, warning:'Resmi koşulları kontrol et.' };
}

export function paymentScopeInfo(campaign) {
  const tx = campaign?.transactionRules || {};
  const channels = (tx.allowedChannels || []).map(x => x === 'physical' ? 'Fiziki POS / mağaza' : x === 'online' ? 'İnternet / uygulama' : x);
  const location = tx.location === 'domestic' ? 'Yurt içi' : tx.location === 'international' ? 'Yurt dışı' : 'Yurt içi / yurt dışı';
  return { channels, location, requiredPos: tx.requiredPos || null };
}

export function groupCampaignsByCard({campaigns, cards, category='all', resolveCampaign=(c)=>c, now=new Date()}) {
  return (cards || []).filter(c => c.active).map(card => {
    const items = [];
    const seen = new Set();
    for (const raw of campaigns || []) {
      const c = resolveCampaign(raw, card) || raw;
      if (!campaignActiveNow(c, now)) continue;
      if (!campaignMatchesCategory(c, category)) continue;
      if (!campaignAppliesToCard(c, card)) continue;
      const key = c.id || `${c.bank}|${c.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(c);
    }
    items.sort((a,b) => {
      const core = Number(Boolean(b.coreBenefit)) - Number(Boolean(a.coreBenefit));
      if (core) return core;
      const complete = Number(Boolean(b.rulesComplete)) - Number(Boolean(a.rulesComplete));
      if (complete) return complete;
      return String(a.title || '').localeCompare(String(b.title || ''), 'tr');
    });
    return {card, campaigns:items};
  });
}
