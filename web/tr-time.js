// Türk bankası kampanya takvimi Europe/Istanbul saatine göre işler; cihazın/çalışma ortamının yerel saat
// diliminden BAĞIMSIZDIR. Tüm dönem/geçerlilik karşılaştırmaları Türkiye takvimindeki 'YYYY-MM-DD' değerleriyle yapılır.
export const TR_TIME_ZONE = 'Europe/Istanbul';

let formatter = null;
try {
  formatter = new Intl.DateTimeFormat('en-CA', { timeZone: TR_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
} catch {
  formatter = null; // saat dilimi verisi olmayan ortam → sabit UTC+3 (Türkiye 2016'dan beri yaz saati uygulamıyor)
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

// Verilen anın Türkiye takvimindeki günü: 'YYYY-MM-DD'.
export function trDay(date = new Date()) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  if (formatter) {
    const parts = Object.fromEntries(formatter.formatToParts(d).map(p => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }
  return new Date(d.getTime() + 3 * 3600000).toISOString().slice(0, 10);
}

// Türkiye takvimindeki ay anahtarı: 'YYYY-MM'.
export function trMonthKey(date = new Date()) {
  const day = trDay(date);
  return day ? day.slice(0, 7) : null;
}

// Kampanya metinlerindeki tarihleri ('YYYY-MM-DD' veya ISO zaman damgası) Türkiye günü olarak normalize eder.
export function toTrDay(value) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value);
  if (ISO_DAY.test(s)) return s;
  return trDay(s);
}

// Takvim günü aritmetiği (saat diliminden bağımsız, saf tarih).
export function addTrDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
