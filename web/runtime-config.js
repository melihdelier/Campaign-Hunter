// Banka Kampanya Avcısı — Supabase istemci ayarları.
// Publishable key tarayıcı/mobil istemcide kullanılmak üzere tasarlanmıştır.
// Secret/service_role anahtarını ASLA bu dosyaya koyma.
window.BKA_CONFIG = Object.assign({
  supabaseUrl: 'https://znlxukwxrubpzfgyhadp.supabase.co',
  supabaseAnonKey: 'sb_publishable_NR4lFFsrwKBeckiFlQ_h7Q_JSzWcSDY',
  catalogMode: 'auto', // local -> Supabase -> statik son katalog
  refreshWebhookUrl: ''
}, window.BKA_CONFIG || {});
