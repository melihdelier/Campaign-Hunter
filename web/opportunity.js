// v1.5.0 — Gelecekteki "Fırsat Keşfi" için ALTYAPI (kullanıcı arayüzü YOK).
//
// Aynı değerlendirici (eligibility.js + engine.js recommend) iki modda çalışır:
//   ACTUAL_PROFILE        normal Hangi Kart?: kayıtlı profil + YALNIZ sahip olunan kartlar + yalnız güncel onaylı öznitelikler
//   HYPOTHETICAL_PROFILE  geçici kopya/katman: bir kart eklenebilir, bir veya daha fazla öznitelik değiştirilebilir
// Varsayımsal profil:
//   - kayıtlı profili ASLA değiştirmez (derin kopya; girdi nesneleri dondurulmuş gibi ele alınır),
//   - kaydedilmez (profile-store'a hiçbir yol yok),
//   - eksik gereksinimleri, olası ödülü ve gerçek en iyi karta göre farkı döndürür,
//   - kullanıcının bir segmente HAK KAZANDIĞINI iddia etmez (yalnız "şu olsaydı" hesabı).
import { profileToEngineCards, normalizeProfile } from './profile-model.js';
import { effectiveAttributes, currentCriteriaVersion } from './profile-criteria.js';
import { buildEligibilityContext, withHypotheticalOverlay, evaluateCampaignForCard } from './eligibility.js';
import { recommend } from './engine.js';

export const PROFILE_MODE = Object.freeze({ ACTUAL: 'ACTUAL_PROFILE', HYPOTHETICAL: 'HYPOTHETICAL_PROFILE' });

const clone = v => JSON.parse(JSON.stringify(v ?? null));

// Gerçek bağlam (normal Hangi Kart? ile aynı kurulum).
export function actualContext(profile, catalog, now = new Date()) {
  const p = normalizeProfile(profile, catalog);
  const cards = profileToEngineCards(p, catalog, { now });
  const ctx = buildEligibilityContext({ cards, banks: p.banks, attributes: effectiveAttributes(p, catalog, now), catalog });
  return { mode: PROFILE_MODE.ACTUAL, profile: p, cards, ctx };
}

// Geçici varsayımsal profil: kopya üzerinde kart/banka ekler, öznitelik değiştirir. Girdi profili değişmez.
export function buildHypotheticalProfile(actualProfile, { addCards = [], attributes = {} } = {}, catalog, now = new Date()) {
  const base = clone(normalizeProfile(actualProfile, catalog));
  const products = new Map((catalog.cardProducts || []).map(p => [p.code, p]));
  for (const code of addCards) {
    const prod = products.get(code); if (!prod) continue;
    if (!base.banks.includes(prod.bankCode)) base.banks.push(prod.bankCode);
    if (!base.cards.includes(code)) base.cards.push(code);
  }
  for (const [dim, opt] of Object.entries(attributes || {})) {
    if (opt == null) { delete base.attributes[dim]; delete base.attributeConfirmations[dim]; continue; }
    base.attributes[dim] = opt;
    // Varsayımsal değer, hesap için güncel ölçüt sürümünde "kabul edilir"; bu bir kullanıcı ONAYI değildir.
    base.attributeConfirmations[dim] = { criteriaVersion: currentCriteriaVersion(catalog, dim, now), confirmedAt: null, hypothetical: true };
  }
  const out = normalizeProfile(base, catalog);
  for (const dim of Object.keys(attributes || {})) if (out.attributeConfirmations[dim]) out.attributeConfirmations[dim].hypothetical = true;
  return { ...out, hypothetical: true };
}

export function hypotheticalContext(actualProfile, overlay, catalog, now = new Date()) {
  const actual = actualContext(actualProfile, catalog, now);
  const profile = buildHypotheticalProfile(actualProfile, overlay, catalog, now);
  const cards = profileToEngineCards(profile, catalog, { now });
  const ctx = withHypotheticalOverlay(actual.ctx, { cards: overlay?.addCards || [], attributes: overlay?.attributes || {} });
  return { mode: PROFILE_MODE.HYPOTHETICAL, profile, cards, ctx, actual };
}

const rewardOf = e => (e ? (e.actualReward ?? e.theoreticalReward ?? 0) : 0);
const bestOf = recs => {
  const all = recs.filter(r => r.best).map(r => ({ card: r.card, evaluation: r.best }));
  all.sort((a, b) => rewardOf(b.evaluation) - rewardOf(a.evaluation));
  return all[0] || null;
};
const summarize = b => (b ? { cardProductId: b.card.cardProductId, cardName: b.card.name, bank: b.card.bank, campaignId: b.evaluation.campaign.id,
  campaignTitle: b.evaluation.campaign.title, reward: rewardOf(b.evaluation), conditionalRewards: b.evaluation.conditionalRewards || [] } : null);

// Varsayımsal fırsat: gerçek en iyi sonuç ile "şu kart/segment olsaydı" en iyi sonucu karşılaştırır.
export function evaluateOpportunity({ actualProfile, overlay = {}, catalog, campaigns, states = {}, merchant = '', category = 'all', amount, now = new Date(), staleAfterDays = 3 }) {
  const hyp = hypotheticalContext(actualProfile, overlay, catalog, now);
  const run = (cards, ctx) => recommend({ cards, campaigns, states, merchant, category, amount, now, staleAfterDays, eligibilityContext: ctx });
  const actualBest = bestOf(run(hyp.actual.cards, hyp.actual.ctx));
  const hypBest = bestOf(run(hyp.cards, hyp.ctx));

  // Eksik gereksinimler: varsayımsal en iyi sonucun GERÇEK profilde neden geçerli olmadığı.
  const missing = [];
  if (hypBest) {
    const code = hypBest.card.cardProductId;
    const owned = hyp.actual.profile.cards.includes(code);
    if (!owned) {
      const bankCode = hypBest.card.bankCode;
      if (!hyp.actual.profile.banks.includes(bankCode)) missing.push({ type: 'bank', bankCode });
      missing.push({ type: 'card', cardProductId: code });
    }
    const actualCard = hyp.actual.cards.find(c => c.cardProductId === code) || { ...hypBest.card, profileAttributes: {} };
    const r = evaluateCampaignForCard(hypBest.evaluation.campaign, actualCard, hyp.actual.ctx);
    for (const reason of r.reasons) {
      if (reason.code === 'segment' && reason.dim) missing.push({ type: 'attribute', dim: reason.dim, option: hyp.profile.attributes[reason.dim] ?? null, actual: hyp.actual.ctx.attributes[reason.dim] ?? null });
    }
    // Ödül kademesi farkı (uygunluk aynı, kademe farklı): değiştirilen öznitelikleri de gereksinim say.
    for (const [dim, opt] of Object.entries(overlay.attributes || {})) {
      if ((hyp.actual.ctx.attributes[dim] ?? null) !== opt && !missing.some(m => m.type === 'attribute' && m.dim === dim)
        && (hypBest.evaluation.campaign.activeRewardVariant != null || hypBest.evaluation.campaign.eligibilityRule)) {
        const usesDim = JSON.stringify(hypBest.evaluation.campaign.rewardVariants || hypBest.evaluation.campaign.eligibilityRule || {}).includes(`"dim":"${dim}"`);
        if (usesDim) missing.push({ type: 'attribute', dim, option: opt, actual: hyp.actual.ctx.attributes[dim] ?? null });
      }
    }
  }
  const a = summarize(actualBest);
  const h = summarize(hypBest);
  return {
    mode: PROFILE_MODE.HYPOTHETICAL,
    actual: a,
    hypothetical: h,
    potentialReward: h ? h.reward : 0,
    delta: (h ? h.reward : 0) - (a ? a.reward : 0),
    missingRequirements: missing,
    qualificationClaimed: false,
    note: 'Varsayımsal hesap: kart/segment koşullarını karşıladığın anlamına gelmez; banka koşulları geçerlidir.',
  };
}
