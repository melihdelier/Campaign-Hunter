// v1.5.0 — "Bankam listede yok" (saf yardımcılar).
// Destek isteği kanonik ana veriden AYRIDIR: banka/kart/kampanya oluşturmaz, banks/card_products'a yazmaz.
// Toplama anahtarı veritabanında (public.bank_support_requests.normalized_key, generated column) hesaplanır;
// bu fonksiyon AYNI kuralın istemci kopyasıdır (önizleme/doğrulama). Birebir aynılık SQL testinde doğrulanır.
const TR_MAP = { 'Ç': 'C', 'Ğ': 'G', 'İ': 'I', 'I': 'I', 'Ö': 'O', 'Ş': 'S', 'Ü': 'U', 'Â': 'A', 'Î': 'I', 'Û': 'U',
  'ç': 'c', 'ğ': 'g', 'ı': 'i', 'ö': 'o', 'ş': 's', 'ü': 'u', 'â': 'a', 'î': 'i', 'û': 'u' };

export function normalizeBankRequestName(name) {
  const trimmed = String(name ?? '').trim();
  if (trimmed.length < 2 || trimmed.length > 80) return null;
  const ascii = trimmed.replace(/[ÇĞİIÖŞÜÂÎÛçğıöşüâîû]/g, ch => TR_MAP[ch] || ch).toLowerCase();
  const key = ascii.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/(-(bankasi|bank|a-s|as))+$/g, '').replace(/^-+|-+$/g, '');
  return key || null;
}

// İstek gövdesi: YALNIZ ad (ve isteğe bağlı not). Anahtar ve sahiplik sunucuda belirlenir (user_id = auth.uid()).
export function bankRequestPayload(userId, name, note = null) {
  const requested_name = String(name ?? '').trim();
  return note ? { user_id: userId, requested_name, note: String(note).slice(0, 280) } : { user_id: userId, requested_name };
}
