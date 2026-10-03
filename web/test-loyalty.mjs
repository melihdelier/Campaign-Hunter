import assert from 'node:assert/strict';
import { calculateLoyalty } from './loyalty.js';

const wings = { cardProductId: 'akbank-wings-black' };
let e = calculateLoyalty({ card: wings, amount: 2000, merchant: 'Amazon', category: 'e-ticaret', locationScope: 'domestic', settings: { wingsTier: 'black_plus' } });
assert.equal(e.amount, 1320);
assert.equal(e.values.domesticFlightTry, 13.2);
assert.equal(e.values.internationalFlightTry, 26.4);

e = calculateLoyalty({ card: wings, amount: 2000, merchant: 'Da Mario', category: 'restoran', locationScope: 'domestic', settings: { wingsTier: 'black_plus' } });
assert.equal(e.amount, 3000);

const max = { cardProductId: 'is-maximiles-black' };
e = calculateLoyalty({ card: max, amount: 2000, merchant: 'Amazon', category: 'e-ticaret', locationScope: 'domestic', settings: { maximilesBand: '4m_8m' } });
assert.equal(e.amount, 30);
assert.equal(e.values.travelTry, 30);

const qnb = { cardProductId: 'qnb-ms-private' };
e = calculateLoyalty({ card: qnb, amount: 6000, merchant: 'THY', category: 'seyahat', locationScope: 'domestic', settings: { thyStatus: 'classic' } });
assert.equal(e.amount, 1000);
assert.equal(e.known, true);

e = calculateLoyalty({ card: qnb, amount: 1000, merchant: 'Da Mario', category: 'restoran', locationScope: 'domestic', settings: { thyStatus: 'classic' } });
assert.equal(e.known, true);
assert.equal(e.amount, 36);
e = calculateLoyalty({ card: qnb, amount: 1000, merchant: 'Da Mario', category: 'restoran', locationScope: 'domestic', settings: { thyStatus: 'elite' } });
assert.equal(e.amount, 54);

e = calculateLoyalty({ card: qnb, amount: 2000, merchant: 'Amazon', category: 'e-ticaret', locationScope: 'domestic', settings: { thyStatus: 'classic' } });
assert.equal(e.known, false);
console.log('loyalty tests: OK');
