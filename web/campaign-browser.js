import { trDay, toTrDay } from './tr-time.js';
import { evaluateCampaignForCard, buildEligibilityContext, eligibilityUnresolved } from './eligibility.js';
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

// Türkiye takvim günü (Europe/Istanbul) ile karşılaştırılır; cihaz saat diliminden bağımsız.
export function campaignActiveNow(campaign, now = new Date()) {
  if (!campaign || campaign.status === 'inactive') return false;
  const day = trDay(now);
  const start = toTrDay(campaign.startDate);
  const end = toTrDay(campaign.endDate);
  if (start && day < start) return false;
  if (end && day > end) return false;
  return true;
}

// v1.4.1: Hangi Kart? ile AYNI değerlendirici (eligibility.js). Ayrı filtre mantığı yoktur.
// (Eski sürümde cardProductIds boş kampanya burada tüm kartlara "uygun" görünüyor, motorda ise reddediliyordu;
//  artık iki ekran da reddeder.)
export function campaignAppliesToCard(campaign, card, eligibilityContext = null) {
  if (!campaign || !card?.active) return false;
  return evaluateCampaignForCard(campaign, card, eligibilityContext || buildEligibilityContext({ cards: [card] })).eligible;
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
  if (scope.kind === 'restricted_unknown' && scope.scopeType === 'network') {
    return {
      kind:'restricted_unknown', title:'İşyeri kapsamı',
      text:`Yalnız ${scope.networkLabel || 'üye/anlaşmalı işyerleri'} içinde geçerli.`,
      values:[], excluded,
      warning:'Bu avantaj ilgili üye işyerinde geçerlidir; işyerinin kampanyaya dahil olduğunu doğrula.'
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

// v1.5.0: Kampanyalar varsayılan görünümü YALNIZ kesin uygulanabilir kampanyaları gösterir.
//   campaigns      kartında kesin uygun + koşulları çözülmüş (rulesComplete !== false) + ödül kademesi belirli
//   informational  kartında uygun ama bilgi amaçlı (koşullar tam çözülemedi / kademe segmente bağlı / dönemi bitmiş ayrıcalık)
// Uygunluğu belirsiz kampanyalar ve bankanın diğer kartlarına ait olanlar catalogSecondary() ile ayrı bölümdedir.
export function isDefinitelyApplicable(c) {
  return !c.expiredCore && c.rulesComplete !== false && !c.rewardVariantUnresolved;
}

export function groupCampaignsByCard({campaigns, cards, category='all', resolveCampaign=(c)=>c, now=new Date(), eligibilityContext=null}) {
  const ctx = eligibilityContext || buildEligibilityContext({ cards: (cards || []).filter(c => c.active) });
  return (cards || []).filter(c => c.active).map(card => {
    const items = [];
    const seen = new Set();
    for (const raw of campaigns || []) {
      // Ödül kademesi (rewardVariants/segmentRules) Hangi Kart? ile AYNI bağlamla çözülür.
      let c = resolveCampaign(raw, card, now, ctx) || raw;
      if (!campaignActiveNow(c, now)) {
        // Dönemi bitmiş sürekli kart ayrıcalığı listeden sessizce düşmez; "dönem bitti" işaretiyle kalır.
        const ended = c.coreBenefit && toTrDay(c.endDate) && trDay(now) > toTrDay(c.endDate) && c.status !== 'inactive';
        if (!ended) continue;
        c = { ...c, expiredCore: true };
      }
      if (!campaignMatchesCategory(c, category)) continue;
      if (!campaignAppliesToCard(c, card, ctx)) continue;
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
    return {card, campaigns: items.filter(isDefinitelyApplicable), informational: items.filter(c => !isDefinitelyApplicable(c))};
  });
}

// Global katalogdaki, kullanıcının bankalarına ait ama hiçbir sahip olunan karta kesin uygulanmayan kampanyalar.
//   unresolved  kart uygunluğu resmi metinde bulunamadı / çelişkili (eligibilityResolution unresolved | needs_review)
//   otherCards  uygunluk belli; yalnız uygulamada tanımlı olmayan veya sahip olunmayan kartlar için (ör. MercedesCard)
export function catalogSecondary({campaigns, cards, category='all', now=new Date(), eligibilityContext=null, bankCodes=null}) {
  const active = (cards || []).filter(c => c.active);
  const ctx = eligibilityContext || buildEligibilityContext({ cards: active });
  const banks = new Set(bankCodes || [...(ctx.banks || [])]);
  const unresolved = [], otherCards = [];
  for (const c of campaigns || []) {
    if (c.sourceKind === 'user_private') continue;
    const bank = c.bankCode || c.eligibilityResolution?.bankCode || null;
    if (!bank || !banks.has(bank)) continue;
    if (!campaignActiveNow(c, now) || !campaignMatchesCategory(c, category)) continue;
    if (eligibilityUnresolved(c)) { unresolved.push(c); continue; }
    if (!active.some(card => campaignAppliesToCard(c, card, ctx))) otherCards.push(c);
  }
  const byTitle = (a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'tr');
  return { unresolved: unresolved.sort(byTitle), otherCards: otherCards.sort(byTitle) };
}
