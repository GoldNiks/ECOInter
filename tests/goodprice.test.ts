import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGoodPriceStores } from '../server/services/goodprice.ts';

test('normalizes GoodPrice ask and bid offers into ECOInter total-price quotes', () => {
  const snapshot = normalizeGoodPriceStores({
    Stores: [
      {
        Name: '<color=orange>Wood Seller</color>', Owner: 'Alice', Balance: 25,
        CurrencyName: 'Calories', Enabled: true,
        AllOffers: [
          { ItemName: 'Wood', Buying: false, Price: 0.21, Quantity: 3, Enabled: true },
        ],
      },
      {
        Name: 'Wood Buyer', Owner: 'Bob', Balance: 50,
        CurrencyName: 'Calories', Enabled: true,
        AllOffers: [
          { ItemName: 'Wood', Buying: true, Price: 0.5, Quantity: 4, MaxNumWanted: 4, Enabled: true },
        ],
      },
    ],
  }, 'server-1', '2026-11-11T12:00:00.000Z');

  assert.equal(snapshot.sourceId, 'GoodPrice');
  assert.equal(snapshot.offers.length, 2);
  assert.deepEqual(snapshot.offers.map((offer) => ({
    itemId: offer.itemId,
    action: offer.action,
    quantity: offer.quantity,
    totalPrice: offer.totalPrice,
    currency: offer.currency,
  })), [
    { itemId: 'Wood', action: 'buy', quantity: 3, totalPrice: '0.63', currency: 'Calories' },
    { itemId: 'Wood', action: 'sell', quantity: 4, totalPrice: '2', currency: 'Calories' },
  ]);
  assert.equal(snapshot.offers[0].itemName, 'Wood');
  assert.equal(snapshot.offers[0].observedAt, '2026-11-11T12:00:00.000Z');
});

test('ignores empty slots, disabled offers, sentinel prices and zero-balance buyers', () => {
  const snapshot = normalizeGoodPriceStores({
    Stores: [
      {
        Name: 'Seller', Owner: 'Alice', Balance: 10, CurrencyName: 'Calories',
        AllOffers: [
          { ItemName: null, Buying: false, Price: 1, Quantity: 10 },
          { ItemName: 'Placeholder', Buying: false, Price: 999999, Quantity: 10 },
          { ItemName: 'Disabled', Buying: false, Price: 1, Quantity: 10, Enabled: false },
          { ItemName: 'No stock', Buying: false, Price: 1, Quantity: 0 },
        ],
      },
      {
        Name: 'Broke buyer', Owner: 'Bob', Balance: 0, CurrencyName: 'Calories',
        AllOffers: [
          { ItemName: 'Wood', Buying: true, Price: 5, Quantity: 10, MaxNumWanted: 10 },
        ],
      },
    ],
  }, 'server-1');
  assert.equal(snapshot.offers.length, 0);
});

test('keeps deterministic offer IDs across repeated snapshots', () => {
  const input = {
    Stores: [{
      Name: 'Seller', Owner: 'Alice', Balance: 10, CurrencyName: 'Calories',
      AllOffers: [{ ItemName: 'Stone', Buying: false, Price: 1.25, Quantity: 7 }],
    }],
  };
  const first = normalizeGoodPriceStores(input, 'server-1', '2026-11-11T12:00:00.000Z');
  const second = normalizeGoodPriceStores(input, 'server-1', '2026-11-11T12:05:00.000Z');
  assert.equal(first.offers[0].id, second.offers[0].id);
});
