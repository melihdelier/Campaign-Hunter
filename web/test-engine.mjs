import assert from 'node:assert/strict';
import { calcTheoreticalReward, ensureReset, recommend, inspectCampaign, evaluateCampaign, inferMerchantContext, resolveMerchantInput } from './engine.js';
import { initialCards, initialCampaigns, initialStates } from './bootstrap-data.js';

const percent = { rewardRule:{kind:'percent',rate:.2,minSpend:1000,perTransactionCap:1500} };
assert.equal(calcTheoreticalReward(percent, 500), 0);
assert.equal(calcTheoreticalReward(percent, 5000), 1000);
assert.equal(calcTheoreticalReward(percent, 10000), 1500);

const tiered = { rewardRule:{kind:'tiered_percent',tiers:[{min:4000,max:7999.99,rate:.1},{min:8000,rate:.2}],perTransactionCap:3000} };
assert.equal(calcTheoreticalReward(tiered, 3999), 0);
assert.equal(calcTheoreticalReward(tiered, 6000), 600);
assert.equal(calcTheoreticalReward(tiered, 20000), 3000);

const campaign={id:'c1', resetPolicy:'monthly', periodCap:8000, requiresEnrollment:false};
const reset=ensureReset(campaign,{periodKey:'2026-08',remainingLimit:100},new Date('2026-09-23T12:00:00+03:00'));
assert.equal(reset.periodKey,'2026-09');
assert.equal(reset.remainingLimit,8000);
assert.equal(reset.valueSource,'reset');

const firstSeen=ensureReset(campaign,null,new Date('2026-09-23T12:00:00+03:00'));
assert.equal(firstSeen.periodKey,'2026-09');
assert.equal(firstSeen.remainingLimit,null);
assert.equal(firstSeen.valueSource,'unknown');

const tebCard = initialCards.find(c => c.cardProductId === 'teb-infinite');
const tebCampaign = initialCampaigns.find(c => c.id === 'official-teb-infinite-restoran-ultra');
let inspected = inspectCampaign({
  campaign: tebCampaign, card: tebCard, merchant:'Günaydın', category:'restoran', amount:1250,
  locationScope:'domestic', paymentChannel:'physical', now:new Date('2026-09-23T12:00:00+03:00')
});
assert.equal(inspected.eligible, false);
assert.ok(inspected.reasons.some(x => x.includes('Alt limit')));

inspected = inspectCampaign({
  campaign: tebCampaign, card: tebCard, merchant:'Günaydın', category:'restoran', amount:1500,
  locationScope:'domestic', paymentChannel:'physical', now:new Date('2026-09-23T12:00:00+03:00')
});
assert.equal(inspected.eligible, true);
assert.equal(calcTheoreticalReward(tebCampaign, 1500), 300);
assert.equal(calcTheoreticalReward(tebCampaign, 12000), 2000); // işlem tavanı

const premiumSegment = {...tebCard, segment:'Premium'};
inspected = inspectCampaign({
  campaign: tebCampaign, card: premiumSegment, merchant:'Günaydın', category:'restoran', amount:5000,
  locationScope:'domestic', paymentChannel:'physical', now:new Date('2026-09-23T12:00:00+03:00')
});
assert.equal(inspected.eligible, true);
const premiumEval = evaluateCampaign({
  campaign: tebCampaign, state:{campaignId:tebCampaign.id,periodKey:'2026-09',enrollmentStatus:'not_required',remainingLimit:4000,valueSource:'user_confirmed',confirmedAt:'2026-09-23T10:00:00+03:00',updatedAt:'2026-09-23T10:00:00+03:00'},
  card: premiumSegment, merchant:'Günaydın', category:'restoran', amount:5000, locationScope:'domestic', paymentChannel:'physical', now:new Date('2026-09-23T12:00:00+03:00')
});
assert.equal(premiumEval.campaign.rewardRule.rate, 0.15);
assert.equal(premiumEval.theoreticalReward, 750);

const invalidSegment = {...tebCard, segment:'Bilinmeyen'};
inspected = inspectCampaign({ campaign:tebCampaign, card:invalidSegment, merchant:'Günaydın', category:'restoran', amount:5000, locationScope:'domestic', paymentChannel:'physical', now:new Date('2026-09-23T12:00:00+03:00') });
assert.equal(inspected.eligible, false);
assert.ok(inspected.reasons.some(x => x.includes('segment')));

// Kullanıcının ekranındaki örnek: Günaydın / restoran / 1.250 TL.
// TEB 1.500 TL alt limit nedeniyle artık önerilmemeli; Crystal detay koşullarıyla eşleşir.
const rec = recommend({
  cards: initialCards,
  campaigns: initialCampaigns,
  states: initialStates,
  merchant:'Günaydın', category:'restoran', amount:1250,
  locationScope:'domestic', paymentChannel:'physical',
  now:new Date('2026-09-23T12:00:00+03:00'), staleAfterDays:3
});
assert.equal(rec[0].card.cardProductId, 'ykb-crystal');
assert.equal(rec[0].best.theoreticalReward, 250);
const tebResult = rec.find(r => r.card.cardProductId === 'teb-infinite');
assert.equal(tebResult.best, null);
assert.ok(tebResult.potentials.some(x => x.inspection.reasons.some(y => y.includes('Alt limit'))));


// stale remaining limit is not treated as exact
{
  const c = { id:'stale1', bank:'X', cardProductIds:['p1'], categories:['restoran'], merchantScope:{kind:'all'}, startDate:'2026-01-01', endDate:'2026-12-31', status:'active', resetPolicy:'monthly', periodCap:1000, requiresEnrollment:false, rewardRule:{kind:'percent',rate:0.1,minSpend:0}, transactionRules:{}, rulesComplete:true };
  const card={id:'c1',cardProductId:'p1',segment:'x',active:true};
  const state={campaignId:'stale1',periodKey:'2026-09',enrollmentStatus:'not_required',remainingLimit:1000,valueSource:'user_confirmed',confirmedAt:'2026-09-01T00:00:00+03:00',updatedAt:'2026-09-01T00:00:00+03:00'};
  const r=evaluateCampaign({campaign:c,state,card,merchant:'Test',category:'restoran',amount:5000,now:new Date('2026-09-23T12:00:00+03:00'),staleAfterDays:3});
  assert.equal(r.remainingKnown,false);
  assert.equal(r.actualReward,null);
  assert.equal(r.freshness.status,'stale');
}


// Segment seçimi kampanya kuralını gerçekten değiştirmeli.
{
  const crystal = initialCampaigns.find(c => c.id === 'official-ykb-crystal-restoran-2026-09');
  const crystalCard = {...initialCards.find(c => c.cardProductId === 'ykb-crystal'), segment:'10 milyon TL+'};
  const r = evaluateCampaign({campaign:crystal,state:{campaignId:crystal.id,periodKey:'2026-09',enrollmentStatus:'not_required',remainingLimit:10000,valueSource:'user_confirmed',confirmedAt:'2026-09-23T10:00:00+03:00',updatedAt:'2026-09-23T10:00:00+03:00'},card:crystalCard,merchant:'Da Mario',category:'restoran',amount:25000,locationScope:'domestic',paymentChannel:'physical',now:new Date('2026-09-23T12:00:00+03:00')});
  assert.equal(r.campaign.rewardRule.perTransactionCap,4000);
  assert.equal(r.campaign.periodCap,10000);
  assert.equal(r.theoreticalReward,4000);
}
{
  const maxi = initialCampaigns.find(c => c.id === 'official-is-restoran-2026q3');
  const maxiCard = {...initialCards.find(c => c.cardProductId === 'is-maximiles-black'), segment:'1 milyon TL altı'};
  const r = evaluateCampaign({campaign:maxi,state:{campaignId:maxi.id,periodKey:'2026-09',enrollmentStatus:'not_required',remainingLimit:2000,valueSource:'user_confirmed',confirmedAt:'2026-09-23T10:00:00+03:00',updatedAt:'2026-09-23T10:00:00+03:00'},card:maxiCard,merchant:'Test Restoran',category:'restoran',amount:10000,locationScope:'domestic',paymentChannel:'physical',now:new Date('2026-09-23T12:00:00+03:00')});
  assert.equal(r.campaign.rewardRule.rate,0.05);
  assert.equal(r.campaign.periodCap,2000);
  assert.equal(r.theoreticalReward,500);
}

console.log('engine tests: OK');

// v0.3: Koşulu henüz sağlanmayan ama işyeri/kategori/kart olarak alakalı kampanyalar kaybolmamalı.
const amazon2000 = recommend({
  cards: initialCards,
  campaigns: initialCampaigns,
  states: initialStates,
  merchant:'Amazon', category:'e-ticaret', amount:2000,
  locationScope:'domestic', paymentChannel:'online',
  now:new Date('2026-09-23T12:00:00+03:00'), staleAfterDays:3
});
const isAmazon2000 = amazon2000.find(r => r.card.cardProductId === 'is-maximiles-black');
assert.equal(isAmazon2000.best, null);
assert.ok(isAmazon2000.potentials.some(p => p.campaign.id === 'official-is-eticaret-2026-09'));
const amazonPotential = isAmazon2000.potentials.find(p => p.campaign.id === 'official-is-eticaret-2026-09');
const minBlock = amazonPotential.actionableBlockers.find(b => b.code === 'min_spend');
assert.equal(minBlock.requiredAmount, 3000);
assert.equal(minBlock.currentAmount, 2000);
assert.equal(minBlock.gap, 1000);
assert.equal(amazonPotential.rewardAtThreshold, 250);

// 3.000 TL eşiği sağlandığında kampanya aday olur; önceki uygun işlem adedi bilinmiyorsa ödül kesin yazılmaz.
const amazon3000 = recommend({
  cards: initialCards,
  campaigns: initialCampaigns,
  states: initialStates,
  merchant:'Amazon', category:'e-ticaret', amount:3000,
  locationScope:'domestic', paymentChannel:'online',
  now:new Date('2026-09-23T12:00:00+03:00'), staleAfterDays:3
});
const isAmazon3000 = amazon3000.find(r => r.card.cardProductId === 'is-maximiles-black');
assert.ok(isAmazon3000.best);
assert.equal(isAmazon3000.best.theoreticalReward, 250);
assert.equal(isAmazon3000.best.actualReward, 0); // katılım henüz doğrulanmadı
assert.equal(isAmazon3000.best.progress.known, false);

console.log('potential campaign tests: OK');

// v0.4: Yazım hatası / eksik karakter toleransı ve kategori ipucu.
const gunaydnCtx = inferMerchantContext(initialCampaigns, 'Günaydn');
assert.equal(gunaydnCtx.recognized, true);
assert.ok(gunaydnCtx.categories.includes('restoran'));
assert.ok(['Günaydın','Gunaydin'].includes(gunaydnCtx.canonicalName));

const amzonCtx = inferMerchantContext(initialCampaigns, 'Amzon');
assert.equal(amzonCtx.recognized, true);
assert.ok(amzonCtx.categories.includes('e-ticaret'));

const crystalCard = initialCards.find(c => c.cardProductId === 'ykb-crystal');
const crystalCampaign = initialCampaigns.find(c => c.id === 'official-ykb-crystal-restoran-2026-09');
const typoInspect = inspectCampaign({
  campaign: crystalCampaign, card: crystalCard, merchant:'Günaydn', category:'restoran', amount:1250,
  locationScope:'domestic', paymentChannel:'physical', now:new Date('2026-09-23T12:00:00+03:00')
});
assert.equal(typoInspect.eligible, true);
assert.equal(typoInspect.merchant.fuzzy, true);
assert.ok(typoInspect.merchant.canonicalName);

console.log('fuzzy merchant tests: OK');

const wrongCategory = resolveMerchantInput(initialCampaigns, 'Günaydın', 'e-ticaret');
assert.equal(wrongCategory.needsCategorySelection, false);
assert.equal(wrongCategory.effectiveCategory, 'restoran');
assert.ok(wrongCategory.notices.some(x => x.includes('Kategori uyuşmazlığı')));
const autoTypo = resolveMerchantInput(initialCampaigns, 'Günaydn', 'auto');
assert.equal(autoTypo.effectiveCategory, 'restoran');
console.log('input resolution tests: OK');


// v1.0.6: Migros otomatik kategori güvenilir merchant sözlüğünden market olmalı.
const migrosAuto = resolveMerchantInput(initialCampaigns, 'Migros', 'auto');
assert.equal(migrosAuto.needsCategorySelection, false);
assert.equal(migrosAuto.effectiveCategory, 'market');
assert.equal(migrosAuto.context.source, 'registry');

// Katalog gürültülü/belirsiz olsa bile kullanıcı manuel kategori seçtiyse seçim kabul edilmeli.
const noisyCampaigns = [{ id:'n1', cardProductIds:['x'], categories:['seyahat','akaryakit','e-ticaret','sigorta'], merchantScope:{kind:'contains',values:['Bilinmeyen Merchant']}}];
const manual = resolveMerchantInput(noisyCampaigns, 'Bilinmeyen Merchant', 'market');
assert.equal(manual.needsCategorySelection, false);
assert.equal(manual.effectiveCategory, 'market');

// Güvenilir merchant sözlüğü açık çelişkiyi düzeltmeye devam eder.
const migrosWrong = resolveMerchantInput(initialCampaigns, 'Migros', 'e-ticaret');
assert.equal(migrosWrong.effectiveCategory, 'market');
console.log('v1.0.6 merchant category tests: OK');

// v1.0.8 regression: bilinmeyen bir restoran adı genel restoran kampanyalarını engellememeli.
{
  const cards = initialCards.filter(c => ['teb-infinite','is-maximiles-black','ykb-crystal'].includes(c.cardProductId));
  const campaigns = initialCampaigns.filter(c => ['official-teb-infinite-restoran-ultra','official-is-restoran-2026q3','official-ykb-crystal-restoran-2026-09'].includes(c.id));
  const states = {
    'official-teb-infinite-restoran-ultra': {campaignId:'official-teb-infinite-restoran-ultra',periodKey:'2026-09',enrollmentStatus:'not_required',remainingLimit:8000,valueSource:'user_confirmed',confirmedAt:'2026-09-24T08:00:00+03:00',updatedAt:'2026-09-24T08:00:00+03:00'},
    'official-is-restoran-2026q3': {campaignId:'official-is-restoran-2026q3',periodKey:'2026-09',enrollmentStatus:'not_required',remainingLimit:8000,valueSource:'user_confirmed',confirmedAt:'2026-09-24T08:00:00+03:00',updatedAt:'2026-09-24T08:00:00+03:00'},
    'official-ykb-crystal-restoran-2026-09': {campaignId:'official-ykb-crystal-restoran-2026-09',periodKey:'2026-09',enrollmentStatus:'not_required',remainingLimit:3000,valueSource:'user_confirmed',confirmedAt:'2026-09-24T08:00:00+03:00',updatedAt:'2026-09-24T08:00:00+03:00'}
  };
  const r = recommend({cards,campaigns,states,merchant:'Dragon',category:'restoran',amount:6000,locationScope:'domestic',paymentChannel:'physical',now:new Date('2026-09-24T09:00:00+03:00'),staleAfterDays:3});
  const teb=r.find(x=>x.card.cardProductId==='teb-infinite');
  const maxi=r.find(x=>x.card.cardProductId==='is-maximiles-black');
  const crystal=r.find(x=>x.card.cardProductId==='ykb-crystal');
  assert.ok(teb.best); assert.equal(teb.best.theoreticalReward,1200);
  assert.ok(maxi.best); assert.equal(maxi.best.theoreticalReward,600);
  assert.equal(crystal.best,null);
}
console.log('v1.0.8 Dragon restaurant regression: OK');

// v1.0.9: Sürekli kart ayrıcalıkları canlı crawler eksik olsa bile karar motorunda kalmalı.
{
  const wanted = ['official-wings-program-restoran-2026','official-teb-infinite-restoran-ultra','official-is-restoran-2026q3','official-ykb-crystal-restoran-2026-09'];
  const core = initialCampaigns.filter(c => wanted.includes(c.id));
  assert.equal(core.length, 4);
  assert.ok(core.every(c => c.coreBenefit === true));

  const wings = core.find(c => c.id === 'official-wings-program-restoran-2026');
  const wingsCard = {...initialCards.find(c => c.cardProductId === 'akbank-wings-black'), segment:'Black Plus / 2 milyon TL+'};
  const w = evaluateCampaign({campaign:wings,state:{campaignId:wings.id,periodKey:'2026-09',enrollmentStatus:'unknown',remainingLimit:2500,valueSource:'user_confirmed',confirmedAt:'2026-09-24T10:00:00+03:00',updatedAt:'2026-09-24T10:00:00+03:00'},card:wingsCard,merchant:'Da Mario',category:'restoran',amount:6000,locationScope:'domestic',paymentChannel:'physical',now:new Date('2026-09-24T11:00:00+03:00')});
  assert.equal(w.theoreticalReward, 900);
  assert.equal(w.enrollmentMissing, true);
  assert.equal(w.actualReward, 0);

  const states = {
    'official-wings-program-restoran-2026': {campaignId:'official-wings-program-restoran-2026',periodKey:'2026-09',enrollmentStatus:'joined',remainingLimit:2500,valueSource:'user_confirmed',confirmedAt:'2026-09-24T10:00:00+03:00',updatedAt:'2026-09-24T10:00:00+03:00'},
    'official-teb-infinite-restoran-ultra': {campaignId:'official-teb-infinite-restoran-ultra',periodKey:'2026-09',enrollmentStatus:'not_required',remainingLimit:8000,valueSource:'user_confirmed',confirmedAt:'2026-09-24T10:00:00+03:00',updatedAt:'2026-09-24T10:00:00+03:00'},
    'official-is-restoran-2026q3': {campaignId:'official-is-restoran-2026q3',periodKey:'2026-09',enrollmentStatus:'not_required',remainingLimit:8000,valueSource:'user_confirmed',confirmedAt:'2026-09-24T10:00:00+03:00',updatedAt:'2026-09-24T10:00:00+03:00'},
    'official-ykb-crystal-restoran-2026-09': {campaignId:'official-ykb-crystal-restoran-2026-09',periodKey:'2026-09',enrollmentStatus:'not_required',remainingLimit:3000,valueSource:'user_confirmed',confirmedAt:'2026-09-24T10:00:00+03:00',updatedAt:'2026-09-24T10:00:00+03:00'}
  };
  const cards = initialCards.filter(c => ['akbank-wings-black','teb-infinite','is-maximiles-black','ykb-crystal'].includes(c.cardProductId));
  const r = recommend({cards,campaigns:core,states,merchant:'Da Mario',category:'restoran',amount:6000,locationScope:'domestic',paymentChannel:'physical',now:new Date('2026-09-24T11:00:00+03:00'),staleAfterDays:3});
  assert.equal(r.find(x=>x.card.cardProductId==='teb-infinite').best.theoreticalReward,1200);
  assert.equal(r.find(x=>x.card.cardProductId==='ykb-crystal').best.theoreticalReward,1200);
  assert.equal(r.find(x=>x.card.cardProductId==='is-maximiles-black').best.theoreticalReward,600);
  assert.equal(r.find(x=>x.card.cardProductId==='akbank-wings-black').best.theoreticalReward,900);
}
console.log('v1.0.9 core benefit regression: OK');
