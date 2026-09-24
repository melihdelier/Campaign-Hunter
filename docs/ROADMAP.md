# Geliştirme yol haritası

## v0.1 — bu paket
- Kart profili seed'i
- DEMO kampanyalar
- manuel kalan limit güncelleme
- katılım durumu
- aylık/kampanya dönemi reseti
- kalan limit bilinmiyorsa belirsizlik uyarısı
- “Hangi Kart?” karar motoru
- Supabase şeması + RLS
- resmi kaynak değişiklik takip worker'ı
- tarayıcıda tek dosya çalışan prototip

## v0.2
- Supabase'e gerçek bağlantı
- kullanıcı oturumu
- gerçek kart/kampanya katalog senkronizasyonu
- ilk banka parser'ı (öneri: Maximiles, yapısı nispeten açık)
- gerçek kampanyalarda “inceleme bekliyor / onaylı” durumu

## v0.3
- QNB/Wings/Crystal/TEB parser'ları
- sana özel kampanya ekleme ekranı
- kampanya ekran görüntüsü/metin işleme akışı
- bitiş ve katılım bildirimleri

## v0.4
- kampanya stacking/birleşebilirlik kuralları
- işyeri bazlı kapsam listeleri
- puan/mil için kullanıcı tanımlı TL eşdeğeri
- geçmiş dönem analizi


## v0.6 sonrası öncelik
- QNB resmi Mil Hesaplama Aracı için otomatik oran adapter'ı
- tüm aktif kampanya discovery + detail parser kapsamını genişletme
- anlaşmalı işyeri/şube kataloglarını tam senkronize etme
- özel kampanya metni yapıştırma + ekran görüntüsü ekleme/onay akışı
- Flutter Android ekranlarını web v0.6 ile özellik eşitliğine getirme
- Supabase gerçek bağlantı ve bulut scheduler kurulumu
