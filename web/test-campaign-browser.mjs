import assert from 'node:assert/strict';
import {campaignMatchesCategory, campaignActiveNow, merchantScopeInfo, groupCampaignsByCard} from './campaign-browser.js';

const cards=[{active:true,cardProductId:'a',segment:'Ultra',bank:'TEB',name:'Infinite'},{active:true,cardProductId:'b',segment:'X',bank:'B',name:'B'}];
const campaigns=[
 {id:'fuel1',title:'Shell yakıt',categories:['akaryakit'],cardProductIds:['a'],status:'active',startDate:'2026-09-01',endDate:'2026-09-30',merchantScope:{kind:'contains',values:['Shell']},eligibility:{segmentLabels:['Ultra']}},
 {id:'food1',title:'Restoran',categories:['restoran'],cardProductIds:['a'],status:'active'},
 {id:'fuel2',title:'Opet',categories:['akaryakit'],cardProductIds:['b'],status:'active',merchantScope:{kind:'restricted_unknown'}},
];
assert.equal(campaignMatchesCategory(campaigns[0],'akaryakit'),true);
assert.equal(campaignMatchesCategory(campaigns[1],'akaryakit'),false);
assert.equal(campaignActiveNow(campaigns[0],new Date('2026-09-24T12:00:00')),true);
assert.equal(campaignActiveNow(campaigns[0],new Date('2026-10-01T12:00:00')),false);
assert.equal(merchantScopeInfo(campaigns[0]).text,'Shell');
assert.match(merchantScopeInfo(campaigns[2]).text,/seçili\/anlaşmalı/i);
const groups=groupCampaignsByCard({campaigns,cards,category:'akaryakit',resolveCampaign:(x)=>x,now:new Date('2026-09-24T12:00:00')});
assert.deepEqual(groups.map(g=>g.campaigns.length),[1,1]);
console.log('campaign-browser tests ok');
