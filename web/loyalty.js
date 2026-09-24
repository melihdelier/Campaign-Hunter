function norm(v) {
  return String(v ?? '').trim().toLocaleLowerCase('tr-TR')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i');
}

function round2(v) { return Math.round((Number(v) + Number.EPSILON) * 100) / 100; }

export function formatNumber(value, max = 2) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'Bilinmiyor';
  return new Intl.NumberFormat('tr-TR', { maximumFractionDigits: max }).format(Number(value));
}

export const THY_STATUSES = [
  { value: 'classic', label: 'Classic', multiplier: 1 },
  { value: 'classic_plus', label: 'Classic Plus', multiplier: 1.25 },
  { value: 'elite', label: 'Elite', multiplier: 1.5 },
  { value: 'elite_plus', label: 'Elite Plus', multiplier: 1.5 },
];

export const QNB_SEGMENTS = [
  { value: 'other', label: 'Diğer / QNB First altı', cardLabel: 'Diğer', statementMilesCap: 10000 },
  { value: 'first', label: 'QNB First', cardLabel: 'QNB First', statementMilesCap: 25000 },
  { value: 'first_plus', label: 'QNB First Plus', cardLabel: 'QNB First Plus', statementMilesCap: 25000 },
  { value: 'private', label: 'QNB Private', cardLabel: 'Private', statementMilesCap: 40000 },
];

export const CRYSTAL_BANDS = [
  { value: 'under_1m', label: '1 milyon TL altı', cardLabel: '1 milyon TL altı' },
  { value: '1m_6m', label: '1–6 milyon TL', cardLabel: '1–6 milyon TL' },
  { value: '6m_10m', label: '6–10 milyon TL', cardLabel: '6–10 milyon TL' },
  { value: '10m_plus', label: '10 milyon TL+', cardLabel: '10 milyon TL+' },
];

export const CRYSTAL_CARD_TYPES = [
  { value: 'crystal', label: 'Crystal' },
  { value: 'metal_crystal', label: 'Metal Crystal' },
];

export const TEB_TIERS = [
  { value: 'standard', label: "Standart / 1 milyon TL'ye kadar", cardLabel: 'Standart' },
  { value: 'plus', label: 'Plus / 1–5 milyon TL', cardLabel: 'Plus' },
  { value: 'premium', label: 'Premium / 5–10 milyon TL', cardLabel: 'Premium' },
  { value: 'ultra', label: 'Ultra / 10 milyon TL+', cardLabel: 'Ultra' },
];

export const WINGS_TIERS = [
  { value: 'standard', label: 'Standart / 1 milyon TL altı' },
  { value: 'black', label: 'Black / 1–2 milyon TL' },
  { value: 'black_plus', label: 'Black Plus / 2 milyon TL+' },
];

export const MAXIMILES_BANDS = [
  { value: 'under_1m', label: '1 milyon TL altı', rate: 0.005, txCap: 250 },
  { value: '1m_4m', label: '1–4 milyon TL', rate: 0.0125, txCap: 625 },
  { value: '4m_8m', label: '4–8 milyon TL', rate: 0.015, txCap: 750 },
  { value: '8m_plus', label: '8 milyon TL+', rate: 0.0175, txCap: 875 },
];

function isThyMerchant(merchant) {
  const m = norm(merchant).replace(/[^a-z0-9]/g, '');
  return ['thy', 'turkhavayollari', 'turkishairlines', 'turkishairlinescom'].some(x => m.includes(x));
}

function wingsRatePer100(tier, category, locationScope) {
  const intl = locationScope === 'international';
  const boosted = ['restoran', 'seyahat'].includes(norm(category));
  const reduced = ['saglik', 'insaat', 'konut', 'kuyum', 'lastik', 'sigorta', 'telekom', 'vergi', 'belediye', 'harc'].includes(norm(category));

  if (reduced) return intl ? 6 : 5;
  if (tier === 'black_plus') {
    if (boosted) return intl ? 225 : 150;
    return intl ? 100 : 66;
  }
  if (tier === 'black') {
    if (boosted) return intl ? 150 : 100;
    return intl ? 75 : 50;
  }
  return intl ? 30 : 20;
}

function wingsEarning({ amount, category, locationScope, tier }) {
  const rate = wingsRatePer100(tier, category, locationScope);
  const cap = locationScope === 'international' ? 15000 : 10000;
  const raw = Number(amount) * rate / 100;
  const points = Math.min(raw, cap);
  return {
    known: true,
    unit: 'wings_mil_puan',
    amount: round2(points),
    title: 'Standart Wings Mil Puan',
    detail: `${formatNumber(rate)} Mil Puan / 100 TL${raw > cap ? ` · işlem tavanı ${formatNumber(cap, 0)} Mil Puan` : ''}`,
    values: {
      domesticFlightTry: round2(points / 100),
      internationalFlightTry: round2(points / 50),
      hotelTourCarTry: round2(points / 150),
    },
    sourceStatus: 'official_verified',
  };
}

function maximilesEarning({ amount, band, category }) {
  const rec = MAXIMILES_BANDS.find(x => x.value === band) || MAXIMILES_BANDS.find(x => x.value === '4m_8m');
  const cat = norm(category);
  const highRateCategories = new Set(['market','akaryakit','giyim','seyahat','otel','restoran','elektronik','mobilya','egitim','e-ticaret']);
  const high = highRateCategories.has(cat);
  const rate = high ? rec.rate : 0.002;
  const cap = high ? rec.txCap : 40;
  const raw = Number(amount) * rate;
  const miles = Math.min(raw, cap);
  return {
    known: true,
    unit: 'maximil',
    amount: round2(miles),
    title: 'Standart MaxiMil',
    detail: `%${formatNumber(rate * 100)} MaxiMil kazanım oranı${raw > cap ? ` · işlem tavanı ${formatNumber(cap)} MaxiMil` : ''}`,
    note: cat === 'akaryakit' ? 'Akaryakıt ve bazı düşük-oran sektörlerinde ekstre dönemi işlem adedi/tutarı koşulları bulunabilir; önceki işlemler bu hesapta bilinmez.' : null,
    values: { travelTry: round2(miles) },
    sourceStatus: 'official_verified',
  };
}

function qnbEarning({ amount, merchant, category, thyStatus, qnbSegment }) {
  const segment = QNB_SEGMENTS.find(x => x.value === qnbSegment) || QNB_SEGMENTS.find(x => x.value === 'private');
  if (isThyMerchant(merchant) && ['seyahat', 'all'].includes(norm(category))) {
    const miles = Math.floor(Number(amount) / 6);
    return {
      known: true,
      unit: 'thy_miles',
      amount: miles,
      title: 'Miles&Smiles Mil',
      detail: 'THY resmi kanallarında 6 TL = 1 Mil · statüden ve QNB segmentinden bağımsız özel oran',
      note: `${segment.label} için ekstre dönemi toplam Mil tavanı ${formatNumber(segment.statementMilesCap, 0)} Mil; bu hesap önceki dönem kazanımlarını bilmez.`,
      sourceStatus: 'official_verified',
    };
  }
  const status = THY_STATUSES.find(x => x.value === thyStatus) || THY_STATUSES[0];
  if (norm(category) === 'restoran' && segment.value === 'private') {
    const base = Number(amount) * 36 / 1000;
    const miles = Math.floor(base * status.multiplier);
    return {
      known: true,
      unit: 'thy_miles',
      amount: miles,
      title: 'Miles&Smiles Mil',
      detail: `QNB Private yurt içi restoran: Classic için 1.000 TL = 36 Mil · THY ${status.label} çarpanı x${formatNumber(status.multiplier)}`,
      note: `${segment.label} için ekstre dönemi toplam Mil tavanı ${formatNumber(segment.statementMilesCap, 0)} Mil; bu hesap önceki dönem kazanımlarını bilmez.`,
      sourceStatus: 'official_verified',
    };
  }
  return {
    known: false,
    unit: 'thy_miles',
    amount: null,
    title: 'Miles&Smiles Mil',
    detail: `QNB genel alışveriş Mil oranı sektör + ${segment.label} segmenti + kart tipi + THY ${status.label} statüsüne göre resmi Mil Hesaplama Aracı'nda değişiyor.`,
    note: `${status.multiplier > 1 ? `${status.label} statüsünde standart alışveriş Millerine x${formatNumber(status.multiplier)} çarpan uygulanır. ` : 'THY statüsü: Classic. '}${segment.label} ekstre dönemi Mil tavanı ${formatNumber(segment.statementMilesCap, 0)} Mil.`,
    sourceStatus: 'calculator_adapter_pending',
  };
}

function tebEarning() {
  return {
    known: false,
    unit: 'bonus',
    amount: null,
    title: 'Standart Bonus',
    detail: '1 Bonus = 1 TL; standart kazanım oranı işlem/işyerine göre değişebildiği için sabit oran varsayılmıyor.',
    sourceStatus: 'variable_rate',
  };
}

function crystalEarning() {
  return {
    known: false,
    unit: 'worldpuan',
    amount: null,
    title: 'Standart Worldpuan',
    detail: '200 Worldpuan = 1 TL; standart kazanım oranı üye işyeri/işleme göre değişebildiği için sabit oran varsayılmıyor.',
    sourceStatus: 'variable_rate',
  };
}

export function calculateLoyalty({ card, amount, merchant, category, locationScope = 'domestic', settings = {} }) {
  const product = card.cardProductId;
  if (product === 'qnb-ms-private') return qnbEarning({ amount, merchant, category, thyStatus: settings.thyStatus || 'classic', qnbSegment: settings.qnbSegment || 'private' });
  if (product === 'akbank-wings-elite' || product === 'akbank-wings-black') return wingsEarning({ amount, category, locationScope, tier: settings.wingsTier || 'black_plus' });
  if (product === 'is-maximiles-black') return maximilesEarning({ amount, category, band: settings.maximilesBand || '4m_8m' });
  if (product === 'teb-infinite') return tebEarning();
  if (product === 'ykb-crystal') return crystalEarning();
  return { known: false, unit: 'unknown', amount: null, title: 'Standart kazanım', detail: 'Kazanım kuralı tanımlı değil.', sourceStatus: 'unknown' };
}

export function loyaltyToHtmlText(earning) {
  if (!earning) return '';
  if (!earning.known) return `${earning.title}: hesaplanamadı`;
  if (earning.unit === 'thy_miles') return `${earning.title}: ${formatNumber(earning.amount, 0)} Mil`;
  if (earning.unit === 'wings_mil_puan') return `${earning.title}: ${formatNumber(earning.amount)} Mil Puan`;
  if (earning.unit === 'maximil') return `${earning.title}: ${formatNumber(earning.amount)} MaxiMil`;
  if (earning.unit === 'bonus') return `${earning.title}: ${formatNumber(earning.amount)} Bonus`;
  if (earning.unit === 'worldpuan') return `${earning.title}: ${formatNumber(earning.amount)} Worldpuan`;
  return `${earning.title}: ${formatNumber(earning.amount)}`;
}

export function campaignRewardLabel(campaign, amount) {
  const unit = campaign.rewardUnit || 'discount_try';
  const n = Number(amount || 0);
  if (unit === 'maxipuan') return `${formatNumber(n)} MaxiPuan (${formatNumber(n)} TL)`;
  if (unit === 'chip_para') return `${formatNumber(n)} chip-para (${formatNumber(n)} TL)`;
  if (unit === 'parapuan') return `${formatNumber(n)} TL değerinde ParaPuan`;
  if (unit === 'bonus') return `${formatNumber(n)} Bonus (${formatNumber(n)} TL)`;
  if (unit === 'worldpuan') return `${formatNumber(n * 200, 0)} Worldpuan (${formatNumber(n)} TL)`;
  if (unit === 'thy_miles') return `${formatNumber(n, 0)} Mil`;
  if (unit === 'wings_mil_puan') return `${formatNumber(n)} Mil Puan`;
  return new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY', maximumFractionDigits: 2 }).format(n);
}
