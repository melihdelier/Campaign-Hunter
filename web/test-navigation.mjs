// v1.3 regresyon: bilgi mimarisi / gezinme / Info / service worker kapsamı (DOM gerektirmeyen yapısal testler).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveRoute, ROUTES, PRIMARY_TABS, DEFAULT_ROUTE } from './router.js';
import { buildInfoRows, RELEASE_NOTES } from './app-info.js';
import { APP_VERSION } from './version.js';
import { BUILD_INFO } from './build-info.js';

const read = f => readFileSync(new URL(f, import.meta.url), 'utf8');
const html = read('./index.html');
const app = read('./app.js');
const sw = read('./sw.js');

const section = id => {
  const m = html.match(new RegExp(`<section id="${id}"[^>]*>([\\s\\S]*?)</section>`));
  assert.ok(m, `section #${id} missing`);
  return m[0];
};
const navHtml = html.match(/<nav class="nav"[\s\S]*?<\/nav>/)[0];

// ---- Router: Hangi Kart? varsayılan ana ekran
assert.equal(DEFAULT_ROUTE, '#/hangi-kart');
for (const h of ['', '#', '#/', '#/bilinmeyen', undefined, null]) {
  const r = resolveRoute(h);
  assert.equal(r.view, 'recommend', `hash ${h}`); assert.equal(r.tab, 'recommend');
}
assert.equal(resolveRoute('#/hangi-kart/').view, 'recommend');
assert.equal(resolveRoute('#/kampanyalar/ekle').view, 'privateCampaign');
assert.equal(resolveRoute('#/kampanyalar/ekle').tab, 'campaigns');
assert.equal(resolveRoute('#/profil/veriler').view, 'dashboard'); // eski Özet → Profil altında
assert.equal(resolveRoute('#/profil/veriler').tab, 'profile');
assert.equal(resolveRoute('#/profil/info').view, 'profileInfo');
// Eski yer imleri
assert.equal(resolveRoute('#dashboard').hash, '#/profil/veriler');
assert.equal(resolveRoute('#privateCampaign').hash, '#/kampanyalar/ekle');
assert.equal(resolveRoute('#settings').hash, '#/profil');

// ---- Ana menü: tam olarak 3 sekme; Özet ve Ekle ana menüde yok
const navLinks = [...navHtml.matchAll(/<a class="nav-btn[^"]*" href="([^"]+)" data-tab="([^"]+)"/g)].map(m => ({ href: m[1], tab: m[2] }));
assert.deepEqual(navLinks, PRIMARY_TABS.map(t => ({ href: t.href, tab: t.tab })));
assert.equal(navLinks.length, 3);
assert.ok(!/Özet/.test(navHtml), 'Özet must not be a main navigation item');
assert.ok(!/Ekle|privateCampaign|settings|Ayarlar/.test(navHtml), 'Ekle/Ayarlar must not be main navigation items');
assert.match(navHtml, /class="nav-btn nav-primary active" href="#\/hangi-kart"/);

// ---- Varsayılan görünür ekran Hangi Kart?
const activeViews = [...html.matchAll(/<section id="([^"]+)" class="view active"/g)].map(m => m[1]);
assert.deepEqual(activeViews, ['recommend']);

// ---- Her route görünümü HTML'de var
for (const [hash, r] of Object.entries(ROUTES)) assert.ok(html.includes(`<section id="${r.view}"`), `${hash} → #${r.view}`);

// ---- Kampanyalar ekranındaki + mevcut ekleme akışını açar
const campaigns = section('campaigns');
assert.match(campaigns, /id="addCampaignBtn"[^>]*href="#\/kampanyalar\/ekle"/);
assert.match(campaigns, /aria-label="Kampanya ekle"/);
assert.ok(section('privateCampaign').includes('id="privateCampaignForm"'));
assert.ok(app.includes("$('#privateCampaignForm')"), 'existing add-flow handler still wired');

// ---- Özet işlevleri Profil → Veriler ve Özet altında korunuyor
const dash = section('dashboard');
for (const id of ['catalogHealth', 'cardCount', 'campaignCount', 'staleCount', 'unknownCount', 'refreshCampaignsBtn', 'exportBtn', 'importFile', 'resetBtn']) {
  assert.ok(dash.includes(`id="${id}"`), `#${id} under Veriler ve Özet`);
}
assert.ok(section('profile').includes('href="#/profil/veriler"'));
for (const href of ['#/profil/kartlar', '#/profil/musteri', '#/profil/tercihler', '#/profil/veriler', '#/profil/hesap', '#/profil/info']) {
  assert.ok(section('profile').includes(`href="${href}"`), `Profil menu → ${href}`);
}
// Giriş/hesap Hesap altında; segment seçicileri Müşteri Profili altında
assert.ok(section('profileAccount').includes('id="cloudSignInBtn"'));
for (const id of ['thyStatus', 'qnbSegment', 'wingsTier', 'maximilesBand', 'crystalBand', 'crystalCardType', 'tebTier']) {
  assert.ok(section('profileSegments').includes(`id="${id}"`), `#${id} under Müşteri Profili`);
}

// ---- app.js'in kullandığı her #id HTML'de hâlâ var (taşınan öğeler kırılmasın)
const ids = new Set([...app.matchAll(/\$\('#([A-Za-z][\w-]*)'\)/g)].map(m => m[1]));
const dynamic = new Set([...app.matchAll(/id="([A-Za-z][\w-]*)"/g)].map(m => m[1])); // app.js'in kendi ürettiği öğeler
const missing = [...ids].filter(id => !dynamic.has(id) && !html.includes(`id="${id}"`));
assert.deepEqual(missing, [], `app.js references missing ids: ${missing.join(', ')}`);

// ---- Sürüm yalnız Info'da; doğru sürüm
const versionSpans = [...html.matchAll(/id="runtimeVersion"/g)].length;
assert.equal(versionSpans, 1);
assert.ok(section('profileInfo').includes(`<span id="runtimeVersion">${APP_VERSION}</span>`));
assert.ok(!/runtimeVersion|v\d+\.\d+\.\d+/.test(html.match(/<header[\s\S]*?<\/header>/)[0]), 'no version in the top bar');
assert.equal(RELEASE_NOTES[0].version, APP_VERSION, 'release notes start with the current version');
const rows = Object.fromEntries(buildInfoRows({ version: APP_VERSION, build: { id: '42-abcdef1', commit: 'abcdef1234567', builtAt: '2026-10-03T05:00:00Z' }, meta: { catalogGeneratedAt: '2026-10-03T05:10:00Z', catalogSource: 'supabase', catalogMeta: { campaign_count: 54, guard: { verdict: 'ok' } } }, campaignCount: 54, coreCount: 4 }));
assert.equal(rows['Uygulama sürümü'], APP_VERSION);
assert.equal(rows['Build'], '42-abcdef1'); assert.equal(rows['Commit'], 'abcdef1');
assert.equal(rows['Katalog kaynağı'], 'Supabase bulut kataloğu');
assert.equal(rows['Katalogdaki kampanya'], '54');
assert.match(rows['Katalog son tarama'], /2026/);
assert.equal(rows['Katalog kalite kapısı'], 'Sorunsuz');
assert.ok(BUILD_INFO && typeof BUILD_INFO.id === 'string');

// ---- Service worker: sürüm bazlı önbellek + uygulamanın içe aktardığı tüm modüller önbellekte (çevrimdışı kırılmasın)
assert.match(sw, new RegExp(`const CACHE='bka-${APP_VERSION.replace(/\./g, '\\.')}';`));
const seen = new Set();
const walk = f => {
  if (seen.has(f)) return; seen.add(f);
  for (const m of read(f).matchAll(/from '\.\/([\w-]+\.js)'/g)) walk(`./${m[1]}`);
};
walk('./app.js');
for (const f of seen) assert.ok(sw.includes(`'${f}'`), `${f} missing from SW ASSETS`);
assert.match(sw, /self\.skipWaiting\(\)/); assert.match(sw, /clients\.claim\(\)/);
assert.match(app, /reg\.update\(\)/);

console.log('v1.3 navigation / info / service worker tests: OK');
