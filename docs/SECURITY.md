# Güvenlik sınırı

Bu proje bir bankacılık uygulaması değildir; kampanya karar destek uygulamasıdır.

## Bilerek tutulmayan veriler
- kart numarası / PAN
- CVV/CVC
- son kullanma tarihi
- kart şifresi / PIN
- internet/mobil bankacılık kullanıcı adı veya şifresi
- banka oturum çerezi/token'ı
- SMS doğrulama kodu

## Tutulan kullanıcı verileri
- banka ve kart ürün adı
- müşteri/varlık segment etiketi
- kampanyaya katılım durumu
- kalan/kullanılan kampanya hakkı
- son kullanıcı doğrulama zamanı
- kullanıcı tarafından eklenen özel kampanya metni (ileriki sürüm)

## Anahtar yönetimi
Mobil istemci yalnızca Supabase public/anon (publishable) anahtarı kullanabilir. `service_role` anahtarı mobil/web uygulamaya asla gömülmez; yalnızca sunucu worker ortamında saklanır.
