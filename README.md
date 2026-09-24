# Banka Kampanya Avcısı v1.2.1-supabase

Bu paket Supabase projesine bağlanmış istemci ayarlarıyla gelir. Ayrıntı: `SUPABASE_BAGLANTI.md`.

# Banka Kampanya Avcısı v1.1.1-live


## v1.1.1 Kategori/sektör doğruluk düzeltmesi

- Kampanya kategorisi artık tüm sayfa gövdesindeki rastgele kelimelerden türetilmez.
- Öncelik: bankanın resmi kategori sayfası → kampanya başlığı/marka → kısa kampanya özeti → `Diğer`.
- `IKEA`, `Apple/Microsoft`, `World Mobil` gibi sayfaların menü/öneri metninden yanlışlıkla **Akaryakıt** görünmesi engellendi.
- Elektrikli araç şarj kampanyaları **Akaryakıt/Otogaz**'dan ayrılıp ayrı **Elektrikli Araç Şarj** kategorisine taşındı.
- World ve Maximiles resmi kategori sayfaları kategori doğrulama kaynağı olarak kullanılıyor.
- Dinamik liste sayfalarında gözden kaçan güncel Petrol Ofisi / Opet / Up Enerji / TotalEnergies örnekleri için resmi detay URL'leri discovery fallback olarak eklendi.
- Her canlı kayda `categorySource` ve `categoryConfidence` eklenir; tanı logunda kategorinin nereden geldiği görülebilir.


## v1.1.0 Kategori bazlı kampanya kataloğu

- `Kampanyalar` sekmesi artık kategori seçimiyle çalışır. Akaryakıt, restoran, market, e-ticaret vb. seçildiğinde yalnız o kategorideki **aktif** kampanyalar gösterilir.
- Sonuçlar kullanıcının aktif kartlarına göre gruplanır; aynı kampanya birden fazla kartta geçerliyse ilgili kart gruplarında ayrı görünür.
- Kampanya satırına tıklanınca detay panelinde kazanç/alt limit/tavan, tarih, seçili segment, işyeri veya istasyon kapsamı, POS şartı, ödeme kanalı, yurt içi/yurt dışı, hariç işlemler ve resmi kaynak bağlantısı gösterilir.
- Akaryakıt gibi işyeri kapsamı kritik kategorilerde `Shell`, `Opet` vb. ayrıştırılabilen marka/istasyonlar doğrudan gösterilir. Liste resmi metinden tam ayrıştırılamadıysa **yalnız seçili/anlaşmalı işyerlerinde** uyarısı ve resmi koşul bağlantısı gösterilir; kampanya tüm istasyonlarda geçerli varsayılmaz.
- `Katılım gerekiyor` etiketi yalnız gerçekten katılım gerektiren kampanyalarda görünür. Core/sürekli kart ayrıcalıklarında katılım gerekmiyorsa gereksiz etiket gösterilmez.
- Katalogda ayrıca metin/işyeri araması ve `yalnız detayları tam çözülenler` filtresi vardır.
- Kalan hak ve katılım durumu detay panelinden de güncellenebilir.
- Yeni kampanya-browser regresyon testleri eklendi; toplam JS test grupları + 36 Python crawler/server testi geçmektedir.


## v1.0.9 Core Benefits + son başarılı tam katalog

- Segment/müşteri profiline bağlı **sürekli kart ayrıcalıkları** canlı crawler'dan bağımsız bir core katmanda tutulur. İlk core seti: Wings restoran programı, Maximiles Black restoran, TEB Infinite otel/restoran ve Crystal anlaşmalı otel/restoran.
- Canlı kaynak aynı core avantajı bulduğunda kayıt iki kez gösterilmez; canlı veri işyeri kapsamı/son görülme bilgisini zenginleştirir, doğrulanmış segment finansal kuralını silemez.
- Tarama sırasında oluşan eksik katalog artık karar motoruna verilmez. Ara sonuç `catalog_staging.json` dosyasına yazılır; `catalog.json` yalnız tüm kaynak döngüsü tamamlanınca atomik olarak değiştirilir. Bir kaynak geçici olarak 0 kayıt üretirse varsa o kaynağın son başarılı kayıtları korunur.
- **Katılım gerektiren** kampanyalarda “Katılım gerekiyor” gösterilir ve kullanıcı “Katıldım” diyebilir. Katılım gerektirmeyen core ayrıcalıklarda “Katılım gerekmiyor” etiketi artık gösterilmez.
- Wings program restoran avantajı core'a eklendi: Classic %5/aylık 250 TL, Black %10/aylık 1.250 TL, Black Plus %15/aylık 2.500 TL; 1.000 TL+ restoran işlemi ve program katılımı gerekir.
- Canlı parser sayfası script/ağ nedeniyle çözemese bile doğrulanmış Wings/Maximiles/TEB/Crystal core URL'leri konservatif fallback ile katalogdan kaybolmaz.
- Da Mario / restoran / 6.000 TL regresyonu eklendi: seçili profillerde Crystal ve TEB 1.200 TL teorik, Maximiles Black 600 TL teorik; Wings Black Plus katılım varsa 900 TL teorik avantaj üretir.


## v1.0.8 Dragon/restoran ve canlı kaynak düzeltmeleri

- `Dragon / Restoran / 6.000 TL` tanı logundan çıkan kaynak kapsamı hataları düzeltildi. Bilinmeyen restoran adı, bütün restoranlarda geçerli TEB Infinite/Maximiles Black kampanyalarını artık engellemez.
- TEB Infinite Ultra yurt içi otel/restoran kuralı `merchantScope=all` olarak modellenir; 1.500 TL alt limit, %20 oran, işlem başına 2.000 TL ve aylık 8.000 TL tavan segment kuralından çözülür.
- Maximiles Black restoran kuralı `merchantScope=all` olarak modellenir; 4–8 milyon TL bandında 4.000–7.999,99 TL %10, 8.000 TL+ %20 ve ilgili tavanlar uygulanır.
- Kritik `fallback_urls` artık keşfedilen yüzlerce kampanya linkinden **önce** sıraya alınır. Böylece `max_details` limiti Maximiles Black restoran veya TEB sürekli avantaj sayfasını katalogdan düşüremez.
- Crystal otel/restoran üye işyeri parserı bütün sayfa navigasyonunu merchant listesi sanmak yerine `h2/h3/h4` mekan başlıklarını kullanır.
- Worldcard URL'lerindeki `®`, kıvrık apostrof vb. Unicode karakterleri HTTP isteğinden önce percent-encode edilir; önceki `UnicodeEncodeError` kaynak hatası giderilir.
- Wings resmi alanında, her detay metninin ayrıca `Wings` kelimesini tekrar etmesi zorunluluğu kaldırıldı; açık hariç tutma varsa yine elenir.
- Uygulama artık `/api/version` ile gerçek çalışan servis sürümünü gösterir. Port 8765'te eski bir Banka Kampanya Avcısı `app_server.py` süreci kalmışsa başlatıcı onu güvenli biçimde kapatıp yeni paketi başlatır; başka bir programa ait process otomatik kapatılmaz.
- Canlı katalog sağlık satırı 10 beklenen kaynak grubundan hangisinin rapor vermediğini veya 0 kayıt ürettiğini ayrıca gösterir.
- Regresyon testine Dragon eklendi: 6.000 TL restoran işleminde TEB Ultra teorik 1.200 TL, Maximiles Black 4–8 milyon teorik 600 TL; Crystal ise merchant listesinde değilse reddedilir.
- Testler: 28 Python parser/server testi + JS karar motoru + sadakat testleri geçti.


## v1.0.7 değişiklikleri

- TEB ve benzeri sayfalardaki `script/style/noscript/template` içerikleri kampanya metninden çıkarılır; çerez/JavaScript parçaları artık kampanya koşulu olarak parse edilmez.
- Loader başlıkları (`İşleminiz Devam Ediyor...`) temizlenir.
- `Aylık ise toplam ... TL` dönem tavanı ve `TEB POS` şartı tanınır.
- Özel kampanya eklerken canlı + manuel katalogda olası çift kayıt kontrolü yapılır. Olası eşleşmede mevcut kampanya gösterilir; kullanıcı `Evet, bu kampanyaydı — ekleme` veya `Hayır, farklı kampanya — yine de ekle` seçebilir.
- Service worker cache sürümü yükseltildi; önceki JS/CSS sürümünün tarayıcıda kalma riski azaltıldı.


## Kolay başlatma

ZIP'i çıkardıktan sonra ana klasördeki **`Banka Kampanya Avcisi - BASLAT.bat`** dosyasına çift tıklamanız yeterlidir. `scripts` klasörüne girmeniz gerekmez.

Ana klasörde ayrıca:
- `Kampanyalari Simdi Yenile.bat` — canlı kampanya taramasını hemen çalıştırır.
- `08-18 Otomatik Taramayi Kur.bat` — Windows görev zamanlayıcısına 08:00 ve 18:00 taramalarını kurar.

# Banka Kampanya Avcısı v1.0.4-live

Bu sürüm demo/standalone veri akışından çıkarılmış **yerel canlı sürümdür**. Uygulama açıldığında resmi banka/kart kampanya kaynaklarını tarar, kampanya detay koşullarını yapılandırır ve `Hangi Kart?` ekranında kullanır.

> Güvenlik: kart numarası, CVV, son kullanma tarihi, TCKN, internet/mobil bankacılık parolası veya banka oturum bilgisi için hiçbir veri alanı yoktur.

## Çalıştırma

1. ZIP'i normal bir klasöre çıkarın.
2. `scripts\start_app.bat` dosyasına çift tıklayın.
3. Tarayıcı otomatik olarak `http://127.0.0.1:8765` adresini açar.
4. İlk canlı tarama arka planda başlar. Kaynak sayısına göre birkaç dakika sürebilir.
5. Ana ekrandaki **Canlı katalog** satırında kampanya/kaynak/hata sayısını görebilirsiniz.
6. İsterseniz `Ayarlar > Şimdi yenile` ile aynı taramayı elle başlatabilirsiniz.

`web\standalone.html` artık uygulamanın kendisini çalıştırmaz. Canlı katalog ve özel kampanya servisi gerektiği için v1.0'da `start_app.bat` kullanılmalıdır.

### Python kurulumu gerekmiyor

v1.0.1, `py` komutunun yalnızca var olmasını yeterli saymaz; gerçekten çalışan bir Python 3 yorumlayıcısı olup olmadığını test eder. Bilgisayarda uygun Python yoksa ilk çalıştırmada resmi **python.org** kaynağından Windows x64 embedded/portable Python 3.13.0 paketini indirir ve yalnızca `runtime\python` klasörüne açar.

Bu işlem:

- Windows'a Python kurmaz,
- PATH veya registry değiştirmez,
- yönetici yetkisi istemez,
- Spyder/Anaconda kurulumunu değiştirmez.

İlk çalıştırmada yaklaşık bir kez runtime indirmesi yapılır; sonraki açılışlarda yerel runtime kullanılır.

## 08:00 / 18:00 otomatik tarama

Uygulama açıkken yerel servis 08:00 ve 18:00 taramalarını çalıştırır. Uygulama kapalıyken de tarama yapılmasını istiyorsanız **bir kez**:

`scripts\install_twice_daily_schedule.bat`

çalıştırın. Bu iki Windows zamanlanmış görevi oluşturur. Elle tarama için `scripts\refresh_campaigns_now.bat` kullanılabilir. Planlı tarama logu `server\data\scheduled_refresh.log` dosyasına yazılır.

## Taranan resmi kaynaklar

Canlı kaynak kataloğu yalnızca kullanıcının kartlarına uygulanabilecek kamuya açık kampanyaları toplamaya çalışır:

- **QNB Miles&Smiles QNB** kampanyaları
- **QNB Private** ayrıcalıkları
- **QNB genel kredi kartı** kampanyaları — Miles&Smiles açıkça hariç tutulmuşsa katalogdan çıkarılır
- **Wings** kampanyaları ve Wings Style
- **Axess genel kampanyaları** — yalnızca yasal koşullarda Wings'in açıkça dahil edildiği kampanyalar alınır
- **Maximiles / Maximiles Black / Maximum** bireysel kampanyaları
- **Worldcard** bireysel kampanyaları
- **Yapı Kredi Crystal** anlaşmalı otel/restoran ayrıcalıkları ve işyeri listesi
- **TEB Infinite / Kart Dünyası** ayrıcalıkları
- **TEB genel bireysel kredi kartı** kampanyaları

Tarayıcı kampanya başlığından ibaret veri kullanmaz. Mümkün olduğunda resmi detay/yasal metinden tarih, alt limit, kademeli oran, işlem başı tavan, dönem tavanı, katılım, işyeri/şube, kanal, POS, yurt içi/yurt dışı, işlem sırası, farklı gün ve istisna koşullarını çıkarır.

Bir sayfada segment, kart ağı veya karmaşık toplam-harcama kuralı güvenle çözülemiyorsa kampanya **bilgi amaçlı/kısmi çözüm** olarak tutulur ve kesin kart sıralamasına sokulmaz. Bu, yanlış kesin öneri vermemek için bilinçli davranıştır.

## Kullanıcı profili

Varsayılanlar:

- QNB Miles&Smiles Private — **Private**
- THY Miles&Smiles statüsü — **Classic**
- Wings Elite / Wings Black — **Black Plus / üst segment**
- Maximiles Black — **4–8 milyon TL** varlık bandı
- Crystal — **1 milyon TL altı**
- TEB Özel Infinite — **Ultra**

`Ayarlar` ekranındaki dropdown'lar v1.0'da HTML içinde statik seçeneklerle de tanımlıdır; JavaScript yükleme sorunu olsa bile boş görünmez. THY statüsü ile QNB segmenti, Wings programı, Maximiles Black bandı, Crystal varlık bandı/kart tipi ve TEB Infinite paket seviyesi buradan değiştirilebilir. Segment değişikliği kampanya uygunluğunu ve segment bazlı limitleri anında etkiler; yanlış kalan-limit kullanımı olmasın diye ilgili kampanyaların manuel kalan hakları yeniden doğrulama bekler.

## Kalan kampanya hakkı

Uygulama tüm harcamalarınızı bilmez. Bu nedenle kampanya kalan hakları kullanıcı tarafından doğrulanabilir.

- Kampanya reset kuralına göre ay/dönem başında otomatik başlangıç değeri oluşturulur.
- `Kampanyalar > Güncelle` ile bankadaki gerçek kalan hakkı elle girebilirsiniz.
- Varsayılan olarak 3 günden eski kalan-limit bilgisi **eski** sayılır.
- Eski kalan-limit rakamı ekranda görünür ancak v1.0 karar motoru bunu artık kesin kazanç hesabında kullanmaz; sonuç teorik/koşullu gösterilir.

## Hangi Kart? motoru

Motor şunları birlikte değerlendirir:

- kart ürünü ve segment,
- kampanya tarihi,
- işyeri ve fuzzy/typo eşleşmesi,
- kategori ve işyeri-kategori çelişkisi,
- alt/üst harcama sınırı,
- kademeli ödül,
- işlem başı ve dönem tavanı,
- kampanyaya katılım,
- farklı gün / işlem sırası / toplam dönem harcaması,
- online/fiziki işlem ve yurt içi/yurt dışı,
- POS ve şube koşulları,
- kalan kampanya hakkının güncelliği.

Koşulu sağlamayan ama ilgili kampanyalar kaybolmaz. Örneğin 3.000 TL alt limitli Amazon kampanyasına 2.000 TL işlem girildiğinde **1.000 TL eksik** şeklinde potansiyel kampanya gösterilir.

## Kampanya olmasa da normal kart kazancı

- QNB Miles&Smiles: hesaplanabilen işlemlerde **THY Mil** olarak gösterilir; TL'ye çevrilmez.
- Wings: **Mil Puan** ve yurt içi uçak / yurt dışı uçak / otel-tur-araç kullanımındaki TL karşılıkları gösterilir.
- Maximiles Black: **MaxiMil** ve tanımlı seyahat değeri gösterilir.
- Kampanya ödülleri kendi biriminde gösterilir: TL indirim, chip-para, MaxiPuan, Bonus, Worldpuan, ParaPuan, Mil Puan, THY Mil.

## Bana özel kampanyalar

`Özel kampanya ekle` ekranından mobil uygulamada görünen kişiye özel kampanya **metnini doğrudan yapıştırabilirsiniz**. Kayıt canlı kataloğa eklenir.

Ekran görüntüsünden otomatik OCR/vision çıkarımı **bu v1.0 paketinde henüz bağlı değildir**. Bunun için görüntünün hangi servise gönderileceği ve saklanıp saklanmayacağı ayrıca güvenlik kararı gerektirir; varsayılan olarak hiçbir kişisel ekran görüntüsü üçüncü tarafa gönderilmez.

## Yerel veri ve Supabase

Bu v1.0-live sürümü hemen çalışabilmesi için yerel servis kullanır:

- canlı kampanya kataloğu: `server\data\catalog.json`
- tarama durumu: `server\data\refresh_status.json`
- özel kampanyalar: `server\data\custom_campaigns.json`
- kullanıcı limit/katılım/ayarları: tarayıcının localStorage alanı

Supabase/PostgreSQL şeması `supabase\` klasöründe hazırdır, ancak **henüz herhangi bir Supabase hesabına bağlanmamıştır**. Bu nedenle bu paketi çalıştırmak bir bulut ücreti doğurmaz. Android + merkezi Supabase senkronizasyonu sonraki dağıtım aşamasıdır.

## Testler

Python tarayıcı/parser testleri:

```bat
cd BankaKampanyaAvcisi-v1.0-live
python -m unittest discover -s server\tests -p "test_*.py" -v
```

Web karar motoru:

```bat
cd web
npm test
```

v1.0 regresyon kapsamı QNB hariç tutma, QNB Private/Terminal, Wings, Axess→Wings uygunluğu, Maximiles Black segment kuralları, Crystal, TEB Infinite, TEB genel bireysel kampanyaları, potansiyel kampanya, fuzzy merchant, kategori düzeltme, eski kalan limit ve standart kart kazançlarını içerir.

## Bilinen sınır

Kamuya açık kampanyalar resmi web kaynaklarından taranır. Banka uygulamasına giriş yaptıktan sonra yalnız kullanıcıya gösterilen **kişiye özel** kampanyalar web tarayıcı tarafından görülemez; bunlar `Özel kampanya ekle` üzerinden girilmelidir.


## v1.0.3 düzeltmesi
- Manuel yenileme penceresi artık kaynak ve ilerleme sayılarını gösterir; siyah/boş bekleme yoktur.
- Detay sayfaları paralel okunur; tarama belirgin biçimde hızlanır.
- Her banka kaynağı tamamlandığında kısmi katalog yazılır; uygulama açıkken kampanya sayısı otomatik artar.
- Uygulama, ayrı BAT ile yapılan taramanın durumunu 3 saniyede bir izler ve katalog bittiğinde yeniden yükler.
- Sitemap yalnızca liste sayfası yetersiz kaldığında kullanılır; eski arşiv sayfalarını gereksiz tarama azaltıldı.


## v1.0.4 segment profili düzeltmesi
- Tüm banka/kart segmentleri Ayarlar ekranına eklendi: QNB, Wings, Maximiles Black, Crystal ve TEB Infinite.
- Crystal için ayrıca `Crystal / Metal Crystal` kart tipi seçimi eklendi.
- Segment seçimi artık yalnızca etiketi değiştirmez; segment-kuralı bulunan kampanyalarda oran, işlem tavanı ve dönem tavanı seçili profile göre çözülür.
- Segment değiştiğinde eski manuel kalan-limit değerleri kesin kabul edilmez; ilgili kampanyalar yeniden doğrulama bekler.
- TEB otel/restoran ve e-ticaret, Maximiles Black restoran/otel/otopark ve Crystal otel/restoran kuralları çoklu segment yapısına geçirildi.
- Supabase şemasına tüm segment seçimleri için migration `005_all_segment_profiles.sql` eklendi.

## v1.0.5 yenileme düzeltmesi
- Uygulama açılışında bir tarama zaten sürüyorsa `Şimdi yenile` artık bağlantı hatası göstermez; mevcut taramayı izler.
- `/api/refresh` taramayı arka planda başlatır ve HTTP isteğini dakikalarca açık tutmaz.
- Uygulama, manuel BAT ve zamanlanmış görev aynı `refresh.lock` korumasını kullanır; iki Python süreci `catalog.json` dosyasına aynı anda yazamaz.
- `Kampanyalari Simdi Yenile.bat`, uygulama açıksa mevcut/başlatılan taramanın ilerlemesini konsolda gösterir.
- Paket nötr `never_run` durumu ile gelir; eski bir `running` durumu paketlenmez.

## v1.0.6-live düzeltmeleri
- Migros gibi bilinen işyerlerinde otomatik kategori, kampanya sayfalarındaki gürültülü metinden değil güvenilir işyeri sözlüğünden alınır.
- Kullanıcı manuel kategori seçtiğinde, katalogdaki belirsiz kategori çıkarımı artık seçimi bloke etmez. Yalnızca güvenilir işyeri sözlüğü açık bir çelişki tespit ederse kategori düzeltilir.
- Genel "Kampanyalar"/hub sayfalarının gerçek kampanya gibi kataloğa girmesi engellendi.
- "Moda Deniz Kulübü Restoranlarında..." ve "World Cinezone sinema büfelerindeki..." gibi merchant-özel başlıklarda merchant kapsamı çıkarılır; bütün restoranlarda geçerliymiş gibi davranılmaz.
- Hangi Kart? ekranına "Tanı logunu indir" eklendi. Son sorgunun girdi çözümlemesi, kampanya kabul/red nedenleri, merchant scope, kategori ve resmi kaynak URL'leri JSON dosyasına yazılır. Hassas kart/banka giriş bilgisi loglanmaz.

## v1.2.0-pwa

Bu paket installable PWA katmanını ekler:
- Android/iPhone ana ekrana kurulum manifesti ve ikonlar
- offline app-shell cache
- mobil alt navigasyon
- ağ/kurulum durumu
- yerel API → Supabase katalog snapshot → statik katalog fallback zinciri
- Supabase Auth ile kişisel ayar/limit/katılım/özel kampanya senkronu
- `supabase/migrations/006_pwa_cloud.sql`
- `server/publish_supabase.py`
- 08:00 / 18:00 Türkiye saati için örnek GitHub Pages workflow'u

Canlı internette kurulabilen PWA için HTTPS hosting gerekir. Ayrıntılar: `PWA_KURULUM.md`.
