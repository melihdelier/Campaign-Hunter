export const initialCards = [
  { id: 'uc-qnb', bank: 'QNB', name: 'Miles&Smiles QNB Private', segment: 'Private', cardProductId: 'qnb-ms-private', active: true },
  { id: 'uc-akbank-elite', bank: 'Akbank', name: 'Wings Elite', segment: 'Black Plus / 2 milyon TL+', cardProductId: 'akbank-wings-elite', active: true },
  { id: 'uc-akbank-black', bank: 'Akbank', name: 'Wings Black', segment: 'Black Plus / 2 milyon TL+', cardProductId: 'akbank-wings-black', active: true },
  { id: 'uc-is', bank: 'İş Bankası', name: 'Maximiles Black', segment: '4–8 milyon TL', cardProductId: 'is-maximiles-black', active: true },
  { id: 'uc-ykb', bank: 'Yapı Kredi', name: 'Crystal', segment: '1 milyon TL altı', cardProductId: 'ykb-crystal', active: true },
  { id: 'uc-teb', bank: 'TEB', name: 'TEB Özel Infinite', segment: 'Ultra', cardProductId: 'teb-infinite', active: true }
];

// Ağ bağlantısı kurulana kadar kullanılan doğrulanmış başlangıç kayıtları. Canlı servis açıldığında resmi katalog bunların yerini alır.
export const initialCampaigns = [
  {
    id: 'official-is-eticaret-2026-09', bank: 'İş Bankası', title: 'E-Ticaret — 1.000 TL’ye Varan MaxiPuan', demo: false,
    cardProductIds: ['is-maximiles-black'], categories: ['e-ticaret'],
    merchantScope: {
      kind: 'contains',
      category: 'e-ticaret',
      values: ['Amazon', 'Amazon.com.tr', 'Hepsiburada', 'İncehesap', 'n11', 'Pazarama', 'Trendyol']
    },
    startDate: '2026-09-01', endDate: '2026-09-30', status: 'active', resetPolicy: 'campaign', periodCap: 1000,
    requiresEnrollment: true,
    rewardRule: { kind: 'fixed', minSpend: 3000, reward: 250 }, rewardUnit: 'maxipuan',
    transactionRules: {
      location: 'domestic',
      allowedChannels: ['online'],
      rewardStartsFromQualifyingTransaction: 2,
      differentDaysRequired: true,
      sameDaySameMerchantFirstOnly: true,
      customerLevel: true,
      excludedCategories: ['market', 'yatırımlık altın/gümüş', 'kontör', 'simkart/hat', 'seyahat', 'Amazon Hediye Kartı', 'MaxiPuan/MaxiMil ile ödeme', 'dijital cüzdan', 'iade/iptal'],
      requiredPos: 'Maximum özellikli POS / kampanya tarafından tanınan online işlem'
    },
    rulesComplete: true,
    decisionWarnings: ['Kampanya ödülü ikinci ve sonraki uygun 3.000 TL+ alışverişlerde oluşur; önceki uygun işlem adedi kullanıcı tarafından doğrulanmalıdır.'],
    sourceKind: 'official_web',
    sourceUrl: 'https://www.maximiles.com.tr/kampanyalar/e-ticaret-alisverislerinizde-1-000-tl-ye-varan-maxipuan',
    verifiedAt: '2026-09-23T21:00:00+03:00',
    termsSummary: 'Amazon.com.tr, Hepsiburada, İncehesap.com, n11, Pazarama ve Trendyol’da farklı günlerde yapılan ikinci ve sonraki 3.000 TL+ alışverişlerin her birine 250 TL; toplam en fazla 1.000 TL MaxiPuan. Katılım gerekli.'
  },
  {
    id: 'official-wings-program-restoran-2026', coreBenefit: true, bank: 'Akbank', title: 'Wings Programı — Tüm Restoranlarda %15’e Varan İndirim', demo: false,
    cardProductIds: ['akbank-wings-elite','akbank-wings-black'], eligibility: { segmentLabels: ['Classic / 1 milyon TL altı','Black / 1–2 milyon TL','Black Plus / 2 milyon TL+'] },
    segmentRules: {
      'Classic / 1 milyon TL altı': { rewardRule:{kind:'percent',rate:0.05,minSpend:1000}, periodCap:250, rulesComplete:true },
      'Black / 1–2 milyon TL': { rewardRule:{kind:'percent',rate:0.10,minSpend:1000}, periodCap:1250, rulesComplete:true },
      'Black Plus / 2 milyon TL+': { rewardRule:{kind:'percent',rate:0.15,minSpend:1000}, periodCap:2500, rulesComplete:true }
    },
    categories: ['restoran'], merchantScope: { kind: 'all' },
    startDate: '2026-01-01', endDate: '2026-12-31', status: 'active', resetPolicy: 'monthly', periodCap: 2500,
    requiresEnrollment: true,
    enrollmentMethod: 'Akbank Mobil → Kampanyalar → Wings Programları / Program Ayrıcalıkları',
    rewardRule: { kind: 'percent', rate: 0.15, minSpend: 1000 },
    transactionRules: { location: 'all' },
    rulesComplete: true,
    sourceKind: 'core_benefit',
    sourceUrl: 'https://www.wingscard.com.tr/ayricaliklar/tum-restoranlarda-15e-varan-indirim',
    verifiedAt: '2026-09-24T11:31:00+03:00',
    termsSummary: 'Wings programına katılım gerekir. Classic: 1.000 TL+ restoran harcamasına %5, aylık 250 TL; Black: %10, aylık 1.250 TL; Black Plus: %15, aylık 2.500 TL.'
  },
  {
    id: 'official-is-restoran-2026q3', coreBenefit: true, bank: 'İş Bankası', title: 'Maximiles Black — Restoranlarda %20’ye Varan İndirim', demo: false,
    cardProductIds: ['is-maximiles-black'], eligibility: { segmentLabels: ['1 milyon TL altı','1–4 milyon TL','4–8 milyon TL','8 milyon TL+'] },
    segmentRules: {
      '1 milyon TL altı': { rewardRule: { kind:'percent', rate:0.05, minSpend:4000, perTransactionCap:1000 }, periodCap:2000, rulesComplete:true },
      '1–4 milyon TL': { rewardRule: { kind:'tiered_percent', tiers:[{min:4000,max:7999.99,rate:0.10},{min:8000,rate:0.20}], perTransactionCap:1750 }, periodCap:4000, rulesComplete:true },
      '4–8 milyon TL': { rewardRule: { kind:'tiered_percent', tiers:[{min:4000,max:7999.99,rate:0.10},{min:8000,rate:0.20}], perTransactionCap:3000 }, periodCap:8000, rulesComplete:true },
      '8 milyon TL+': { rewardRule: { kind:'tiered_percent', tiers:[{min:4000,max:7999.99,rate:0.10},{min:8000,rate:0.20}], perTransactionCap:3000 }, periodCap:10000, rulesComplete:true }
    },
    categories: ['restoran'], merchantScope: { kind: 'all' },
    startDate: '2026-07-01', endDate: '2026-09-30', status: 'active', resetPolicy: 'monthly', periodCap: 8000,
    requiresEnrollment: false,
    rewardRule: {
      kind: 'tiered_percent',
      tiers: [
        { min: 4000, max: 7999.99, rate: 0.10 },
        { min: 8000, rate: 0.20 }
      ],
      perTransactionCap: 3000
    },
    transactionRules: {
      location: 'all',
      excludedCategories: ['toptan gıda', 'catering', 'fırın/pastane', 'MaxiMil/MaxiPuan ile ödeme', 'iade/iptal'],
      nonStackable: true
    },
    rulesComplete: true,
    sourceKind: 'core_benefit',
    sourceUrl: 'https://www.maximiles.com.tr/kampanyalar/maximiles-black-ile-restoranlarda-20-indirim-ayricaligi',
    verifiedAt: '2026-09-23T20:30:00+03:00',
    termsSummary: '4–7.999,99 TL %10; 8.000 TL+ %20. 4–8 milyon TL segmentinde işlem başına en fazla 3.000 TL, aylık en fazla 8.000 TL.'
  },
  {
    id: 'official-teb-infinite-restoran-ultra', coreBenefit: true, bank: 'TEB', title: 'TEB Infinite — Otel/Restoran İndirimi', demo: false,
    cardProductIds: ['teb-infinite'], eligibility: { segmentLabels: ['Standart','Plus','Premium','Ultra'] },
    segmentRules: {
      'Standart': { rewardRule:{kind:'percent',rate:0.05,minSpend:1500,perTransactionCap:75}, periodCap:250, rulesComplete:true },
      'Plus': { rewardRule:{kind:'percent',rate:0.10,minSpend:1500,perTransactionCap:500}, periodCap:2500, rulesComplete:true },
      'Premium': { rewardRule:{kind:'percent',rate:0.15,minSpend:1500,perTransactionCap:1000}, periodCap:4000, rulesComplete:true },
      'Ultra': { rewardRule:{kind:'percent',rate:0.20,minSpend:1500,perTransactionCap:2000}, periodCap:8000, rulesComplete:true }
    },
    categories: ['restoran', 'otel'], merchantScope: { kind: 'all' },
    startDate: '2026-01-01', endDate: null, status: 'active', resetPolicy: 'monthly', periodCap: 8000,
    requiresEnrollment: false,
    rewardRule: { kind: 'percent', rate: 0.20, minSpend: 1500, perTransactionCap: 2000 },
    transactionRules: {
      location: 'domestic',
      sameDaySameMerchantFirstOnly: true,
      excludedCategories: ['fast food', 'seyahat acentesi üzerinden otel ödemesi', 'iade/iptal']
    },
    rulesComplete: true,
    sourceKind: 'core_benefit',
    sourceUrl: 'https://www.teb.com.tr/kart-dunyasi-otel-restoran-indirimi/',
    verifiedAt: '2026-09-23T20:30:00+03:00',
    termsSummary: 'Ultra paket TEB Infinite: yurt içinde tek seferde 1.500 TL+ otel/restoran %20; işlem başına en fazla 2.000 TL, aylık en fazla 8.000 TL.'
  },
  {
    id: 'official-ykb-crystal-restoran-2026-09', coreBenefit: true, bank: 'Yapı Kredi', title: 'Crystal — Anlaşmalı Otel/Restoran %20', demo: false,
    cardProductIds: ['ykb-crystal'], eligibility: { segmentLabels: ['1 milyon TL altı','1–6 milyon TL','6–10 milyon TL','10 milyon TL+','Metal Crystal'] },
    segmentRules: {
      '1 milyon TL altı': { rewardRule:{kind:'percent',rate:0.20,minSpend:0,perTransactionCap:1500}, periodCap:3000, rulesComplete:true },
      '1–6 milyon TL': { rewardRule:{kind:'percent',rate:0.20,minSpend:0,perTransactionCap:2500}, periodCap:5000, rulesComplete:true },
      '6–10 milyon TL': { rewardRule:{kind:'percent',rate:0.20,minSpend:0,perTransactionCap:3000}, periodCap:7500, rulesComplete:true },
      '10 milyon TL+': { rewardRule:{kind:'percent',rate:0.20,minSpend:0,perTransactionCap:4000}, periodCap:10000, rulesComplete:true },
      'Metal Crystal': { rewardRule:{kind:'percent',rate:0.20,minSpend:0,perTransactionCap:6000}, periodCap:15000, rulesComplete:true }
    },
    categories: ['restoran', 'otel'],
    merchantScope: {
      kind: 'contains',
      category: 'restoran',
      values: ['Günaydın', 'Gunaydin', 'Da Mario', 'Da Mario Etiler', 'Da Mario İstinye Park'],
      excludedValues: ['Günaydın Köfte & Döner', 'Günaydın Kebap Mersin Marina', 'Günaydın Kebap Antalya'],
      requiresBranchConfirmation: true
    },
    startDate: '2026-01-01', endDate: '2026-09-30', status: 'active', resetPolicy: 'monthly', periodCap: 3000,
    requiresEnrollment: false,
    rewardRule: { kind: 'percent', rate: 0.20, minSpend: 0, perTransactionCap: 1500 },
    transactionRules: {
      location: 'domestic',
      requiredPos: 'Yapı Kredi POS',
      allowedChannels: ['physical'],
      sameDaySameMerchantFirstOnly: true,
      nonStackable: true,
      excludedCategories: ['internet ödemesi', 'puan harcaması', 'nakit çekim']
    },
    rulesComplete: true,
    decisionWarnings: ['Anlaşmalı restoranlarda şube/POS kapsamı değişebilir; şube adı bilinmiyorsa sonucu koşullu kabul et.'],
    sourceKind: 'core_benefit',
    sourceUrl: 'https://www.yapikredi.com.tr/bireysel-bankacilik/kartlar/otel-restoran-indirimleri',
    verifiedAt: '2026-09-23T20:30:00+03:00',
    termsSummary: 'Crystal %20. 1 milyon TL altı segmentte işlem başına en fazla 1.500 TL, aylık en fazla 3.000 TL. Sadece anlaşmalı mekan/Yapı Kredi POS; bazı Günaydın şubeleri hariç.'
  }
];;

export const initialStates = {
  'official-wings-program-restoran-2026': { campaignId: 'official-wings-program-restoran-2026', periodKey: '2026-09', enrollmentStatus: 'unknown', remainingLimit: null, usedAmount: null, valueSource: 'unknown', confirmedAt: null, updatedAt: '2026-09-24T11:31:00+03:00' },
  'official-is-eticaret-2026-09': { campaignId: 'official-is-eticaret-2026-09', periodKey: 'official-is-eticaret-2026-09:2026-09-01:2026-09-30', enrollmentStatus: 'unknown', remainingLimit: 1000, usedAmount: 0, qualifyingTransactions: null, valueSource: 'reset', confirmedAt: '2026-09-01T00:01:00+03:00', updatedAt: '2026-09-01T00:01:00+03:00' },
  'official-is-restoran-2026q3': { campaignId: 'official-is-restoran-2026q3', periodKey: '2026-09', enrollmentStatus: 'not_required', remainingLimit: 8000, usedAmount: 0, valueSource: 'reset', confirmedAt: '2026-09-01T00:01:00+03:00', updatedAt: '2026-09-01T00:01:00+03:00' },
  'official-teb-infinite-restoran-ultra': { campaignId: 'official-teb-infinite-restoran-ultra', periodKey: '2026-09', enrollmentStatus: 'not_required', remainingLimit: 8000, usedAmount: 0, valueSource: 'reset', confirmedAt: '2026-09-01T00:01:00+03:00', updatedAt: '2026-09-01T00:01:00+03:00' },
  'official-ykb-crystal-restoran-2026-09': { campaignId: 'official-ykb-crystal-restoran-2026-09', periodKey: '2026-09', enrollmentStatus: 'not_required', remainingLimit: 3000, usedAmount: 0, valueSource: 'reset', confirmedAt: '2026-09-01T00:01:00+03:00', updatedAt: '2026-09-01T00:01:00+03:00' },
};
