# Yenileme Politikası

Varsayılan tarama: Europe/Istanbul saat diliminde 08:00 ve 18:00. Kullanıcı ayrıca Ayarlar ekranından veya ana klasördeki `Kampanyalari Simdi Yenile.bat` ile manuel yenileme başlatabilir.

## Son başarılı tam katalog

v1.0.9 itibarıyla tarama sırasında karar motorunun kullandığı `catalog.json` değiştirilmez. Her kaynak tamamlandıkça ara sonuçlar `catalog_staging.json` dosyasına yazılır ve yalnızca ilerleme/tanı amacı taşır. Tüm kaynak döngüsü tamamlandığında yeni katalog atomik olarak `catalog.json` olur.

Bir kaynak geçici olarak kullanılabilir kayıt üretemezse, varsa o kaynağa ait son başarılı kayıtlar korunur ve kaynak raporuna uyarı eklenir. Böylece bir bankanın sitesi geçici olarak hata verdi diye o bankanın bilinen kampanyaları karar ekranından kaybolmaz.

## Sürekli kart ayrıcalıkları

Segment/müşteri profiline bağlı, banka tarafından sürekli sunulan ve kullanıcı kararında temel olan avantajlar ayrıca `coreBenefit` olarak istemci başlangıç verisinde tutulur. Canlı tarama bu kayıtların güncelliğini ve kapsamını zenginleştirir; tarama hatası core kaydı silemez.

Katılım gereken avantajlarda uygulama `Katılım gerekiyor` gösterir. Katılım gerektirmeyen sürekli ayrıcalıklarda gereksiz bir `Katılım gerekmiyor` etiketi gösterilmez.
