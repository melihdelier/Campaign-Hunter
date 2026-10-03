// v1.3 bilgi mimarisi: 3 ana sekme (Hangi Kart? · Kampanyalar · Profil) + alt sayfalar.
// Saf modül (DOM yok): hash → görünüm eşlemesi. app.js görünümleri bu tabloya göre gösterir; testler doğrudan kullanır.
export const DEFAULT_ROUTE = '#/hangi-kart';

export const PRIMARY_TABS = [
  { tab: 'recommend', href: '#/hangi-kart', label: 'Hangi Kart?', primary: true },
  { tab: 'campaigns', href: '#/kampanyalar', label: 'Kampanyalar' },
  { tab: 'profile', href: '#/profil', label: 'Profil' },
];

// view = <section id> (mevcut id'ler korunur: dashboard = eski Özet, privateCampaign = eski Ekle)
export const ROUTES = {
  '#/hangi-kart':           { view: 'recommend',       tab: 'recommend', title: 'Hangi Kart?' },
  '#/kampanyalar':          { view: 'campaigns',       tab: 'campaigns', title: 'Kampanyalar' },
  '#/kampanyalar/ekle':     { view: 'privateCampaign', tab: 'campaigns', title: 'Kampanya ekle', parent: '#/kampanyalar' },
  '#/profil':               { view: 'profile',         tab: 'profile',   title: 'Profil' },
  '#/profil/kartlar':       { view: 'profileCards',    tab: 'profile',   title: 'Bankalarım ve Kartlarım', parent: '#/profil' },
  '#/profil/musteri':       { view: 'profileSegments', tab: 'profile',   title: 'Müşteri Profili', parent: '#/profil' },
  '#/profil/tercihler':     { view: 'profilePrefs',    tab: 'profile',   title: 'Tercihler', parent: '#/profil' },
  '#/profil/veriler':       { view: 'dashboard',       tab: 'profile',   title: 'Veriler ve Özet', parent: '#/profil' },
  '#/profil/hesap':         { view: 'profileAccount',  tab: 'profile',   title: 'Hesap', parent: '#/profil' },
  '#/profil/info':          { view: 'profileInfo',     tab: 'profile',   title: 'Uygulama Bilgisi', parent: '#/profil' },
  // v1.4 hesap akışı (ana menü gizli)
  '#/giris':                { view: 'authView',          tab: null, title: 'Giriş', gate: true },
  '#/kurulum':              { view: 'onboardingView',    tab: null, title: 'Profilini oluştur', gate: true },
  '#/durum':                { view: 'accountStatusView', tab: null, title: 'Hesap', gate: true },
};

// Hesap durumuna göre gidilebilecek route. Saf fonksiyon (testlerde doğrudan kullanılır).
// account.mode: 'legacy' (bulut yok / şema yok → eski tek-kullanıcı davranışı) | 'profile'
// account.state: 'signed_out' | 'loading' | 'error' | 'needs_onboarding' | 'ready'
export function guardRoute(route, account = { mode: 'legacy' }) {
  const go = hash => ({ hash, ...ROUTES[hash], redirected: true });
  if (!account || account.mode !== 'profile') return route.gate ? go(DEFAULT_ROUTE) : route;
  switch (account.state) {
    case 'signed_out': return route.hash === '#/giris' ? route : go('#/giris');
    case 'loading':
    case 'error': return route.hash === '#/durum' ? route : go('#/durum');
    case 'needs_onboarding': return route.hash === '#/kurulum' ? route : go('#/kurulum');
    case 'ready': return route.gate ? go(DEFAULT_ROUTE) : route;
    default: return go('#/durum');
  }
}

// Eski sekme adları / yer imleri için uyumluluk.
const ALIASES = {
  '#dashboard': '#/profil/veriler', '#/ozet': '#/profil/veriler',
  '#recommend': '#/hangi-kart', '#campaigns': '#/kampanyalar',
  '#privateCampaign': '#/kampanyalar/ekle', '#/ekle': '#/kampanyalar/ekle',
  '#settings': '#/profil', '#/ayarlar': '#/profil',
};

export function resolveRoute(hash) {
  const raw = String(hash || '').trim();
  const key = raw.replace(/\/+$/, '');
  const target = ROUTES[key] ? key : (ALIASES[key] || DEFAULT_ROUTE);
  return { hash: target, ...ROUTES[target], redirected: target !== key };
}
