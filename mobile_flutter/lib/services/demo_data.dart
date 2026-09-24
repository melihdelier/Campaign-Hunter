import '../models/models.dart';

final demoCards = <UserCard>[
  const UserCard(id:'qnb', bank:'QNB', name:'Miles&Smiles QNB Private', segment:'Private', cardProductId:'qnb-ms-private'),
  const UserCard(id:'ae', bank:'Akbank', name:'Wings Elite', segment:'Üst segment', cardProductId:'akbank-wings-elite'),
  const UserCard(id:'ab', bank:'Akbank', name:'Wings Black', segment:'Üst segment', cardProductId:'akbank-wings-black'),
  const UserCard(id:'is', bank:'İş Bankası', name:'Maximiles Black', segment:'4–8 milyon TL', cardProductId:'is-maximiles-black'),
  const UserCard(id:'ykb', bank:'Yapı Kredi', name:'Crystal', segment:'1 milyon TL altı', cardProductId:'ykb-crystal'),
  const UserCard(id:'teb', bank:'TEB', name:'TEB Özel Infinite', segment:'Ultra', cardProductId:'teb-infinite'),
];

final demoCampaigns = <Campaign>[
  Campaign(id:'c-is', bank:'İş Bankası', title:'Maximiles Black — Restoran %20’ye Varan İndirim', category:'restoran', cardProductIds:const ['is-maximiles-black'], startDate:DateTime(2026,7,1), endDate:DateTime(2026,9,30), resetPolicy:ResetPolicy.monthly, periodCap:8000, rewardRule:const RewardRule(kind:RewardKind.tieredPercent, tiers:[RewardTier(min:4000,max:7999.99,rate:.10),RewardTier(min:8000,rate:.20)], perTransactionCap:3000), demo:false),
  Campaign(id:'c-teb', bank:'TEB', title:'TEB Infinite Ultra — Otel/Restoran %20', category:'restoran', cardProductIds:const ['teb-infinite'], startDate:DateTime(2026,1,1), resetPolicy:ResetPolicy.monthly, periodCap:8000, rewardRule:const RewardRule(kind:RewardKind.percent, rate:.20, minSpend:1500, perTransactionCap:2000), demo:false),
  Campaign(id:'c-ykb', bank:'Yapı Kredi', title:'DEMO — Restoran %20', category:'restoran', cardProductIds:const ['ykb-crystal'], startDate:DateTime(2026,9,1), endDate:DateTime(2026,9,30), resetPolicy:ResetPolicy.monthly, periodCap:3000, rewardRule:const RewardRule(kind:RewardKind.percent, rate:.20, perTransactionCap:1500), demo:true),
  Campaign(id:'c-ak', bank:'Akbank', title:'DEMO — Giyimde 1.500 TL chip-para', category:'giyim', cardProductIds:const ['akbank-wings-elite','akbank-wings-black'], startDate:DateTime(2026,9,1), endDate:DateTime(2026,9,30), requiresEnrollment:true, resetPolicy:ResetPolicy.campaign, periodCap:1500, rewardRule:const RewardRule(kind:RewardKind.fixed, minSpend:15000, reward:1500), demo:true),
];

final demoStates = <String,CampaignState>{
  'c-is': CampaignState(campaignId:'c-is', periodKey:'2026-09', enrollmentStatus:EnrollmentStatus.notRequired, remainingLimit:8000, usedAmount:0, valueSource:ValueSource.reset, confirmedAt:DateTime(2026,9,1), updatedAt:DateTime(2026,9,1)),
  'c-teb': CampaignState(campaignId:'c-teb', periodKey:'2026-09', enrollmentStatus:EnrollmentStatus.notRequired, remainingLimit:8000, usedAmount:0, valueSource:ValueSource.reset, confirmedAt:DateTime(2026,9,1), updatedAt:DateTime(2026,9,1)),
  'c-ykb': CampaignState(campaignId:'c-ykb', periodKey:'2026-09', enrollmentStatus:EnrollmentStatus.notRequired, remainingLimit:null, usedAmount:null, valueSource:ValueSource.systemEstimated, confirmedAt:null, updatedAt:DateTime(2026,9,1)),
  'c-ak': CampaignState(campaignId:'c-ak', periodKey:'c-ak:2026-09-01T00:00:00.000:2026-09-30T00:00:00.000', enrollmentStatus:EnrollmentStatus.unknown, remainingLimit:1500, usedAmount:0, valueSource:ValueSource.reset, confirmedAt:DateTime(2026,9,1), updatedAt:DateTime(2026,9,1)),
};
