// Info ekranı: sürüm/build/katalog durumu ve sürüm notları tek yerde.
export const RELEASE_NOTES = [
  {
    version: 'v1.5.0',
    date: '2026-10',
    items: [
      'Garanti BBVA, Ziraat Bankası, Halkbank, VakıfBank ve DenizBank banka listesine eklendi; kart ve kampanya desteği hazırlanıyor ve her bankanın destek durumu açıkça gösteriliyor.',
      'Bankan listede yoksa “Bankam listede yok” ile istekte bulunabilirsin.',
      'Segmente göre değişen kampanyalarda yalnız kesin uyan oran hesaplanır; segmentini seçersen olası daha yüksek oran ayrıca gösterilir.',
      'QNB Terminal Kadıköy kampanyası resmi koşullarına göre güncellendi: QNB kredi kartları %10, First Plus %15, Private %20.',
      'Wings ve TEB kademeleri sade adlarıyla gösterilir (ör. Black Plus, Ultra).',
      'Uygulama Bilgisi ekranında banka ve kampanya kapsamı tablosu.',
    ],
  },
  {
    version: 'v1.4.4',
    date: '2026-10',
    items: [
      'Kayıt doğrulama e-postasındaki bağlantı artık doğrudan Kampanya Avcısı’nı açar (önceden GitHub Pages ana sayfasında 404 görünüyordu).',
      'Doğrulama ve şifre sıfırlama bağlantıları oturumu doğru kurar; süresi dolmuş bağlantıda anlaşılır bir giriş mesajı gösterilir.',
      'Şifre sıfırlama da aynı uygulama adresine döner.',
    ],
  },
  {
    version: 'v1.4.3',
    date: '2026-10',
    items: [
      'Maximiles ve Crystal varlık bantları kalıcı, eşik içermeyen kimliklerle saklanır; bant etiketleri ve sınırları tarihli, kaynaklı ölçüt kayıtlarından gelir.',
      'Banka bant eşiklerini değiştirirse eski seçimin sessizce geçerli sayılmaz: Müşteri Profili yeniden onay ister, o zamana kadar seçim hesaplamalarda “bilinmiyor” sayılır.',
      'Varlık tutarın sorulmaz ve saklanmaz; yalnız bant seçimi tutulur.',
      'Crystal bant ölçütleri resmi Crystal Card sayfasıyla doğrulandı (kaynak ve doğrulama tarihi profilde gösterilir).',
      'Ödül ve kampanya sonuçları değişmedi (önceki sürümle eşdeğerlik testleriyle doğrulandı).',
    ],
  },
  {
    version: 'v1.4.2',
    date: '2026-10',
    items: [
      'Kampanya uygunluk kuralları sürüm denetimiyle korunur: geçersiz veya desteklenmeyen kural taşıyan kampanya hiçbir karta uygun gösterilmez.',
      'Katalog kalite kapısı geçersiz kuralları yayınlamaz; o kampanyanın son başarılı kaydı korunur.',
      'Kademeli ödüller için kurallar tanımlandı: bilinmeyen segment, gösterilen tutarı asla yükseltmez (Hangi Kart?\'a sonraki sürümde bağlanacak).',
    ],
  },
  {
    version: 'v1.4.1',
    date: '2026-10',
    items: [
      'Kampanya uygunluğu için ortak değerlendirici: Kampanyalar ve Hangi Kart? aynı kuralları kullanır.',
      'Uygunluk profil özniteliklerini (boyut + seçenek kodu) doğrudan okur; aynı karta birden fazla özellik bağlanabilir.',
      'Yalnız kampanya uygunluğu için kullanılan profil özellikleri desteklenir (eligibility_only).',
      'Mevcut kampanya kayıtları değişmeden aynı sonucu verir (geriye uyumluluk testleriyle doğrulandı).',
    ],
  },
  {
    version: 'v1.4.0',
    date: '2026-10',
    items: [
      'Hesaba bağlı kişisel profil: bankaların, kartların, segmentlerin ve statülerin hesabında saklanır.',
      'İlk girişte kısa profil kurulumu (banka → kart → segment → tamamla); sonraki açılışlarda profil otomatik yüklenir.',
      'Hangi Kart? yalnız SENİN kartlarını karşılaştırır; seçilmeyen segmentler için oran uydurulmaz.',
      'Profil › Bankalarım ve Kartlarım ile Müşteri Profili artık düzenlenebilir.',
      'Çıkış oturumu sunucuda da sonlandırır; cihazdaki veriler kullanıcıya göre ayrılır.',
      'Veritabanında satır düzeyi güvenlik (RLS): her kullanıcı yalnız kendi profilini okuyup değiştirebilir.',
    ],
  },
  {
    version: 'v1.3.0',
    date: '2026-10',
    items: [
      'Hangi Kart? artık ana ekran ve varsayılan açılış sayfası.',
      'Ana menü sadeleşti: Hangi Kart? · Kampanyalar · Profil.',
      'Özet ekranı Profil → Veriler ve Özet altına taşındı; işlevleri korunuyor.',
      'Kampanya ekleme, Kampanyalar ekranındaki + düğmesinden açılıyor.',
      'Profil bölümleri: Bankalarım ve Kartlarım, Müşteri Profili, Tercihler, Veriler ve Özet, Hesap, Uygulama Bilgisi.',
      'Sürüm, build ve katalog güncelleme bilgisi yalnız Uygulama Bilgisi ekranında.',
    ],
  },
  {
    version: 'v1.2.2-supabase',
    date: '2026-10',
    items: [
      'Kampanya takvimi Europe/Istanbul saatine göre; yeni dönemde kalan hak bilinmiyor başlar.',
      'Katalog kalite kapısı ve son başarılı katalog koruması.',
      'Sürekli kart ayrıcalıkları dönemleri (Maximiles Q4), Crystal resmi kaynak tarih çelişkisi.',
    ],
  },
];

function fmtTime(v) {
  if (!v) return 'Bilinmiyor';
  try { return new Date(v).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' }); } catch { return String(v); }
}

const SOURCE_LABELS = { 'local-api': 'Yerel sunucu', supabase: 'Supabase bulut kataloğu', static: 'Yayındaki statik katalog' };
const GUARD_LABELS = { ok: 'Sorunsuz', repaired: 'Onarıldı (bazı kaynaklar için son başarılı kayıtlar)', rejected: 'Yeni tarama reddedildi; son başarılı katalog', bootstrap: 'İlk kurulum yayını' };

export function buildInfoRows({ version, build = {}, meta = {}, campaignCount = null, coreCount = null } = {}) {
  const catalogMeta = meta.catalogMeta || {};
  const rows = [
    ['Uygulama sürümü', version || 'Bilinmiyor'],
    ['Build', build.id || 'yerel'],
  ];
  if (build.commit) rows.push(['Commit', String(build.commit).slice(0, 7)]);
  if (build.builtAt) rows.push(['Build zamanı', fmtTime(build.builtAt)]);
  rows.push(['Katalog son tarama', fmtTime(meta.catalogGeneratedAt)]);
  rows.push(['Katalog kaynağı', SOURCE_LABELS[meta.catalogSource] || meta.catalogSource || 'Başlangıç kataloğu']);
  if (campaignCount !== null) rows.push(['Katalogdaki kampanya', String(catalogMeta.campaign_count ?? campaignCount)]);
  if (coreCount !== null) rows.push(['Sürekli kart ayrıcalığı', String(coreCount)]);
  if (catalogMeta.guard?.verdict) rows.push(['Katalog kalite kapısı', GUARD_LABELS[catalogMeta.guard.verdict] || catalogMeta.guard.verdict]);
  return rows;
}
