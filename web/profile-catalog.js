// v1.4 — Profil ANA VERİSİ (global, kullanıcıdan bağımsız). Supabase'deki banks / card_products /
// profile_dimensions / profile_dimension_options tablolarının istemci kopyasıdır (çevrimdışı/yedek).
// Kaynak gerçek: veritabanı. Bu dosya ile migration 008 seed'inin birebir aynı olduğu RLS test düzeneğinde doğrulanır.
//
// Yeni banka/kart/segment eklemek = veri değişikliği (bu tablo + migration seed). Uygulama mimarisi değişmez.
// ÖNEMLİ (v1.4.1): Ana veri şu an YALNIZ ilk altı kart ürününü içerir (Wings Elite, Wings Black, Maximiles Black,
// Miles&Smiles QNB Private, TEB Özel Infinite, Crystal). Profil mimarisi çok sayıda banka/ürünü VERİ olarak destekler;
// ürün kataloğunun genişletilmesi ayrı ve kontrollü bir adımda (bu dosya + migration seed + crawler kaynak eşlemesi) yapılacak.
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
];

export const PROFILE_CARD_PRODUCTS = [
  { code: 'akbank-wings-elite', bankCode: 'akbank', name: 'Wings Elite', family: 'wings', sortOrder: 10 },
  { code: 'akbank-wings-black', bankCode: 'akbank', name: 'Wings Black', family: 'wings', sortOrder: 20 },
  { code: 'is-maximiles-black', bankCode: 'isbank', name: 'Maximiles Black', family: 'maximiles', sortOrder: 10 },
  { code: 'qnb-ms-private', bankCode: 'qnb', name: 'Miles&Smiles QNB Private', family: 'miles-smiles-qnb', sortOrder: 10 },
  { code: 'teb-infinite', bankCode: 'teb', name: 'TEB Özel Infinite', family: 'teb-infinite', sortOrder: 10 },
  { code: 'ykb-crystal', bankCode: 'ykb', name: 'Crystal', family: 'crystal', sortOrder: 10 },
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
      { code: 'standard', label: 'Classic / 1 milyon TL altı', engineLabel: 'Classic / 1 milyon TL altı', sortOrder: 10 },
      { code: 'black', label: 'Black / 1–2 milyon TL', engineLabel: 'Black / 1–2 milyon TL', sortOrder: 20 },
      { code: 'black_plus', label: 'Black Plus / 2 milyon TL+', engineLabel: 'Black Plus / 2 milyon TL+', sortOrder: 30 },
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
      { code: 'standard', label: "Standart / 1 milyon TL'ye kadar", engineLabel: 'Standart', sortOrder: 10 },
      { code: 'plus', label: 'Plus / 1–5 milyon TL', engineLabel: 'Plus', sortOrder: 20 },
      { code: 'premium', label: 'Premium / 5–10 milyon TL', engineLabel: 'Premium', sortOrder: 30 },
      { code: 'ultra', label: 'Ultra / 10 milyon TL+', engineLabel: 'Ultra', sortOrder: 40 },
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

// Önbelleğe alınmış eski katalogları (eşik kodlu seçenekler) ayırt etmek için şema sürümü.
export const PROFILE_CATALOG_SCHEMA = 2;

export const BUNDLED_PROFILE_CATALOG = {
  banks: PROFILE_BANKS,
  cardProducts: PROFILE_CARD_PRODUCTS,
  dimensions: PROFILE_DIMENSIONS,
  optionCriteria: PROFILE_OPTION_CRITERIA,
  schema: PROFILE_CATALOG_SCHEMA,
  source: 'bundled',
};
