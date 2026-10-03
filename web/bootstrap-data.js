export const initialCards = [
  { id: 'uc-qnb', bank: 'QNB', name: 'Miles&Smiles QNB Private', segment: 'Private', cardProductId: 'qnb-ms-private', active: true },
  { id: 'uc-akbank-elite', bank: 'Akbank', name: 'Wings Elite', segment: 'Black Plus / 2 milyon TL+', cardProductId: 'akbank-wings-elite', active: true },
  { id: 'uc-akbank-black', bank: 'Akbank', name: 'Wings Black', segment: 'Black Plus / 2 milyon TL+', cardProductId: 'akbank-wings-black', active: true },
  { id: 'uc-is', bank: 'İş Bankası', name: 'Maximiles Black', segment: 'band_3', cardProductId: 'is-maximiles-black', active: true },
  { id: 'uc-ykb', bank: 'Yapı Kredi', name: 'Crystal', segment: 'band_1', cardProductId: 'ykb-crystal', active: true },
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
    // Program seçimi/katılımı kalıcıdır; aylık limit sıfırlanır ama katılım her ay yeniden istenmez.
    enrollmentScope: 'program',
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
    // id dönemler arasında sabit tutulur; kullanıcı limit/katılım durumu bu anahtara bağlıdır.
    id: 'official-is-restoran-2026q3', coreBenefit: true, bank: 'İş Bankası', title: 'Maximiles Black — Restoranlarda %20’ye Varan İndirim', demo: false,
    cardProductIds: ['is-maximiles-black'], eligibility: { segmentLabels: ['band_1','band_2','band_3','band_4'] },
    // Doğrulanmış dönemler. Motor tarihe göre geçerli dönemi seçer (resolveValidityPeriod).
    validityPeriods: [
      {
        id: '2026q3', startDate: '2026-07-01', endDate: '2026-09-30', periodCap: 8000,
        segmentRules: {
      'band_1': { rewardRule: { kind:'percent', rate:0.05, minSpend:4000, perTransactionCap:1000 }, periodCap:2000, rulesComplete:true },
      'band_2': { rewardRule: { kind:'tiered_percent', tiers:[{min:4000,max:7999.99,rate:0.10},{min:8000,rate:0.20}], perTransactionCap:1750 }, periodCap:4000, rulesComplete:true },
      'band_3': { rewardRule: { kind:'tiered_percent', tiers:[{min:4000,max:7999.99,rate:0.10},{min:8000,rate:0.20}], perTransactionCap:3000 }, periodCap:8000, rulesComplete:true },
      'band_4': { rewardRule: { kind:'tiered_percent', tiers:[{min:4000,max:7999.99,rate:0.10},{min:8000,rate:0.20}], perTransactionCap:3000 }, periodCap:10000, rulesComplete:true }
    },
        rewardRule: { kind:'tiered_percent', tiers:[{min:4000,max:7999.99,rate:0.10},{min:8000,rate:0.20}], perTransactionCap:3000 },
        verifiedAt: '2026-09-23T20:30:00+03:00',
        termsSummary: '4–7.999,99 TL %10; 8.000 TL+ %20. 4–8 milyon TL segmentinde işlem başına en fazla 3.000 TL, aylık en fazla 8.000 TL.'
      },
      {
        id: '2026q4', startDate: '2026-10-01', endDate: '2026-12-31', periodCap: 8000,
        segmentRules: {
      'band_1': { rewardRule: { kind:'percent', rate:0.05, minSpend:5000, perTransactionCap:1000 }, periodCap:2000, rulesComplete:true },
      'band_2': { rewardRule: { kind:'tiered_percent', tiers:[{min:5000,max:9999.99,rate:0.10},{min:10000,rate:0.20}], perTransactionCap:2000 }, periodCap:4000, rulesComplete:true },
      'band_3': { rewardRule: { kind:'tiered_percent', tiers:[{min:5000,max:9999.99,rate:0.10},{min:10000,rate:0.20}], perTransactionCap:3000 }, periodCap:8000, rulesComplete:true },
      'band_4': { rewardRule: { kind:'tiered_percent', tiers:[{min:5000,max:9999.99,rate:0.10},{min:10000,rate:0.20}], perTransactionCap:3000 }, periodCap:10000, rulesComplete:true }
    },
        rewardRule: { kind:'tiered_percent', tiers:[{min:5000,max:9999.99,rate:0.10},{min:10000,rate:0.20}], perTransactionCap:3000 },
        verifiedAt: '2026-10-01T12:00:00+03:00',
        termsSummary: '01.10.2026–31.12.2026: 1 milyon TL altı 5.000 TL+ %5 (işlem 1.000 / aylık 2.000 TL). Diğer segmentler 5.000–9.999 TL %10; 10.000 TL+ %20. 4–8 milyon TL segmentinde işlem başına en fazla 3.000 TL, aylık en fazla 8.000 TL. Katılım gerekmez; indirim ekstreye yansır.'
      }
    ],
    segmentRules: {
      'band_1': { rewardRule: { kind:'percent', rate:0.05, minSpend:5000, perTransactionCap:1000 }, periodCap:2000, rulesComplete:true },
      'band_2': { rewardRule: { kind:'tiered_percent', tiers:[{min:5000,max:9999.99,rate:0.10},{min:10000,rate:0.20}], perTransactionCap:2000 }, periodCap:4000, rulesComplete:true },
      'band_3': { rewardRule: { kind:'tiered_percent', tiers:[{min:5000,max:9999.99,rate:0.10},{min:10000,rate:0.20}], perTransactionCap:3000 }, periodCap:8000, rulesComplete:true },
      'band_4': { rewardRule: { kind:'tiered_percent', tiers:[{min:5000,max:9999.99,rate:0.10},{min:10000,rate:0.20}], perTransactionCap:3000 }, periodCap:10000, rulesComplete:true }
    },
    categories: ['restoran'], merchantScope: { kind: 'all' },
    startDate: '2026-10-01', endDate: '2026-12-31', status: 'active', resetPolicy: 'monthly', periodCap: 8000,
    requiresEnrollment: false,
    rewardRule: { kind: 'tiered_percent', tiers:[{min:5000,max:9999.99,rate:0.10},{min:10000,rate:0.20}], perTransactionCap: 3000 },
    transactionRules: {
      location: 'all',
      excludedCategories: ['toptan gıda', 'catering', 'fırın/pastane', 'MaxiMil/MaxiPuan ile ödeme', 'iade/iptal'],
      nonStackable: true
    },
    rulesComplete: true,
    sourceKind: 'core_benefit',
    sourceUrl: 'https://www.maximiles.com.tr/kampanyalar/maximiles-black-ile-restoranlarda-20-indirim-ayricaligi',
    verifiedAt: '2026-10-01T12:00:00+03:00',
    termsSummary: '01.10.2026–31.12.2026: 5.000–9.999 TL %10; 10.000 TL+ %20. 4–8 milyon TL segmentinde işlem başına en fazla 3.000 TL, aylık en fazla 8.000 TL.'
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
    // Segment = varlık seviyesi (kart başına aylık 3.000 / 5.000 / 7.500 / 10.000 TL). Kart tipi (Crystal / Metal Crystal) ayrı boyuttur.
    cardProductIds: ['ykb-crystal'], eligibility: { segmentLabels: ['band_1','band_2','band_3','band_4'] },
    segmentRules: {
      'band_1': { rewardRule:{kind:'percent',rate:0.20,minSpend:0,perTransactionCap:1500}, periodCap:3000, rulesComplete:true },
      'band_2': { rewardRule:{kind:'percent',rate:0.20,minSpend:0,perTransactionCap:2500}, periodCap:5000, rulesComplete:true },
      'band_3': { rewardRule:{kind:'percent',rate:0.20,minSpend:0,perTransactionCap:3000}, periodCap:7500, rulesComplete:true },
      'band_4': { rewardRule:{kind:'percent',rate:0.20,minSpend:0,perTransactionCap:4000}, periodCap:10000, rulesComplete:true }
    },
    // Ayrı kural: Metal Crystal ve Crystal'ı BİRLİKTE taşıyan müşteri iki kart toplamında aylık en fazla 15.000 TL.
    // Bu, Metal Crystal için genel bir segment tavanı DEĞİLDİR; kart başına asset seviyesi tavanları ayrıca geçerlidir.
    combinedCustomerCaps: [
      { id: 'crystal_plus_metal', label: 'Metal Crystal + Crystal birlikte (iki kart toplamı)', requiresCardTypes: ['crystal', 'metal_crystal'],
        periodCap: 15000, resetPolicy: 'monthly', scope: 'customer_across_cards',
        sourceUrl: 'https://www.crystalcard.com.tr/crystal-dunyasi/yurtici-anlasmali-otel-and-restoran-indirimleri' }
    ],

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
    // Onaylı resmi kaynaklar (alias). Aynı ayrıcalık/kurallar iki resmi sitede farklı bitiş tarihiyle görünüyor:
    // Yapı Kredi sayfası 30.09.2026, Crystal resmi sitesi 31.10.2026 (kullanıcı denetimi, 2026-10-03).
    // Çelişki officialDateConflict olarak temsil edilir; en geç resmi tarih kullanılır ve sonuç koşullu/uyarılı olur.
    officialSources: [
      { key: 'ykb', label: 'Yapı Kredi resmi sayfası', url: 'https://www.yapikredi.com.tr/bireysel-bankacilik/kartlar/otel-restoran-indirimleri', endDate: '2026-09-30', verifiedAt: '2026-09-23T20:30:00+03:00' },
      { key: 'crystal', label: 'Crystal resmi sitesi', url: 'https://www.crystalcard.com.tr/crystal-dunyasi/yurtici-anlasmali-otel-and-restoran-indirimleri', endDate: '2026-10-31', verifiedAt: '2026-10-03T12:00:00+03:00', verifiedBy: 'user_audit' }
    ],
    dateConflictPolicy: 'latest_official',
    sourceKind: 'core_benefit',
    sourceUrl: 'https://www.yapikredi.com.tr/bireysel-bankacilik/kartlar/otel-restoran-indirimleri',
    verifiedAt: '2026-09-23T20:30:00+03:00',
    termsSummary: 'Crystal %20. Varlık seviyesine göre kart başına aylık en fazla 3.000 / 5.000 / 7.500 / 10.000 TL (1 milyon TL altı: işlem başına en fazla 1.500 TL). Metal Crystal ve Crystal birlikte: iki kart toplamında aylık en fazla 15.000 TL. Sadece anlaşmalı mekan/Yapı Kredi POS; bazı Günaydın şubeleri hariç. İndirimler 31.10.2026 tarihine kadar geçerlidir (Crystal resmi sitesi).'
  }
];

// Başlangıç durumları ASLA kalan hak varsaymaz: kalan hak kullanıcı doğrulayana kadar bilinmez.
// (Eski sürümler önceki ayın örnek 'reset' değerlerini taşıyordu; yeni ayda bunlar tam tavana dönüşüyordu.)
const unknownInitial = (campaignId, periodKey, enrollmentStatus) => ({ campaignId, periodKey, enrollmentStatus, remainingLimit: null, usedAmount: null, qualifyingTransactions: null, valueSource: 'unknown', confirmedAt: null, origin: 'bootstrap', updatedAt: '2026-10-03T00:00:00+03:00' });

export const initialStates = {
  'official-wings-program-restoran-2026': unknownInitial('official-wings-program-restoran-2026', '2026-09', 'unknown'),
  'official-is-eticaret-2026-09': unknownInitial('official-is-eticaret-2026-09', 'official-is-eticaret-2026-09:2026-09-01:2026-09-30', 'unknown'),
  'official-is-restoran-2026q3': unknownInitial('official-is-restoran-2026q3', '2026-09', 'not_required'),
  'official-teb-infinite-restoran-ultra': unknownInitial('official-teb-infinite-restoran-ultra', '2026-09', 'not_required'),
  'official-ykb-crystal-restoran-2026-09': unknownInitial('official-ykb-crystal-restoran-2026-09', '2026-09', 'not_required'),
};
