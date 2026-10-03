// Tüm JS test paketlerini birden fazla saat diliminde çalıştırır (Windows/macOS/Linux'ta aynı şekilde).
// Kampanya takvimi Europe/Istanbul'a göre işlediği için sonuçlar çalışma ortamının saat diliminden bağımsız olmalı.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SUITES = ['test-engine.mjs', 'test-loyalty.mjs', 'test-campaign-browser.mjs', 'test-catalog-state.mjs', 'test-navigation.mjs', 'test-profile.mjs', 'test-eligibility.mjs', 'test-option-criteria.mjs'];
const ZONES = (process.env.BKA_TEST_ZONES || 'Europe/Istanbul,UTC,America/Los_Angeles,Pacific/Kiritimati').split(',');

let failed = 0;
for (const tz of ZONES) {
  console.log(`\n=== TZ=${tz} ===`);
  for (const suite of SUITES) {
    const r = spawnSync(process.execPath, [join(here, suite)], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
    process.stdout.write(r.stdout); process.stderr.write(r.stderr);
    if (r.status !== 0) { failed++; console.error(`FAILED: ${suite} under TZ=${tz}`); }
  }
}
// Kendi içinde UTC / Istanbul / uç saat dilimlerinde yeniden başlayan özel saat dilimi testi
const t = spawnSync(process.execPath, [join(here, 'test-timezone.mjs')], { env: { ...process.env, BKA_TZ_CHILD: '' }, encoding: 'utf8' });
process.stdout.write(t.stdout); process.stderr.write(t.stderr);
if (t.status !== 0) { failed++; console.error('FAILED: test-timezone.mjs'); }

if (failed) { console.error(`\n${failed} test run(s) failed.`); process.exit(1); }
console.log(`\nAll JS suites passed under: ${ZONES.join(', ')}`);
