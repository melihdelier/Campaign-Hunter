// v1.5.0 çift-yazım parite denetimi (server/tests/test_dual_write.py çağırır).
// Girdi: crawler çıktısı kampanyalar (eski alanlar + şema v1 alanları). Her kampanya için ESKİ sonuç (v1 alanları
// çıkarılmış kayıt → eski adaptör + segmentRules) ile YENİ sonuç (eligibilityRule + rewardVariants) karşılaştırılır:
// her kart ürünü × kartın tüm segment seçenekleri + "bilinmiyor" × birkaç tutar.
// Kullanım: node tools/compare-dual-write.mjs <campaigns.json> [intentionalId,...]  → stdout JSON
import { readFileSync } from 'node:fs';
import { BUNDLED_PROFILE_CATALOG as CAT } from '../web/profile-catalog.js';
import { buildEligibilityContext, evaluateCampaignForCard } from '../web/eligibility.js';
import { resolveSegmentCampaign, evaluateCampaign } from '../web/engine.js';

const V1 = ['eligibilitySchemaVersion', 'eligibilityRule', 'rewardVariants'];
const [, , file, intentionalArg = ''] = process.argv;
const intentional = new Set(intentionalArg.split(',').filter(Boolean));
const campaigns = JSON.parse(readFileSync(file, 'utf8'));
const NOW = new Date(process.env.COMPARE_NOW || '2026-10-05T12:00:00+03:00');
const AMOUNTS = [800, 4500, 12000, 30000];

const strip = c => Object.fromEntries(Object.entries(c).filter(([k]) => !V1.includes(k)));
const pick = c => c && ({ kind: c.rewardRule?.kind ?? null, rate: c.rewardRule?.rate ?? null, tiers: JSON.stringify(c.rewardRule?.tiers ?? null),
  minSpend: c.rewardRule?.minSpend ?? null, perTransactionCap: c.rewardRule?.perTransactionCap ?? null, periodCap: c.periodCap ?? null, rulesComplete: c.rulesComplete ?? null });

function profilesFor(code) {
  const dims = CAT.dimensions.filter(d => d.engineBinding === 'card_segment' && (d.cardCodes || []).includes(code));
  const out = [{ attrs: {}, segment: null }];
  for (const d of dims) for (const o of d.options) out.push({ attrs: { [d.code]: o.code }, segment: o.engineLabel || o.label });
  return out;
}

const mismatches = []; const intentionalDiffs = []; let checked = 0; let compared = 0; let familyExpanded = 0;
for (const c of campaigns) {
  if (!V1.some(k => k in c)) continue;
  compared += 1;
  // v1.5.0 family scope: legacy fields cannot express a family. Parity is checked against the legacy adapter fed with
  // TODAY's master-data expansion (members − exclusions) — computed here only, never stored on the record.
  const fams = c.cardFamilies || [];
  const membersOf = f => (CAT.cardFamilies || []).find(x => x.code === f)?.members || [];
  const exc = new Set([...(c.eligibilityResolution?.excludedProducts || []), ...(c.eligibilityResolution?.excludedFamilies || []).flatMap(membersOf)]);
  const legacy = fams.length
    ? { ...strip(c), cardProductIds: [...new Set([...(c.cardProductIds || []), ...fams.flatMap(membersOf)])].filter(x => !exc.has(x)) }
    : strip(c);
  if (fams.length) familyExpanded += 1;
  const merchant = c.merchantScope?.kind === 'contains' || c.merchantScope?.kind === 'exact' ? (c.merchantScope.values || [])[0] || 'x' : 'Test';
  const category = (c.categories || ['all'])[0];
  for (const product of CAT.cardProducts) {
    for (const prof of profilesFor(product.code)) {
      const card = { id: `x-${product.code}`, bank: product.bankCode, bankCode: product.bankCode, name: product.name, cardProductId: product.code, active: true, segment: prof.segment, profileAttributes: prof.attrs };
      const ctx = buildEligibilityContext({ cards: [card], attributes: prof.attrs, catalog: CAT });
      const lv = evaluateCampaignForCard(legacy, card, ctx).value;
      const nv = evaluateCampaignForCard(c, card, ctx).value;
      const diffs = [];
      if (lv !== nv) diffs.push({ what: 'eligibility', legacy: lv, v1: nv });
      if (lv === true && nv === true) {
        const lr = pick(resolveSegmentCampaign(legacy, card, NOW, ctx)); const nr = pick(resolveSegmentCampaign(c, card, NOW, ctx));
        if (JSON.stringify(lr) !== JSON.stringify(nr)) diffs.push({ what: 'reward_rule', legacy: lr, v1: nr });
        for (const amount of AMOUNTS) {
          const le = evaluateCampaign({ campaign: legacy, state: undefined, card, merchant, category, amount, now: NOW, eligibilityContext: ctx });
          const ne = evaluateCampaign({ campaign: c, state: undefined, card, merchant, category, amount, now: NOW, eligibilityContext: ctx });
          if (le.eligible !== ne.eligible || (le.theoreticalReward ?? null) !== (ne.theoreticalReward ?? null)) diffs.push({ what: 'reward', amount, legacy: [le.eligible, le.theoreticalReward ?? null], v1: [ne.eligible, ne.theoreticalReward ?? null] });
        }
      }
      checked += 1;
      if (diffs.length) (intentional.has(c.id) ? intentionalDiffs : mismatches).push({ id: c.id, card: product.code, attrs: prof.attrs, diffs });
    }
  }
}
process.stdout.write(JSON.stringify({ compared, checked, familyExpanded, mismatches, intentionalDiffs }));
