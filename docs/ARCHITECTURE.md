# Mimari — Banka Kampanya Avcısı

## Amaç
Kullanıcının sahip olduğu kart ürünleri ve segmentlerini, aktif kampanyaları, katılım durumunu ve kullanıcı tarafından doğrulanan kalan kampanya haklarını tek yerde birleştirip harcama anında karar desteği vermek.

## Güven varsayımı
Sistem kullanıcının tüm harcamalarını bilmez. Kullanıcı kartı uygulama dışında kullanabilir. Bu nedenle `remaining_limit` değeri ya kullanıcı tarafından doğrulanır ya da açıkça tahmini/reset kaynaklı olarak etiketlenir. Bilinmeyen limit kesin kazanç hesabına dönüştürülmez.

## Katmanlar
1. **Mobil uygulama (Flutter)** — kart/kampanya görünümü, manuel limit doğrulama, katılım durumu, “Hangi Kart?” ekranı.
2. **Supabase/PostgreSQL** — merkezi katalog ve kullanıcıya ait durum verileri. RLS ile kullanıcı verisi ayrılır.
3. **Kampanya tarama worker'ı (Python)** — resmi banka sayfalarını izler. v0.1 değişiklik tespiti ve snapshot alır; banka-bazlı parser'lar sonraki sürümde eklenir.
4. **Bildirim katmanı (sonraki sürüm)** — yeni kampanya, katılım gereksinimi, bitiş tarihi ve eski limit uyarıları.

## Reset mantığı
- `monthly`: yeni takvim ayına geçildiğinde yeni dönem anahtarı oluşur ve bilinen dönem tavanı başlangıç kalan hak olarak atanır.
- `campaign`: kampanya başlangıç/bitiş çifti dönem kimliğidir. Yeni kampanya örneği yeni dönemdir.
- `none`: otomatik reset yoktur.

Her otomatik reset audit event üretmeye uygun tasarlanmıştır. Kullanıcı manuel olarak kalan limiti her zaman değiştirebilir ve bu değer `user_confirmed` olarak işaretlenir.

## Öneri motoru v0.1
Desteklenen ödül tipleri:
- yüzde indirim/puan
- sabit ödül
- kademeli yüzde

İşlem başı tavan ve dönem kalan limiti uygulanır. Katılım gereken kampanyada katılım durumu `joined` değilse kampanya teorik olarak gösterilebilir fakat önerilen net avantaj 0 kabul edilir. Bir kartta birden fazla kampanya varsa v0.1 yalnızca en iyi tek kampanyayı seçer; kampanya birleştirme/stacking sonraki sürüm konusudur.
