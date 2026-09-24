# Flutter mobil uygulama — v0.1 kaynak kodu

Bu klasör mobil uygulamanın platformdan bağımsız Flutter kaynak kodunu içerir. Mevcut çalıştırma ortamında Flutter SDK bulunmadığı için burada APK üretilemedi; ancak kod yalnızca Flutter SDK bileşenlerini kullanır ve harici paket bağımlılığı yoktur.

## Android/iOS platform kabuklarını üretme
Flutter kurulu bir bilgisayarda bu klasörde:

```bash
flutter create --platforms=android,ios --project-name banka_kampanya_avcisi .
flutter pub get
flutter run
```

İlk sürüm yerel DEMO veri ile çalışır. Supabase şeması paket içindeki `../supabase` klasöründedir. Sonraki sürümde repository katmanına Supabase bağlantısı eklenecek.

## Güvenlik
Uygulama modelinde kart numarası, CVV, son kullanma tarihi veya banka giriş bilgisi alanı yoktur.
