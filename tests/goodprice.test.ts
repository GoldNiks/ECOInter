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

test('flags incoming buyer orders at specialized profession markets', () => {
  const snapshot = normalizeGoodPriceStores({
    Stores: [
      {
        Name: 'Охотничий рынок', Owner: 'Hunter Guild', Balance: 500,
        CurrencyName: 'Мухоморск Credit', Enabled: true,
        AllOffers: [
          { ItemName: 'Исследования базовой геологии', Buying: true, Price: 100, Quantity: 5, MaxNumWanted: 5, Enabled: true },
          { ItemName: 'Шкура', Buying: true, Price: 10, Quantity: 20, MaxNumWanted: 20, Enabled: true },
          { ItemName: 'Рыба', Buying: false, Price: 5, Quantity: 20, Enabled: true },
        ],
      },
      {
        Name: 'Обычный магазин игрока', Owner: 'Alice', Balance: 500,
        CurrencyName: 'Мухоморск Credit', Enabled: true,
        AllOffers: [
          { ItemName: 'Исследования базовой геологии', Buying: true, Price: 100, Quantity: 5, MaxNumWanted: 5, Enabled: true },
        ],
      },
    ],
  }, 'server-1', '2026-11-11T12:00:00.000Z');

  const research = snapshot.offers.find((offer) => offer.itemName === 'Исследования базовой геологии' && offer.storeName === 'Охотничий рынок');
  const hide = snapshot.offers.find((offer) => offer.itemName === 'Шкура');
  const fishAsk = snapshot.offers.find((offer) => offer.itemName === 'Рыба');
  const normalShop = snapshot.offers.find((offer) => offer.storeName === 'Обычный магазин игрока');

  assert.ok(research);
  assert.equal(research.tradeAllowed, false);
  assert.match(research.tradeRestriction ?? '', /охотничий рынок/iu);
  assert.equal(research.storeName, 'Охотничий рынок');
  assert.ok(research.storeId);
  assert.ok(hide);
  assert.equal(hide.tradeAllowed, false);
  assert.ok(fishAsk);
  assert.equal(fishAsk.tradeAllowed, true, 'items sold by the market are not blocked by its inbound-storage rule');
  assert.ok(normalShop);
  assert.equal(normalShop.tradeAllowed, true, 'ordinary player shops stay eligible');
});

test('detects English MarketMod profession market names', () => {
  const snapshot = normalizeGoodPriceStores({
    Stores: [{
      Name: 'Hunter Market', Owner: 'Guild', Balance: 100,
      CurrencyName: 'Credits', Enabled: true,
      AllOffers: [{ ItemName: 'Basic Geology Research', Buying: true, Price: 10, Quantity: 1, MaxNumWanted: 1 }],
    }],
  }, 'server-1');
  assert.equal(snapshot.offers[0].tradeAllowed, false);
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


test('store location IDs remain stable when GoodPrice changes store ordering', () => {
  const stores = [
    { Name: 'North Market', Owner: 'Alice', Balance: 100, CurrencyName: 'Credits', Enabled: true,
      AllOffers: [{ ItemName: 'Stone', Buying: false, Price: 1, Quantity: 1 }] },
    { Name: 'South Market', Owner: 'Bob', Balance: 100, CurrencyName: 'Credits', Enabled: true,
      AllOffers: [{ ItemName: 'Wood', Buying: false, Price: 1, Quantity: 1 }] },
  ];
  const first = normalizeGoodPriceStores({ Stores: stores }, 'server-1');
  const reordered = normalizeGoodPriceStores({ Stores: [...stores].reverse() }, 'server-1');
  const firstIds = new Map(first.offers.map((offer) => [offer.storeName, offer.storeId]));
  const reorderedIds = new Map(reordered.offers.map((offer) => [offer.storeName, offer.storeId]));
  assert.deepEqual([...reorderedIds], [...firstIds].reverse());
  assert.equal(reorderedIds.get('North Market'), firstIds.get('North Market'));
  assert.equal(reorderedIds.get('South Market'), firstIds.get('South Market'));
});
