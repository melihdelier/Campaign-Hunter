# Supabase kurulumu

1. Supabase'te yeni bir Free proje oluştur.
2. SQL Editor içinde `migrations/001_init.sql` dosyasını çalıştır.
3. Authentication > Providers bölümünde e-posta ile giriş açık kalabilir.
4. Mobil uygulamaya yalnızca `Project URL` ve **anon/publishable key** konur.
5. `service_role` anahtarı **asla telefona veya web uygulamasına konmaz**. Kampanya tarayıcı servisi gerekiyorsa yalnızca sunucu ortam değişkeni olarak kullanır.

## Tasarım notu
Şemada PAN/kart numarası, CVV, son kullanma tarihi, banka şifresi veya banka oturum belirteci tutacak alan bulunmaz.

`remaining_limit = NULL` kullanımı bilinçlidir: limit bilinmiyorsa uygulama teorik avantajı gösterebilir ancak bunu kesin kazanç olarak sunmaz.
