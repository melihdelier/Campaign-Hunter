// v1.4 — Profilin Supabase (PostgREST) üzerinden okunup yazılması.
// Güvenlik veritabanında: tüm kullanıcı tabloları RLS ile auth.uid() = user_id'ye kilitli (migration 008).
// İstemci yine de yalnız kendi user_id'si ile istek yapar; bu bir kolaylıktır, güvenlik sınırı değildir.

export class SchemaMissingError extends Error {
  constructor(msg = 'Profil tabloları bulunamadı (migration 008–010 uygulanmamış).') { super(msg); this.name = 'SchemaMissingError'; }
}

function isSchemaMissing(status, body) {
  const code = body?.code || '';
  const msg = String(body?.message || '');
  return code === 'PGRST205' || code === '42P01' || code === 'PGRST202' || (status === 404 && /relation|table|schema cache/i.test(msg));
}

export function createProfileStore({ fetchImpl, baseUrl, apiKey, getAccessToken }) {
  const url = String(baseUrl || '').replace(/\/+$/, '');
  const f = fetchImpl || ((...a) => fetch(...a));

  async function req(path, { method = 'GET', body, prefer } = {}) {
    const token = await getAccessToken();
    if (!token) throw new Error('Oturum yok.');
    const headers = { apikey: apiKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' };
    if (prefer) headers.Prefer = prefer;
    const res = await f(`${url}/rest/v1/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!res.ok) {
      if (isSchemaMissing(res.status, json)) throw new SchemaMissingError();
      const err = new Error(json?.message || `HTTP ${res.status}`); err.status = res.status; err.body = json; throw err;
    }
    return json;
  }

  // Ana veri (global). Yazma için gereken uuid ↔ kod eşlemesini de döndürür.
  async function loadMaster() {
    // v1.4.3: seçenek ölçütleri (migration 010). Tablo yoksa SchemaMissingError → uygulama eski moda düşer;
    // eşik kodlu eski seçeneklerle nötr kodlu istemci karıştırılmaz.
    const [banks, cards, dims, dimCards, options, criteria] = await Promise.all([
      req('banks?select=id,code,name,sort_order,active&order=sort_order.asc'),
      req('card_products?select=id,code,name,family,sort_order,active,bank_id&order=sort_order.asc'),
      req('profile_dimensions?select=code,label,kind,bank_id,engine_binding,setting_key,sort_order,active&order=sort_order.asc'),
      req('profile_dimension_cards?select=dimension_code,card_product_id'),
      req('profile_dimension_options?select=dimension_code,code,label,engine_label,sort_order,active&order=sort_order.asc'),
      req('profile_option_criteria?select=dimension_code,option_code,criteria_version,effective_from,effective_to,display_label,lower_bound,upper_bound,bound_unit,source_url,source_reference,verified_at&order=dimension_code.asc,criteria_version.asc,option_code.asc'),
    ]);
    const bankById = new Map(banks.map(b => [b.id, b]));
    const cardById = new Map(cards.map(c => [c.id, c]));
    const catalog = {
      source: 'supabase',
      schema: 2,
      banks: banks.filter(b => b.active !== false).map(b => ({ code: b.code, name: b.name, sortOrder: b.sort_order })),
      cardProducts: cards.filter(c => c.active !== false).map(c => ({ code: c.code, bankCode: bankById.get(c.bank_id)?.code, name: c.name, family: c.family, sortOrder: c.sort_order })),
      dimensions: dims.filter(d => d.active !== false).map(d => ({
        code: d.code, label: d.label, kind: d.kind, bankCode: bankById.get(d.bank_id)?.code || null,
        engineBinding: d.engine_binding, settingKey: d.setting_key, sortOrder: d.sort_order,
        cardCodes: dimCards.filter(x => x.dimension_code === d.code).map(x => cardById.get(x.card_product_id)?.code).filter(Boolean),
        options: options.filter(o => o.dimension_code === d.code && o.active !== false).map(o => ({ code: o.code, label: o.label, engineLabel: o.engine_label, sortOrder: o.sort_order })),
      })),
      optionCriteria: (criteria || []).map(r => ({
        dimensionCode: r.dimension_code, optionCode: r.option_code, criteriaVersion: r.criteria_version,
        effectiveFrom: r.effective_from, effectiveTo: r.effective_to ?? null, displayLabel: r.display_label,
        lowerBound: r.lower_bound == null ? null : Number(r.lower_bound), upperBound: r.upper_bound == null ? null : Number(r.upper_bound),
        boundUnit: r.bound_unit, sourceUrl: r.source_url, sourceReference: r.source_reference ?? null, verifiedAt: r.verified_at ?? null,
      })),
    };
    const ids = {
      bankId: new Map(banks.map(b => [b.code, b.id])), bankCode: new Map(banks.map(b => [b.id, b.code])),
      cardId: new Map(cards.map(c => [c.code, c.id])), cardCode: new Map(cards.map(c => [c.id, c.code])),
    };
    return { catalog, ids };
  }

  // Kullanıcının profili. Hiç profil satırı yoksa `null` (→ onboarding).
  async function loadProfile(userId, master) {
    const uid = encodeURIComponent(userId);
    const [profiles, banks, cards, attrs, prefs] = await Promise.all([
      req(`profiles?user_id=eq.${uid}&select=user_id,display_name,onboarding_completed_at,profile_version`),
      req(`user_banks?user_id=eq.${uid}&select=bank_id`),
      req(`user_cards?user_id=eq.${uid}&select=card_product_id,active`),
      req(`user_profile_attributes?user_id=eq.${uid}&select=dimension_code,option_code,criteria_version,confirmed_at`),
      req(`user_preferences?user_id=eq.${uid}&select=preferences`),
    ]);
    const row = profiles?.[0];
    if (!row) return null;
    return {
      displayName: row.display_name ?? null,
      onboardingCompletedAt: row.onboarding_completed_at ?? null,
      banks: (banks || []).map(b => master.ids.bankCode.get(b.bank_id)).filter(Boolean),
      cards: (cards || []).filter(c => c.active !== false).map(c => master.ids.cardCode.get(c.card_product_id)).filter(Boolean),
      attributes: Object.fromEntries((attrs || []).map(a => [a.dimension_code, a.option_code])),
      attributeConfirmations: Object.fromEntries((attrs || []).map(a => [a.dimension_code, { criteriaVersion: a.criteria_version ?? null, confirmedAt: a.confirmed_at ?? null }])),
      preferences: prefs?.[0]?.preferences || {},
    };
  }

  // Farkı sunucuya uygular. Sıra: profil → banka ekle → kart ekle → öznitelik yaz/sil → kart sil → banka sil → tercih.
  async function saveProfile(userId, diff, after, master) {
    const uid = encodeURIComponent(userId);
    const inList = ids => `(${ids.map(encodeURIComponent).join(',')})`;
    await req('profiles?on_conflict=user_id', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
      body: { user_id: userId, display_name: after.displayName ?? null, onboarding_completed_at: after.onboardingCompletedAt ?? null } });
    if (diff.banksAdd.length) await req('user_banks?on_conflict=user_id,bank_id', { method: 'POST', prefer: 'resolution=ignore-duplicates,return=minimal',
      body: diff.banksAdd.map(code => ({ user_id: userId, bank_id: master.ids.bankId.get(code) })) });
    if (diff.cardsAdd.length) await req('user_cards?on_conflict=user_id,card_product_id', { method: 'POST', prefer: 'resolution=ignore-duplicates,return=minimal',
      body: diff.cardsAdd.map(code => ({ user_id: userId, card_product_id: master.ids.cardId.get(code), active: true })) });
    if (diff.attrsUpsert.length) await req('user_profile_attributes?on_conflict=user_id,dimension_code', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
      body: diff.attrsUpsert.map(([dimension_code, option_code, c]) => ({ user_id: userId, dimension_code, option_code,
        criteria_version: c?.criteriaVersion ?? null, confirmed_at: c?.confirmedAt ?? null })) });
    if (diff.attrsRemove.length) await req(`user_profile_attributes?user_id=eq.${uid}&dimension_code=in.${inList(diff.attrsRemove)}`, { method: 'DELETE', prefer: 'return=minimal' });
    if (diff.cardsRemove.length) await req(`user_cards?user_id=eq.${uid}&card_product_id=in.${inList(diff.cardsRemove.map(c => master.ids.cardId.get(c)))}`, { method: 'DELETE', prefer: 'return=minimal' });
    if (diff.banksRemove.length) await req(`user_banks?user_id=eq.${uid}&bank_id=in.${inList(diff.banksRemove.map(b => master.ids.bankId.get(b)))}`, { method: 'DELETE', prefer: 'return=minimal' });
    if (diff.prefsChanged) await req('user_preferences?on_conflict=user_id', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
      body: { user_id: userId, preferences: after.preferences || {} } });
    return true;
  }

  return { loadMaster, loadProfile, saveProfile };
}

// Cihazdaki profil önbelleği (hızlı açılış / çevrimdışı). Kullanıcı kimliğine göre ayrılır.
export const PROFILE_CACHE_PREFIX = 'bka-profile-cache-v1:';
export function readProfileCache(storage, userId) {
  try { return JSON.parse(storage.getItem(PROFILE_CACHE_PREFIX + userId) || 'null'); } catch { return null; }
}
export function writeProfileCache(storage, userId, value) {
  try { storage.setItem(PROFILE_CACHE_PREFIX + userId, JSON.stringify(value)); } catch {}
}
