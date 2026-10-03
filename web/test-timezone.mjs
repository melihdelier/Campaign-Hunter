// v1.2.2 regresyon: kampanya takvimi Europe/Istanbul'a göre işler; Node/cihaz saat diliminden bağımsız olmalı.
// Doğrudan çalıştırılırsa kendini TZ=UTC / Europe/Istanbul / America/Los_Angeles / Pacific/Kiritimati altında yeniden başlatır.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ZONES = { 'UTC': 0, 'Europe/Istanbul': -180, 'America/Los_Angeles': null, 'Pacific/Kiritimati': -840 };

if (!process.env.BKA_TZ_CHILD) {
  for (const tz of Object.keys(ZONES)) {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, TZ: tz, BKA_TZ_CHILD: '1' }, encoding: 'utf8' });
    process.stdout.write(r.stdout); process.stderr.write(r.stderr);
    assert.equal(r.status, 0, `timezone tests failed under TZ=${tz}`);
  }
  console.log('timezone tests (UTC, Europe/Istanbul, America/Los_Angeles, Pacific/Kiritimati): OK');
} else {
  const { currentPeriodKey, campaignIsActive, endDatePassed, resolveSegmentCampaign, ensureReset, evaluateCampaign } = await import('./engine.js');
  const { campaignActiveNow } = await import('./campaign-browser.js');
  const { trDay, trMonthKey } = await import('./tr-time.js');
  const { initialCampaigns, initialCards } = await import('./bootstrap-data.js');
  const tz = process.env.TZ;

  // Node gerçekten istenen saat diliminde çalışıyor mu? (UTC'de getTimezoneOffset() === 0)
  const probe = new Date('2026-10-01T12:00:00Z').getTimezoneOffset();
  if (ZONES[tz] !== null) assert.equal(probe, ZONES[tz], `runtime TZ not applied: ${tz}`);
  else assert.notEqual(probe, -180);

  const OCT1_0005 = new Date('2026-10-01T00:05:00+03:00'); // = 2026-09-30T21:05Z: UTC'de hâlâ 30 Eylül
  const SEP30_2355 = new Date('2026-09-30T23:55:00+03:00');
  assert.equal(trDay(OCT1_0005), '2026-10-01'); assert.equal(trMonthKey(OCT1_0005), '2026-10');
  assert.equal(trDay(SEP30_2355), '2026-09-30');

  // Ay anahtarı
  const monthly = { id: 'm', resetPolicy: 'monthly', periodCap: 1000 };
  assert.equal(currentPeriodKey(monthly, OCT1_0005), '2026-10', `periodKey under ${tz}`);
  assert.equal(currentPeriodKey(monthly, SEP30_2355), '2026-09');

  // Geçerlilik başlangıç/bitiş günleri Türkiye saatine göre
  const startsOct = { startDate: '2026-10-01', endDate: '2026-10-31', status: 'active' };
  const endsSep = { startDate: '2026-09-01', endDate: '2026-09-30', status: 'active' };
  assert.equal(campaignIsActive(startsOct, OCT1_0005), true);
  assert.equal(campaignIsActive(startsOct, SEP30_2355), false);
  assert.equal(campaignIsActive(endsSep, SEP30_2355), true);
  assert.equal(campaignIsActive(endsSep, OCT1_0005), false);
  assert.equal(campaignActiveNow(startsOct, OCT1_0005), true);
  assert.equal(campaignActiveNow(endsSep, OCT1_0005), false);
  assert.equal(campaignActiveNow(endsSep, SEP30_2355), true);
  assert.equal(endDatePassed('2026-09-30', OCT1_0005), true);
  assert.equal(endDatePassed('2026-09-30', SEP30_2355), false);

  // Dönemli core: Maximiles Q3 → Q4 sınırı Türkiye gece yarısında
  const maxi = initialCampaigns.find(c => c.id === 'official-is-restoran-2026q3');
  const maxiCard = initialCards.find(c => c.cardProductId === 'is-maximiles-black');
  assert.equal(resolveSegmentCampaign(maxi, maxiCard, OCT1_0005).activePeriodId, '2026q4');
  assert.equal(resolveSegmentCampaign(maxi, maxiCard, SEP30_2355).activePeriodId, '2026q3');

  // Crystal: resmi en geç tarih 31.10 Türkiye günü sonuna kadar geçerli
  const crystal = initialCampaigns.find(c => c.id === 'official-ykb-crystal-restoran-2026-09');
  const crystalCard = initialCards.find(c => c.cardProductId === 'ykb-crystal');
  const ev = when => evaluateCampaign({ campaign: crystal, state: undefined, card: crystalCard, merchant: 'Da Mario', category: 'restoran', amount: 5000, now: when });
  assert.equal(ev(new Date('2026-10-31T23:55:00+03:00')).eligible, true);
  assert.equal(ev(new Date('2026-11-01T00:05:00+03:00')).coreExpired, true);

  // Yeni-dönem politikası değişmedi: 1 Ekim 00:05 TR'de kalan hak bilinmiyor başlar.
  const prev = { campaignId: 'm', periodKey: '2026-09', enrollmentStatus: 'not_required', remainingLimit: 400, valueSource: 'user_confirmed', confirmedAt: '2026-09-30T20:00:00Z' };
  const r = ensureReset(monthly, prev, OCT1_0005);
  assert.equal(r.periodKey, '2026-10'); assert.equal(r.remainingLimit, null); assert.equal(r.valueSource, 'unknown');
  // 30 Eylül 23:55 TR: aynı dönem, doğrulanmış değer korunur.
  assert.equal(ensureReset(monthly, prev, SEP30_2355).remainingLimit, 400);
  console.log(`  timezone checks under TZ=${tz}: OK`);
}
