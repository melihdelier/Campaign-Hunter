// Paylaşılan SAHTE Supabase (Auth + PostgREST) — e2e testleri için. Gerçek RLS: server/tests/test_supabase_rls.py.
import { BUNDLED_PROFILE_CATALOG as CAT } from '../profile-catalog.js';
import { normalizeBankRequestName } from '../bank-requests.js';

// ------------------------------------------------------------------ sahte Supabase
export const SUPA = 'https://mock.supabase.test';
export const criteriaRows = list => list.map(r => ({ dimension_code: r.dimensionCode, option_code: r.optionCode, criteria_version: r.criteriaVersion,
  effective_from: r.effectiveFrom, effective_to: r.effectiveTo, display_label: r.displayLabel, lower_bound: r.lowerBound, upper_bound: r.upperBound,
  bound_unit: r.boundUnit, source_url: r.sourceUrl, source_reference: r.sourceReference, verified_at: r.verifiedAt }));
export function makeMock() {
  const m = { users: [], refresh: new Map(), revoked: [], fail: null, schemaMissing: false, t: {}, authRequests: [], requireEmailConfirmation: false };
  const banks = CAT.banks.map((b, i) => ({ id: `b-${b.code}`, code: b.code, name: b.name, sort_order: b.sortOrder, active: true }));
  const cards = CAT.cardProducts.map(c => ({ id: `c-${c.code}`, code: c.code, name: c.name, family: c.family, sort_order: c.sortOrder, active: true, bank_id: `b-${c.bankCode}`, program_code: c.programCode ?? null }));
  m.master = {
    banks, card_products: cards,
    profile_dimensions: CAT.dimensions.map(d => ({ code: d.code, label: d.label, kind: d.kind, bank_id: d.bankCode ? `b-${d.bankCode}` : null, engine_binding: d.engineBinding, setting_key: d.settingKey, sort_order: d.sortOrder, active: true })),
    profile_dimension_cards: CAT.dimensions.flatMap(d => d.cardCodes.map(c => ({ dimension_code: d.code, card_product_id: `c-${c}` }))),
    profile_dimension_options: CAT.dimensions.flatMap(d => d.options.map(o => ({ dimension_code: d.code, code: o.code, label: o.label, engine_label: o.engineLabel, sort_order: o.sortOrder, active: true }))),
    profile_option_criteria: criteriaRows(CAT.optionCriteria),
    card_programs: CAT.cardPrograms.map(p => ({ code: p.code, bank_id: `b-${p.bankCode}`, name: p.name, source_url: p.sourceUrl, verified_at: p.verifiedAt, sort_order: p.sortOrder, active: true })),
    bank_coverage: CAT.bankCoverage.map(c => ({ bank_id: `b-${c.bankCode}`, card_products: c.cardProducts, profile_dimensions: c.profileDimensions, core_benefits: c.coreBenefits, campaigns: c.campaigns, note: c.note })),
    catalog_snapshots: [],
  };
  for (const t of ['profiles', 'user_banks', 'user_cards', 'user_profile_attributes', 'user_preferences', 'user_app_state', 'bank_support_requests']) m.t[t] = [];
  const jwt = u => `h.${Buffer.from(JSON.stringify({ sub: u.id, email: u.email, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.s`;
  m.session = u => { const rt = `rt-${u.id}-${Math.random().toString(36).slice(2)}`; m.refresh.set(rt, u.id); return { access_token: jwt(u), refresh_token: rt, expires_in: 3600, token_type: 'bearer', user: { id: u.id, email: u.email } }; };
  m.uidFromAuth = h => { try { return JSON.parse(Buffer.from(String(h || '').split(' ')[1].split('.')[1], 'base64url').toString()).sub; } catch { return null; } };
  return m;
}

export async function handle(route, mock) {
  const req = route.request();
  const url = new URL(req.url());
  const method = req.method();
  const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: body === undefined ? '' : JSON.stringify(body) });
  const body = req.postData() ? JSON.parse(req.postData()) : null;
  if (url.pathname.startsWith('/auth/v1/')) mock.authRequests.push({ path: url.pathname, redirectTo: url.searchParams.get('redirect_to'), body });
  if (url.pathname === '/auth/v1/recover') return json(200, {});
  if (url.pathname === '/auth/v1/signup' && mock.requireEmailConfirmation) {
    if (mock.users.some(u => u.email === body.email)) return json(400, { msg: 'User already registered' });
    const u = { id: `00000000-0000-4000-8000-${String(mock.users.length + 1).padStart(12, '0')}`, email: body.email, password: body.password };
    mock.users.push(u); return json(200, { id: u.id, email: u.email, confirmation_sent_at: new Date().toISOString() }); // oturum yok: e-posta doğrulaması gerekli
  }
  if (url.pathname === '/auth/v1/signup') {
    if (mock.users.some(u => u.email === body.email)) return json(400, { msg: 'User already registered' });
    const u = { id: `00000000-0000-4000-8000-${String(mock.users.length + 1).padStart(12, '0')}`, email: body.email, password: body.password };
    mock.users.push(u); return json(200, mock.session(u));
  }
  if (url.pathname === '/auth/v1/token') {
    if (url.searchParams.get('grant_type') === 'password') {
      const u = mock.users.find(x => x.email === body.email && x.password === body.password);
      return u ? json(200, mock.session(u)) : json(400, { error_description: 'Invalid login credentials' });
    }
    const uid = mock.refresh.get(body.refresh_token); const u = mock.users.find(x => x.id === uid);
    return u ? json(200, mock.session(u)) : json(400, { error_description: 'Invalid Refresh Token' });
  }
  if (url.pathname === '/auth/v1/logout') { const uid = mock.uidFromAuth(req.headers().authorization); mock.revoked.push(uid); for (const [k, v] of mock.refresh) if (v === uid) mock.refresh.delete(k); return route.fulfill({ status: 204, body: '' }); }
  if (!url.pathname.startsWith('/rest/v1/')) return json(404, {});
  const table = url.pathname.slice('/rest/v1/'.length);
  if (mock.fail && table !== 'catalog_snapshots') return route.abort('internetdisconnected');
  if (mock.schemaMissing && ['profiles', 'profile_dimensions', 'banks', 'card_products', 'profile_dimension_cards', 'profile_dimension_options', 'profile_option_criteria', 'user_banks', 'user_cards', 'user_profile_attributes', 'user_preferences'].includes(table)) {
    return json(404, { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` });
  }
  if (mock.master[table]) return method === 'GET' ? json(200, mock.master[table]) : json(403, { code: '42501', message: 'permission denied' });
  const uid = mock.uidFromAuth(req.headers().authorization);
  if (!uid) return json(401, { message: 'JWT required' });
  const rows = mock.t[table];
  if (!rows) return json(404, { code: 'PGRST205', message: 'no table' });
  // RLS benzeri: yalnız kendi satırların
  const filters = [...url.searchParams.entries()].filter(([k]) => !['select', 'order', 'on_conflict', 'limit'].includes(k));
  const match = r => r.user_id === uid && filters.every(([k, v]) => {
    if (v.startsWith('eq.')) return String(r[k]) === decodeURIComponent(v.slice(3));
    if (v.startsWith('in.(')) return v.slice(4, -1).split(',').map(decodeURIComponent).includes(String(r[k]));
    return true;
  });
  if (method === 'GET') return json(200, rows.filter(match));
  if (method === 'DELETE') { mock.t[table] = rows.filter(r => !match(r)); return route.fulfill({ status: 204, body: '' }); }
  if (method === 'POST') {
    const conflict = (url.searchParams.get('on_conflict') || '').split(',').filter(Boolean);
    const ignore = /ignore-duplicates/.test(req.headers().prefer || '');
    for (const row0 of [].concat(body)) {
      // bank_support_requests.normalized_key: veritabanında generated column (istemci gönderemez)
      if (table === 'bank_support_requests' && 'normalized_key' in row0) return json(400, { code: '428C9', message: 'cannot insert a non-DEFAULT value into column "normalized_key"' });
      const row = table === 'bank_support_requests' ? { ...row0, normalized_key: normalizeBankRequestName(row0.requested_name) } : row0;
      if (row.user_id !== uid) return json(403, { code: '42501', message: 'new row violates row-level security policy' });
      const i = rows.findIndex(r => conflict.length && conflict.every(c => r[c] === row[c]));
      if (i >= 0) { if (!ignore) rows[i] = { ...rows[i], ...row }; } else rows.push({ ...row });
    }
    return route.fulfill({ status: 201, body: '' });
  }
  return json(405, {});
}

