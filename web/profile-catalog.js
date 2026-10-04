// v1.4 — Profil ANA VERİSİ (global, kullanıcıdan bağımsız). Supabase'deki banks / card_products /
// profile_dimensions / profile_dimension_options tablolarının istemci kopyasıdır (çevrimdışı/yedek).
// Kaynak gerçek: veritabanı. Bu dosya ile migration 008 seed'inin birebir aynı olduğu RLS test düzeneğinde doğrulanır.
//
// Yeni banka/program/kart/segment eklemek = veri değişikliği (bu dosya + migration seed). Uygulama mimarisi değişmez.
// v1.5.0: Hiçbir kart ürünü "özel" değildir. Model katmanları:
//   Banka (PROFILE_BANKS)  →  Kart programı/ailesi (PROFILE_CARD_PROGRAMS: Bonus, Bankkart, Paraf, Wings …)
//   →  Somut kart ürünü (PROFILE_CARD_PRODUCTS; yalnız uygunluk/ödül davranışı farklıysa ayrı kayıt)
//   +  Profil boyutları (PROFILE_DIMENSIONS; birbirinden bağımsız, birden fazlası aynı anda)
//   +  Ölçüt metaverisi (PROFILE_OPTION_CRITERIA; tarihli/kaynaklı, kimlikten ayrı)
//   +  Kapsam (BANK_COVERAGE; bir bankanın listede olması TAM destek anlamına gelmez — coverage.js).
// Bir banka; kart ürünü, profil boyutu, çekirdek ayrıcalık veya kampanya tarayıcısı olmadan da ana veride bulunabilir.
// Doğrulanmamış ürün/segment/ayrıcalık EKLENMEZ.
//
// engineBinding: segment seçiminin karar motoruna nasıl aktarıldığı
//   card_segment → seçeneğin engineLabel'ı, kapsamdaki kartların `segment` alanı olur (kampanya segment eşleşmesi)
//   card_type    → kapsamdaki kartların `cardType` alanı olur (ör. Crystal + Metal birleşik tavan)
//   loyalty      → yalnız normal kazanım hesabına girer (ör. THY statüsü)
//   eligibility_only → yalnız kampanya uygunluk kurallarında (eligibilityRule.attr) kullanılır; kart alanlarına yazılmaz
// Kampanya uygunluğu HER ZAMAN öznitelikleri boyut/seçenek koduyla okur (eligibility.js); card.segment kanonik değildir.
// settingKey: mevcut kazanım formüllerinin (loyalty.js) okuduğu ayar anahtarı.

export const PROFILE_BANKS = [
  { code: 'akbank', name: 'Akbank', sortOrder: 10 },
  { code: 'isbank', name: 'İş Bankası', sortOrder: 20 },
  { code: 'qnb', name: 'QNB', sortOrder: 30 },
  { code: 'teb', name: 'TEB', sortOrder: 40 },
  { code: 'ykb', name: 'Yapı Kredi', sortOrder: 50 },
  // v1.5.0 — ana veride var; kart ürünü/boyut/çekirdek ayrıcalık/kampanya tarayıcısı HENÜZ YOK (BANK_COVERAGE).
  { code: 'garanti', name: 'Garanti BBVA', sortOrder: 60 },
  { code: 'ziraat', name: 'Ziraat Bankası', sortOrder: 70 },
  { code: 'halkbank', name: 'Halkbank', sortOrder: 80 },
  { code: 'vakifbank', name: 'VakıfBank', sortOrder: 90 },
  { code: 'denizbank', name: 'DenizBank', sortOrder: 100 },
];

// Kart programları/aileleri. YALNIZ resmi kaynakla doğrulanmış kayıtlar. Program kodu bankaya özeldir
// (aynı platformu kullanan iki banka iki ayrı program kaydıdır). verifiedAt = KAYNAK doğrulaması (global ana veri).
// verifiedAt null + sourceUrl = mevcut üretim kampanya tarayıcısının resmi kaynağı (çalışan kaynak; ayrıca etiket doğrulaması yapılmadı).
export const PROFILE_CARD_PROGRAMS = [
  { code: 'wings', bankCode: 'akbank', name: 'Wings', sourceUrl: 'https://www.wingscard.com.tr/kampanyalar', verifiedAt: null, sortOrder: 10 },
  { code: 'axess', bankCode: 'akbank', name: 'Axess', sourceUrl: 'https://www.axess.com.tr/axess/kampanyalar', verifiedAt: null, sortOrder: 20 },
  { code: 'maximiles', bankCode: 'isbank', name: 'Maximiles', sourceUrl: 'https://www.maximiles.com.tr/kampanyalar/tum-kampanyalar', verifiedAt: null, sortOrder: 10 },
  { code: 'qnb-card', bankCode: 'qnb', name: 'QNB Card', sourceUrl: 'https://www.qnbcard.com.tr/kampanyalar', verifiedAt: null, sortOrder: 10 },
  { code: 'miles-smiles-qnb', bankCode: 'qnb', name: 'Miles&Smiles QNB', sourceUrl: 'https://milesandsmilesqnb.com.tr/kampanyalar', verifiedAt: null, sortOrder: 20 },
  { code: 'world', bankCode: 'ykb', name: 'World', sourceUrl: 'https://www.worldcard.com.tr/kampanya', verifiedAt: null, sortOrder: 10 },
  { code: 'crystal', bankCode: 'ykb', name: 'Crystal', sourceUrl: 'https://www.crystalcard.com.tr/crystal-dunyasi/varliga-bagli-crystal-ayricaliklari/crystal-ile-yurt-disi-yurt-ici-tum-restoranlarda-5-indirim', verifiedAt: '2026-10-03T19:00:00Z', sortOrder: 20 },
  { code: 'bonus-garanti', bankCode: 'garanti', name: 'Bonus', sourceUrl: 'https://www.bonus.com.tr/kampanyalar', verifiedAt: '2026-10-04T00:00:00Z', sortOrder: 10 },
  { code: 'bankkart', bankCode: 'ziraat', name: 'Bankkart', sourceUrl: 'https://www.bankkart.com.tr/kampanyalar', verifiedAt: '2026-10-04T00:00:00Z', sortOrder: 10 },
  { code: 'paraf', bankCode: 'halkbank', name: 'Paraf', sourceUrl: 'https://www.paraf.com.tr/tr/kampanyalar.html', verifiedAt: '2026-10-04T00:00:00Z', sortOrder: 10 },
  { code: 'vakifkart', bankCode: 'vakifbank', name: 'Vakıfkart (VakıfBank Worldcard)', sourceUrl: 'https://www.vakifkart.com.tr/kampanyalar', verifiedAt: '2026-10-04T00:00:00Z', sortOrder: 10 },
  // DenizBank: program kaydı EKLENMEDİ (resmi kaynak bu sürümde doğrulanamadı).
];

export const PROFILE_CARD_PRODUCTS = [
  { code: 'akbank-wings-elite', bankCode: 'akbank', name: 'Wings Elite', family: 'wings', sortOrder: 10, programCode: 'wings' },
  { code: 'akbank-wings-black', bankCode: 'akbank', name: 'Wings Black', family: 'wings', sortOrder: 20, programCode: 'wings' },
  { code: 'is-maximiles-black', bankCode: 'isbank', name: 'Maximiles Black', family: 'maximiles', sortOrder: 10, programCode: 'maximiles' },
  { code: 'qnb-ms-private', bankCode: 'qnb', name: 'Miles&Smiles QNB Private', family: 'miles-smiles-qnb', sortOrder: 10, programCode: 'miles-smiles-qnb' },
  { code: 'teb-infinite', bankCode: 'teb', name: 'TEB Özel Infinite', family: 'teb-infinite', sortOrder: 10, programCode: null },
  { code: 'ykb-crystal', bankCode: 'ykb', name: 'Crystal', family: 'crystal', sortOrder: 10, programCode: 'crystal' },
];

// v1.5.0 — Uygunluk aileleri (kampanya kapsamı için KARARLI aile/program kodları). Bir kampanya "TEB Bonus özellikli
// bireysel kredi kartları" veya "Miles&Smiles QNB kartları" gibi bir AİLEYİ hedefler; ana veride o aileden şu an tek
// ürün olması kampanyayı o ürüne İNDİRGEMEZ. Kampanya kuralı aile düzeyinde kalır ({payWith:{families:[...]}});
// sahip olunan ürün, üyeliği üzerinden eşleşir. Yeni bir üye ürün = yalnız bu listeye ekleme (kampanya kaydı değişmez).
// membershipComplete:false → bankanın bu ailedeki ürünlerinin hepsi ana veride YOK (çözüm 'partial' kalır).
// Bir ürün birden fazla aileye üye olabilir (TEB Özel Infinite: Bonus özellikli + bireysel kredi kartı).
export const CARD_ELIGIBILITY_FAMILIES = [
  { code: 'wings', bankCode: 'akbank', label: 'Wings kredi kartları', members: ['akbank-wings-elite', 'akbank-wings-black'], membershipComplete: false },
  { code: 'akbank-individual-credit', bankCode: 'akbank', label: 'Akbank bireysel kredi kartları', members: ['akbank-wings-elite', 'akbank-wings-black'], membershipComplete: false },
  { code: 'maximiles', bankCode: 'isbank', label: 'Maximiles kartları', members: ['is-maximiles-black'], membershipComplete: false },
  { code: 'isbank-maximum-individual-credit', bankCode: 'isbank', label: 'Maximum özellikli bireysel kredi kartları', members: ['is-maximiles-black'], membershipComplete: false },
  { code: 'isbank-individual-credit', bankCode: 'isbank', label: 'İş Bankası bireysel kredi kartları', members: ['is-maximiles-black'], membershipComplete: false },
  { code: 'miles-smiles-qnb', bankCode: 'qnb', label: 'Miles&Smiles QNB kartları', members: ['qnb-ms-private'], membershipComplete: false },
  { code: 'qnb-individual-credit', bankCode: 'qnb', label: 'QNB bireysel kredi kartları', members: ['qnb-ms-private'], membershipComplete: false },
  { code: 'teb-bonus-individual-credit', bankCode: 'teb', label: 'TEB Bonus özellikli bireysel kredi kartları', members: ['teb-infinite'], membershipComplete: false },
  { code: 'teb-individual-credit', bankCode: 'teb', label: 'TEB bireysel kredi kartları', members: ['teb-infinite'], membershipComplete: false },
  { code: 'ykb-world-individual-credit', bankCode: 'ykb', label: 'World özellikli bireysel kredi kartları', members: ['ykb-crystal'], membershipComplete: false },
  { code: 'ykb-individual-credit', bankCode: 'ykb', label: 'Yapı Kredi bireysel kredi kartları', members: ['ykb-crystal'], membershipComplete: false },
];

export const PROFILE_DIMENSIONS = [
  {
    code: 'qnb_segment', label: 'QNB müşteri segmenti', kind: 'segment', bankCode: 'qnb', cardCodes: ['qnb-ms-private'],
    engineBinding: 'card_segment', settingKey: 'qnbSegment', sortOrder: 10,
    options: [
      { code: 'other', label: 'Diğer / QNB First altı', engineLabel: 'Diğer', sortOrder: 10 },
      { code: 'first', label: 'QNB First', engineLabel: 'QNB First', sortOrder: 20 },
      { code: 'first_plus', label: 'QNB First Plus', engineLabel: 'QNB First Plus', sortOrder: 30 },
      { code: 'private', label: 'QNB Private', engineLabel: 'Private', sortOrder: 40 },
    ],
  },
  {
    code: 'thy_status', label: 'Turkish Airlines Miles&Smiles statüsü', kind: 'loyalty_status', bankCode: null, cardCodes: ['qnb-ms-private'],
    engineBinding: 'loyalty', settingKey: 'thyStatus', sortOrder: 15,
    options: [
      { code: 'classic', label: 'Classic', engineLabel: 'Classic', sortOrder: 10 },
      { code: 'classic_plus', label: 'Classic Plus', engineLabel: 'Classic Plus', sortOrder: 20 },
      { code: 'elite', label: 'Elite', engineLabel: 'Elite', sortOrder: 30 },
      { code: 'elite_plus', label: 'Elite Plus', engineLabel: 'Elite Plus', sortOrder: 40 },
    ],
  },
  {
    code: 'wings_tier', label: 'Akbank Wings varlık programı', kind: 'asset_band', bankCode: 'akbank', cardCodes: ['akbank-wings-elite', 'akbank-wings-black'],
    engineBinding: 'card_segment', settingKey: 'wingsTier', sortOrder: 20,
    options: [
      // v1.5.0: görünen ad = kademe adı. engineLabel yalnız eski (yayındaki) segmentRules anahtarıdır; kimlik DEĞİL,
      // kaldırılması expand/contract'ın "contract" adımına bırakıldı (docs/MASTER_DATA_v1.5.md).
      { code: 'standard', label: 'Classic', engineLabel: 'Classic / 1 milyon TL altı', sortOrder: 10 },
      { code: 'black', label: 'Black', engineLabel: 'Black / 1–2 milyon TL', sortOrder: 20 },
      { code: 'black_plus', label: 'Black Plus', engineLabel: 'Black Plus / 2 milyon TL+', sortOrder: 30 },
    ],
  },
  {
    code: 'maximiles_band', label: 'Maximiles Black varlık bandı', kind: 'asset_band', bankCode: 'isbank', cardCodes: ['is-maximiles-black'],
    engineBinding: 'card_segment', settingKey: 'maximilesBand', sortOrder: 30,
    options: [
      { code: 'band_1', label: '1. bant', engineLabel: 'band_1', sortOrder: 10 },
      { code: 'band_2', label: '2. bant', engineLabel: 'band_2', sortOrder: 20 },
      { code: 'band_3', label: '3. bant', engineLabel: 'band_3', sortOrder: 30 },
      { code: 'band_4', label: '4. bant', engineLabel: 'band_4', sortOrder: 40 },
    ],
  },
  {
    code: 'crystal_band', label: 'Yapı Kredi Crystal varlık bandı', kind: 'asset_band', bankCode: 'ykb', cardCodes: ['ykb-crystal'],
    engineBinding: 'card_segment', settingKey: 'crystalBand', sortOrder: 40,
    options: [
      { code: 'band_1', label: '1. bant', engineLabel: 'band_1', sortOrder: 10 },
      { code: 'band_2', label: '2. bant', engineLabel: 'band_2', sortOrder: 20 },
      { code: 'band_3', label: '3. bant', engineLabel: 'band_3', sortOrder: 30 },
      { code: 'band_4', label: '4. bant', engineLabel: 'band_4', sortOrder: 40 },
    ],
  },
  {
    code: 'crystal_card_type', label: 'Yapı Kredi Crystal kart tipi', kind: 'card_variant', bankCode: 'ykb', cardCodes: ['ykb-crystal'],
    engineBinding: 'card_type', settingKey: 'crystalCardType', sortOrder: 45,
    options: [
      { code: 'crystal', label: 'Crystal', engineLabel: 'crystal', sortOrder: 10 },
      { code: 'metal_crystal', label: 'Metal Crystal', engineLabel: 'metal_crystal', sortOrder: 20 },
      { code: 'crystal_and_metal', label: 'Crystal + Metal Crystal (ikisi birden)', engineLabel: 'crystal_and_metal', sortOrder: 30 },
    ],
  },
  {
    code: 'teb_tier', label: 'TEB Infinite paket seviyesi', kind: 'segment', bankCode: 'teb', cardCodes: ['teb-infinite'],
    engineBinding: 'card_segment', settingKey: 'tebTier', sortOrder: 50,
    options: [
      { code: 'standard', label: 'Standart', engineLabel: 'Standart', sortOrder: 10 },
      { code: 'plus', label: 'Plus', engineLabel: 'Plus', sortOrder: 20 },
      { code: 'premium', label: 'Premium', engineLabel: 'Premium', sortOrder: 30 },
      { code: 'ultra', label: 'Ultra', engineLabel: 'Ultra', sortOrder: 40 },
    ],
  },
];

// ---------------------------------------------------------------- v1.4.3: tarihli, kaynaklı seçenek ölçütleri
// Seçenek KODU kalıcı ve nötr kimliktir (band_1, band_2 …); hiçbir eşik içermez ve BOYUTA özeldir:
// maximiles_band.band_2 ile crystal_band.band_2 aynı tutar aralığı DEĞİLDİR.
// İnsan-okur etiket ve sayısal sınırlar burada, sürümlü ve tarihli tutulur (Supabase: public.profile_option_criteria,
// migration 010; birebir aynılığı test düzeneği doğrular). Banka eşikleri değişirse YENİ bir criteriaVersion eklenir,
// eski sürüme effectiveTo yazılır; kod değişmez. Kullanıcının onayı hangi sürümde verildiyse o sürüme bağlı kalır ve
// güncel sürümden farklıysa yeniden onay istenir (profile-criteria.js). Kullanıcının tutarı ASLA istenmez/saklanmaz;
// bantlar yalnız seçim yardımı ve açıklamadır (Campaign Hunter tutardan bant hesaplamaz).
// effectiveFrom: bu tanımın uygulandığını bildiğimiz en erken gün (Europe/Istanbul). effectiveTo: dışlayıcı, null = yürürlükte.
// lowerBound/upperBound: TL, bilgi amaçlı; sınır dahil/hariç yorumu kaynaktaki ifadeye göredir (sourceReference).
// verifiedAt = KAYNAK doğrulaması: bu GLOBAL ana veri satırının resmi kaynakla en son ne zaman karşılaştırıldığı
// (güven/tazelik). null = doğrulanamadı. Bu, kullanıcının KENDİ seçimini onaylamasından (user_profile_attributes.
// criteria_version + confirmed_at) tamamen ayrı bir kavramdır; kullanıcı onayı kaynağın doğrulandığı anlamına gelmez.
const MAXIMILES_SOURCE = 'https://www.maximiles.com.tr/kampanyalar/maximiles-black-ile-restoranlarda-20-indirim-ayricaligi';
const CRYSTAL_SOURCE = 'https://www.crystalcard.com.tr/crystal-dunyasi/varliga-bagli-crystal-ayricaliklari/crystal-ile-yurt-disi-yurt-ici-tum-restoranlarda-5-indirim';
const maxi = (optionCode, displayLabel, lowerBound, upperBound, wording) => ({
  dimensionCode: 'maximiles_band', optionCode, criteriaVersion: 'v1', effectiveFrom: '2026-10-01', effectiveTo: null,
  displayLabel, lowerBound, upperBound, boundUnit: 'TRY', sourceUrl: MAXIMILES_SOURCE,
  sourceReference: `Maximiles Black restoran kampanyası 01.10.2026–31.12.2026: "${wording}"`, verifiedAt: '2026-10-03T00:00:00Z',
});
const crystal = (optionCode, displayLabel, lowerBound, upperBound, wording) => ({
  dimensionCode: 'crystal_band', optionCode, criteriaVersion: 'v1', effectiveFrom: '2026-10-01', effectiveTo: null,
  displayLabel, lowerBound, upperBound, boundUnit: 'TRY', sourceUrl: CRYSTAL_SOURCE,
  sourceReference: `Crystal Card resmi sayfası, Varlığa Bağlı Crystal Ayrıcalıkları (anlaşmalı otel/restoran %20): "${wording}"`,
  verifiedAt: '2026-10-03T19:00:00Z',
});
export const PROFILE_OPTION_CRITERIA = [
  maxi('band_1', "1 milyon TL'ye kadar", null, 1000000, "Bankamızda 1.000.000 TL'ye kadar varlık birikimi olan müşterilerimiz"),
  maxi('band_2', '1–4 milyon TL arası', 1000000, 4000000, 'Bankamızda 1.000.000 TL-4.000.000 TL arası varlık birikimi olan müşterilerimiz'),
  maxi('band_3', '4–8 milyon TL arası', 4000000, 8000000, 'Bankamızda 4.000.000 TL-8.000.000 TL arası varlık birikimi olan müşterilerimiz'),
  maxi('band_4', '8 milyon TL üzeri', 8000000, null, 'Bankamızda 8.000.000 TL üzeri varlık birikimi olan müşterilerimiz'),
  crystal('band_1', '1 milyon TL altı', null, 1000000, "Toplam varlığı 1 milyon TL'nin altında olan müşterilerimiz, işlem bazında en fazla 1.500 TL, aylık bazda en fazla 3.000 TL indirim kazanabilir."),
  crystal('band_2', '1–6 milyon TL', 1000000, 6000000, 'Toplam varlığı 1 milyon TL - 6 milyon TL arasında olan müşterilerimiz, işlem bazında en fazla 2.500 TL, aylık bazda en fazla 5.000 TL indirim kazanabilir.'),
  crystal('band_3', '6–10 milyon TL', 6000000, 10000000, 'Toplam varlığı 6 milyon TL - 10 milyon TL arasında olan müşterilerimiz, işlem bazında en fazla 3.000 TL, aylık bazda en fazla 7.500 TL indirim kazanabilir.'),
  crystal('band_4', '10 milyon TL ve üzeri', 10000000, null, 'Toplam varlığı 10 milyon TL ve üzerinde olan Crystal kart sahibi müşterilerimiz, işlem bazında en fazla 4.000 TL, aylık bazda en fazla 10.000 TL değerinde indirim kazanabilir.'),
];

// ---------------------------------------------------------------- v1.5.0: banka kapsamı (global ana veri)
// Her faset bağımsız ve makinece okunur: 'full' | 'partial' | 'none'  (kampanyalar için ek olarak 'coming').
// Beyan edilen değerler ÜST SINIRDIR: coverage.js kampanya fasetini kaynak kaydına (server/source_catalog.json →
// catalog.meta.sourceRegistry) göre kırpar; etkin tarayıcısı olmayan banka asla 'full'/'partial' kampanya kapsamı göstermez.
// Genel destek düzeyi (full / partial / profile_only / coming / unsupported) TÜRETİLİR, saklanmaz.
export const BANK_COVERAGE = [
  // Mevcut bankalar: yalnız bazı ürünler/boyutlar/ayrıcalıklar ve bazı kampanya kaynakları kapsanıyor → kısmi.
  { bankCode: 'akbank', cardProducts: 'partial', profileDimensions: 'partial', coreBenefits: 'partial', campaigns: 'partial', note: 'Wings Elite/Black kapsanıyor; Axess ürünleri henüz yok.' },
  { bankCode: 'isbank', cardProducts: 'partial', profileDimensions: 'partial', coreBenefits: 'partial', campaigns: 'partial', note: 'Maximiles Black kapsanıyor; Maximum ürünleri henüz yok.' },
  { bankCode: 'qnb', cardProducts: 'partial', profileDimensions: 'partial', coreBenefits: 'partial', campaigns: 'partial', note: 'Miles&Smiles QNB Private kapsanıyor.' },
  { bankCode: 'teb', cardProducts: 'partial', profileDimensions: 'partial', coreBenefits: 'partial', campaigns: 'partial', note: 'TEB Özel Infinite kapsanıyor.' },
  { bankCode: 'ykb', cardProducts: 'partial', profileDimensions: 'partial', coreBenefits: 'partial', campaigns: 'partial', note: 'Crystal kapsanıyor; World ürünleri henüz yok.' },
  // Yeni bankalar: banka + (doğrulanmış) program kaydı; resmi kampanya sayfası kayıtlı ama tarayıcı kapalı.
  { bankCode: 'garanti', cardProducts: 'none', profileDimensions: 'none', coreBenefits: 'none', campaigns: 'coming', note: 'Bonus programı kayıtlı; kart ürünleri ve kampanya tarayıcısı hazırlanıyor.' },
  { bankCode: 'ziraat', cardProducts: 'none', profileDimensions: 'none', coreBenefits: 'none', campaigns: 'coming', note: 'Bankkart programı kayıtlı; kart ürünleri ve kampanya tarayıcısı hazırlanıyor.' },
  { bankCode: 'halkbank', cardProducts: 'none', profileDimensions: 'none', coreBenefits: 'none', campaigns: 'coming', note: 'Paraf programı kayıtlı; kart ürünleri ve kampanya tarayıcısı hazırlanıyor.' },
  { bankCode: 'vakifbank', cardProducts: 'none', profileDimensions: 'none', coreBenefits: 'none', campaigns: 'coming', note: 'Vakıfkart programı kayıtlı; kart ürünleri ve kampanya tarayıcısı hazırlanıyor.' },
  { bankCode: 'denizbank', cardProducts: 'none', profileDimensions: 'none', coreBenefits: 'none', campaigns: 'none', note: 'Yalnız banka kaydı; program ve kampanya kaynağı henüz doğrulanmadı.' },
];

// Önbelleğe alınmış eski katalogları ayırt etmek için şema sürümü (2: nötr bant kodları; 3: program + kapsam).
export const PROFILE_CATALOG_SCHEMA = 3;

export const BUNDLED_PROFILE_CATALOG = {
  banks: PROFILE_BANKS,
  cardPrograms: PROFILE_CARD_PROGRAMS,
  cardProducts: PROFILE_CARD_PRODUCTS,
  cardFamilies: CARD_ELIGIBILITY_FAMILIES,
  bankCoverage: BANK_COVERAGE,
  dimensions: PROFILE_DIMENSIONS,
  optionCriteria: PROFILE_OPTION_CRITERIA,
  schema: PROFILE_CATALOG_SCHEMA,
  source: 'bundled',
};
