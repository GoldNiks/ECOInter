import test from 'node:test';
import assert from 'node:assert/strict';
import type { AnalysisOptions, MarketOffer } from '../shared/types.ts';
import { DEFAULT_ANALYSIS_OPTIONS, analyzeMarket, findDirectOpportunities, findMultiStepRoutes } from '../server/engine/opportunities.ts';

const now = '2026-11-10T18:00:00.000Z';
const options: AnalysisOptions = {
  ...DEFAULT_ANALYSIS_OPTIONS, maxOperations: 6, maxUniqueItems: 6,
  maxIntermediateCurrencies: 4, minProfit: '0', minRoiPercent: '0', maxQuoteAgeSeconds: 3600,
};
const offer = (id: string, itemId: string, itemName: string, action: 'buy' | 'sell', currency: string, totalPrice: string, quantity: number): MarketOffer => ({
  id, serverId: 'server-1', itemId, itemName, action, currency,
  totalPrice, quantity, quoteKind: 'listing', observedAt: now,
});

const routeFixture: MarketOffer[] = [
  offer('a-ask', 'A', 'Товар A', 'buy', 'RELAX', '150', 3),
  offer('a-bid', 'A', 'Товар A', 'sell', 'GOLD', '200', 3),
  offer('b-ask', 'B', 'Товар B', 'buy', 'GOLD', '200', 2),
  offer('b-bid', 'B', 'Товар B', 'sell', 'RELAX', '500', 2),
];

test('direct search finds a same-server buy-low/sell-high trade', () => {
  const market = [
    offer('c-ask', 'C', 'Товар C', 'buy', 'RELAX', '50', 10),
    offer('c-bid', 'C', 'Товар C', 'sell', 'RELAX', '80', 10),
  ];
  const found = findDirectOpportunities(market, options, Date.parse(now));
  assert.equal(found.length, 1);
  assert.equal(found[0].quantity, 10);
  assert.equal(found[0].buyCost, '50');
  assert.equal(found[0].sellRevenue, '80');
  assert.equal(found[0].netProfit, '30');
  assert.equal(found[0].roiPercent, '60');
});

test('multi-step engine reproduces the two-currency example exactly', () => {
  const found = findMultiStepRoutes(routeFixture, {
    ...options, startingCapitalByCurrency: { RELAX: '150' },
  }, Date.parse(now));
  const route = found.find((x) => x.startCurrency === 'RELAX');
  assert.ok(route, 'expected RELAX -> GOLD -> RELAX cycle');
  assert.equal(route.initialCapital, '150');
  assert.equal(route.finalCapital, '500');
  assert.equal(route.netProfit, '350');
  assert.equal(route.roiPercent, '233.33333333');
  assert.equal(route.operations, 4);
  assert.deepEqual(route.legs.map((x) => [x.itemName, x.quantity]), [['Товар A', 3], ['Товар B', 2]]);
});

test('direct and multi-step analyses run independently', () => {
  const market = [...routeFixture,
    offer('c-ask', 'C', 'Товар C', 'buy', 'RELAX', '50', 10),
    offer('c-bid', 'C', 'Товар C', 'sell', 'RELAX', '80', 10),
  ];
  const found = analyzeMarket(market, { ...options, startingCapitalByCurrency: { RELAX: '150' } }, Date.parse(now));
  assert.ok(found.some((x) => x.kind === 'direct'));
  assert.ok(found.some((x) => x.kind === 'multi_step'));
});

test('inter-server price gap is informational, never marked executable', () => {
  const market: MarketOffer[] = [
    { ...offer('s1-ask', 'X', 'Товар X', 'buy', 'RELAX', '20', 5), serverId: 's1' },
    { ...offer('s2-bid', 'X', 'Товар X', 'sell', 'RELAX', '35', 5), serverId: 's2' },
  ];
  const found = analyzeMarket(market, options, Date.parse(now));
  const gap = found.find((x) => x.kind === 'interserver');
  assert.ok(gap);
  if (gap?.kind === 'interserver') assert.equal(gap.executable, false);
});

test('stale quotes are excluded', () => {
  const market = [
    { ...offer('old-ask', 'C', 'Товар C', 'buy', 'RELAX', '50', 10), observedAt: '2026-11-09T00:00:00.000Z' },
    { ...offer('old-bid', 'C', 'Товар C', 'sell', 'RELAX', '80', 10), observedAt: '2026-11-09T00:00:00.000Z' },
  ];
  assert.equal(findDirectOpportunities(market, options, Date.parse(now)).length, 0);
});

test('fees reduce net profit and are not assumed by default', () => {
  const market = [offer('ask', 'F', 'Fee Item', 'buy', 'RELAX', '50', 1), offer('bid', 'F', 'Fee Item', 'sell', 'RELAX', '80', 1)];
  const feeOptions = { ...options, feesByServer: { 'server-1': { buyPercent: '2', sellPercent: '2', taxPercent: '0', buyFixed: '0', sellFixed: '0' } } };
  const found = findDirectOpportunities(market, feeOptions, Date.parse(now));
  assert.equal(found[0].netProfit, '27.4');
});

test('direct search optimizes quantity across multiple price levels', () => {
  const market = [
    offer('ask-low', 'DEPTH', 'Depth Item', 'buy', 'RELAX', '50', 5),
    offer('ask-high', 'DEPTH', 'Depth Item', 'buy', 'RELAX', '75', 5),
    offer('bid', 'DEPTH', 'Depth Item', 'sell', 'RELAX', '120', 10),
  ];
  const found = findDirectOpportunities(market, options, Date.parse(now));
  assert.equal(found.length, 1);
  assert.equal(found[0].quantity, 5);
  assert.equal(found[0].buyCost, '50');
  assert.equal(found[0].sellRevenue, '60');
  assert.equal(found[0].netProfit, '10');
});


test('partial-lot buy costs round up while sale proceeds round down', () => {
  const market = [
    offer('fractional-ask', 'ROUND', 'Rounding Item', 'buy', 'RELAX', '1', 3),
    offer('fractional-bid', 'ROUND', 'Rounding Item', 'sell', 'RELAX', '0.4', 1),
  ];
  const found = findDirectOpportunities(market, options, Date.parse(now));
  assert.equal(found.length, 1);
  assert.equal(found[0].buyCost, '0.33333334');
  assert.equal(found[0].sellRevenue, '0.4');
  assert.equal(found[0].netProfit, '0.06666666');
});

test('future-dated quotes are excluded rather than treated as fresh', () => {
  const future = '2026-11-10T19:00:00.000Z';
  const market = [
    { ...offer('future-ask', 'FUTURE', 'Future Item', 'buy', 'RELAX', '50', 1), observedAt: future },
    { ...offer('future-bid', 'FUTURE', 'Future Item', 'sell', 'RELAX', '80', 1), observedAt: future },
  ];
  assert.equal(findDirectOpportunities(market, options, Date.parse(now)).length, 0);
});
