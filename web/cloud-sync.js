const SESSION_KEY = 'bka-supabase-session-v1';

function cfg() {
  const c = window.BKA_CONFIG || {};
  return {
    supabaseUrl: String(c.supabaseUrl || '').replace(/\/+$/, ''),
    supabaseAnonKey: String(c.supabaseAnonKey || ''),
    catalogMode: c.catalogMode || 'auto',
    refreshWebhookUrl: String(c.refreshWebhookUrl || '')
  };
}

export function cloudConfigured() {
  const c = cfg();
  return Boolean(c.supabaseUrl && c.supabaseAnonKey);
}

function authHeaders(token) {
  const c = cfg();
  // Yeni Supabase sb_publishable_* anahtarları JWT değildir.
  // API anahtarı yalnız `apikey` başlığında gider; Authorization yalnız
  // gerçek kullanıcı oturumu JWT'si varsa eklenir.
  const headers = { 'apikey': c.supabaseAnonKey, 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function decodeJwt(token) {
  try {
    const p = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const s = decodeURIComponent(atob(p).split('').map(ch => `%${('00'+ch.charCodeAt(0).toString(16)).slice(-2)}`).join(''));
    return JSON.parse(s);
  } catch { return {}; }
}

export function getStoredSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; }
}

function storeSession(s) {
  if (!s) localStorage.removeItem(SESSION_KEY);
  else localStorage.setItem(SESSION_KEY, JSON.stringify(s));
}

async function refreshSessionIfNeeded() {
  let s = getStoredSession();
  if (!s?.access_token) return null;
  const exp = Number(s.expires_at || decodeJwt(s.access_token).exp || 0);
  const now = Math.floor(Date.now()/1000);
  if (exp && exp > now + 60) return s;
  if (!s.refresh_token || !cloudConfigured()) return s;
  const c = cfg();
  const res = await fetch(`${c.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
    method:'POST', headers: authHeaders(), body: JSON.stringify({ refresh_token:s.refresh_token })
  });
  const out = await res.json().catch(()=>({}));
  if (!res.ok) { storeSession(null); throw new Error(out.msg || out.error_description || out.message || `Oturum yenilenemedi (HTTP ${res.status})`); }
  s = { ...out, expires_at: Math.floor(Date.now()/1000) + Number(out.expires_in || 3600) };
  storeSession(s); return s;
}

export async function signUp(email, password) {
  if (!cloudConfigured()) throw new Error('Supabase bağlantısı yapılandırılmadı.');
  const c = cfg();
  const res = await fetch(`${c.supabaseUrl}/auth/v1/signup`, {
    method:'POST', headers: authHeaders(), body: JSON.stringify({email, password})
  });
  const out = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error(out.msg || out.error_description || out.message || `Kayıt başarısız (HTTP ${res.status})`);
  if (out.access_token) storeSession({...out, expires_at:Math.floor(Date.now()/1000)+Number(out.expires_in||3600)});
  return out;
}

export async function signIn(email, password) {
  if (!cloudConfigured()) throw new Error('Supabase bağlantısı yapılandırılmadı.');
  const c = cfg();
  const res = await fetch(`${c.supabaseUrl}/auth/v1/token?grant_type=password`, {
    method:'POST', headers: authHeaders(), body: JSON.stringify({email, password})
  });
  const out = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error(out.msg || out.error_description || out.message || `Giriş başarısız (HTTP ${res.status})`);
  storeSession({...out, expires_at:Math.floor(Date.now()/1000)+Number(out.expires_in||3600)});
  return out;
}

export function signOut() { storeSession(null); }

export async function sessionInfo() {
  const s = await refreshSessionIfNeeded();
  if (!s?.access_token) return { signedIn:false };
  const p = decodeJwt(s.access_token);
  return { signedIn:true, userId:p.sub || s.user?.id || null, email:p.email || s.user?.email || null };
}


export async function testCloudConnection() {
  if (!cloudConfigured()) throw new Error('Supabase bağlantısı yapılandırılmadı.');
  const c = cfg();
  // Snapshot satırının henüz bulunmaması bağlantı hatası değildir; [] geçerli cevaptır.
  const res = await fetch(`${c.supabaseUrl}/rest/v1/catalog_snapshots?select=id,updated_at&limit=1`, {
    headers: authHeaders(), cache:'no-store'
  });
  const out = await res.json().catch(()=>null);
  if (!res.ok) throw new Error(out?.message || out?.error || `Supabase bağlantı testi başarısız (HTTP ${res.status})`);
  return { ok:true, snapshotPresent:Array.isArray(out) && out.length>0, snapshotUpdatedAt:out?.[0]?.updated_at || null };
}

export async function fetchCloudCatalog() {
  if (!cloudConfigured()) return null;
  const c = cfg();
  const res = await fetch(`${c.supabaseUrl}/rest/v1/catalog_snapshots?id=eq.1&select=payload,updated_at&limit=1`, {
    headers: authHeaders(), cache:'no-store'
  });
  if (!res.ok) throw new Error(`Bulut kataloğu alınamadı (HTTP ${res.status})`);
  const rows = await res.json();
  return rows?.[0]?.payload || null;
}

export async function fetchCloudUserState() {
  if (!cloudConfigured()) throw new Error('Supabase bağlantısı yapılandırılmadı.');
  const s = await refreshSessionIfNeeded();
  if (!s?.access_token) throw new Error('Önce bulut hesabına giriş yap.');
  const p = decodeJwt(s.access_token); const uid = p.sub || s.user?.id;
  if (!uid) throw new Error('Kullanıcı kimliği okunamadı.');
  const c = cfg();
  const res = await fetch(`${c.supabaseUrl}/rest/v1/user_app_state?user_id=eq.${encodeURIComponent(uid)}&select=settings,campaign_states,private_campaigns,updated_at&limit=1`, {
    headers: authHeaders(s.access_token), cache:'no-store'
  });
  if (!res.ok) throw new Error(`Bulut verisi alınamadı (HTTP ${res.status})`);
  const rows = await res.json();
  return rows?.[0] || null;
}

export async function saveCloudUserState(payload) {
  if (!cloudConfigured()) throw new Error('Supabase bağlantısı yapılandırılmadı.');
  const s = await refreshSessionIfNeeded();
  if (!s?.access_token) throw new Error('Önce bulut hesabına giriş yap.');
  const p = decodeJwt(s.access_token); const uid = p.sub || s.user?.id;
  if (!uid) throw new Error('Kullanıcı kimliği okunamadı.');
  const c = cfg();
  const body = {
    user_id: uid,
    settings: payload.settings || {},
    campaign_states: payload.campaignStates || {},
    private_campaigns: payload.privateCampaigns || [],
    updated_at: new Date().toISOString()
  };
  const res = await fetch(`${c.supabaseUrl}/rest/v1/user_app_state?on_conflict=user_id`, {
    method:'POST', headers:{...authHeaders(s.access_token),'Prefer':'resolution=merge-duplicates,return=representation'}, body:JSON.stringify(body)
  });
  const out = await res.json().catch(()=>[]);
  if (!res.ok) throw new Error(out?.message || `Buluta kaydedilemedi (HTTP ${res.status})`);
  return out?.[0] || body;
}

export async function triggerCloudRefresh() {
  const c = cfg();
  if (!c.refreshWebhookUrl) return { configured:false };
  const res = await fetch(c.refreshWebhookUrl, {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'});
  const out = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error(out?.message || `Bulut yenileme başlatılamadı (HTTP ${res.status})`);
  return {configured:true, ...out};
}

export function cloudConfigSummary() {
  const c = cfg();
  return { configured:cloudConfigured(), url:c.supabaseUrl, catalogMode:c.catalogMode, refreshConfigured:Boolean(c.refreshWebhookUrl) };
}
