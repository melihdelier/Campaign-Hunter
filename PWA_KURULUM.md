# Banka Kampanya Avcısı — PWA kurulumu (v1.2.0)

Bu sürüm PWA olarak kurulabilir. Kart numarası, CVV, son kullanma tarihi veya banka giriş bilgisi için alan yoktur.

## 1. Supabase (ücretsiz katman)

1. Supabase'te bir proje oluştur.
2. SQL Editor'da `supabase/migrations/001_init.sql` ile başlayıp `006_pwa_cloud.sql` dahil tüm migration dosyalarını sırayla çalıştır.
3. Project Settings > API bölümünden yalnızca:
   - Project URL
   - anon / publishable key
   bilgilerini PWA tarafına koyabilirsin. Bunlar istemci anahtarlarıdır.
4. `service_role` anahtarını tarayıcıya, telefona veya `web/runtime-config.js` dosyasına koyma.

`web/runtime-config.js` örneği:

```js
window.BKA_CONFIG = {
  supabaseUrl: 'https://PROJE.supabase.co',
  supabaseAnonKey: 'ANON_PUBLISHABLE_KEY',
  catalogMode: 'auto',
  refreshWebhookUrl: ''
};
```

## 2. HTTPS hosting

PWA kurulumu için uygulamanın HTTPS adresinden açılması gerekir. `web/` klasörü tamamen statiktir ve GitHub Pages, Cloudflare Pages, Netlify veya Vercel'de yayınlanabilir.

Pakette `.github/workflows/pwa-pages.yml` hazırdır. GitHub Pages kullanılacaksa repo ayarlarında Pages kaynağını GitHub Actions yap.

Repository Variables:
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- isteğe bağlı `REFRESH_WEBHOOK_URL`

Repository Secret:
- `SUPABASE_SERVICE_ROLE_KEY`

Service-role secret yalnız GitHub runner'da Python crawler'ın oluşturduğu katalog snapshot'ını Supabase'e yazmak için kullanılır; PWA'ya gönderilmez.

Workflow Türkiye saatiyle yaklaşık 08:00 ve 18:00'de crawler'ı çalıştırır ve güncel `web/data/catalog.json` ile PWA'yı yeniden yayınlar.

## 3. Telefona kurma

### Android
1. HTTPS PWA adresini Chrome ile aç.
2. Uygulamadaki **Telefona kur** düğmesine veya Chrome menüsündeki **Uygulamayı yükle** seçeneğine dokun.
3. Ana ekrandan normal uygulama gibi aç.

### iPhone
1. HTTPS PWA adresini Safari ile aç.
2. Paylaş menüsü > **Ana Ekrana Ekle**.

## 4. Cihazlar arası kişisel veri

Ayarlar > **Bulut ve cihazlar arası senkron** bölümünde e-posta/şifre ile Supabase Auth hesabı oluşturulabilir.

Buluta taşınanlar:
- THY/QNB/Wings/Maximiles/Crystal/TEB segment ayarları
- kampanya kalan limit / katılım durumu
- kullanıcıya özel eklenen kampanyalar

Buluta taşınmayanlar:
- kart numarası / PAN
- CVV
- son kullanma tarihi
- banka şifresi
- banka oturum/token bilgileri

İlk sürümde buluta gönderme/alma kullanıcı tarafından düğmeyle yapılır; sessiz çatışma çözümü yapılmaz.
