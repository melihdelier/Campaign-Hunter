# Supabase bağlantısı — v1.2.1-supabase

Bu paket aşağıdaki Supabase projesine bağlanacak şekilde hazırlanmıştır:

- Project URL: `https://znlxukwxrubpzfgyhadp.supabase.co`
- İstemci anahtarı: `sb_publishable_...` (web/runtime-config.js içinde)

Publishable key istemci uygulamalarında kullanılmak üzere tasarlanmıştır. Secret/service_role anahtarını web klasörüne koymayın.

## İlk test

1. `Banka Kampanya Avcisi - BASLAT.bat` ile uygulamayı açın.
2. **Ayarlar > Bulut ve cihazlar arası senkron** bölümüne gidin.
3. Üstte `Supabase bağlantısı doğrulandı` mesajını görmelisiniz.
4. Kendi e-posta adresiniz ve en az 8 karakterlik bir şifreyle **Hesap oluştur** seçin.
5. Supabase e-posta doğrulaması açıksa gelen e-postadaki bağlantıyı onaylayın, sonra uygulamada **Giriş yap** seçin.
6. `Bu cihazı buluta gönder` ile segment/limit/katılım/özel kampanya verisini kaydedin.
7. Ardından `Buluttan bu cihaza al` ile geri okuyarak senkronu test edin.

## Bulut kataloğu

`catalog_snapshots` tablosu ilk kurulumda boş olabilir. Bu normaldir. Mobil PWA'ya geçmeden önce sunucu crawler'ının son başarılı tam kataloğunu buraya yayınlayacağız. Bunun için backend tarafında yalnız sunucuda saklanan `sb_secret_...` anahtarı kullanılacaktır.

## Hassas bilgiler

PWA'ya veya frontend dosyalarına şunları koymayın:
- database password
- `sb_secret_...`
- legacy `service_role`
- banka kullanıcı adı/şifresi
- kart numarası/CVV/son kullanma tarihi
