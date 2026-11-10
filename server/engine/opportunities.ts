import type {
  AnalysisOptions, DirectOpportunity, FeePolicy, InterserverDifference,
  MarketOffer, MultiStepOpportunity, Opportunity, RouteLeg,
} from '../../shared/types.ts';
import { add, compareUnitPrice, floorUnits, money, moneyString, mul, mulInt, portion, ratioPercent, sub } from '../domain/money.ts';

const ZERO = 0n;
const DEFAULT_FEES: FeePolicy = { buyPercent: '0', sellPercent: '0', taxPercent: '0', buyFixed: '0', sellFixed: '0' };

function feePolicy(options: AnalysisOptions, serverId: string): FeePolicy {
  return options.feesByServer?.[serverId] ?? DEFAULT_FEES;
}
function fresh(offer: MarketOffer, maxAgeSeconds: number, now: number): boolean {
  const stamp = Date.parse(offer.observedAt);
  return Number.isFinite(stamp) && stamp <= now && now - stamp <= maxAgeSeconds * 1000;
}
function validOffer(offer: MarketOffer): boolean {
  try {
    return Number.isSafeInteger(offer.quantity) && offer.quantity > 0 && money(offer.totalPrice) > ZERO && !!offer.currency;
  } catch { return false; }
}
function quoteKind(offers: MarketOffer[]): 'listing' | 'reference' {
  return offers.every((offer) => offer.quoteKind === 'listing') ? 'listing' : 'reference';
}
function oldestTimestamp(offers: MarketOffer[]): string {
  return offers.map((x) => x.observedAt).sort()[0] ?? new Date(0).toISOString();
}
function grossCost(offer: MarketOffer, qty: number): bigint { return portion(money(offer.totalPrice), qty, offer.quantity); }
function grossCostCeil(offer: MarketOffer, qty: number): bigint {
  const total = money(offer.totalPrice);
  if (qty === offer.quantity) return total;
  const numerator = total * BigInt(qty), divisor = BigInt(offer.quantity);
  return numerator / divisor + (numerator % divisor === 0n ? 0n : 1n);
}

function unitPriceFloor(offer: MarketOffer): bigint { return money(offer.totalPrice) / BigInt(offer.quantity); }
function unitPriceCeil(offer: MarketOffer): bigint {
  const total = money(offer.totalPrice), quantity = BigInt(offer.quantity);
  return total / quantity + (total % quantity === 0n ? 0n : 1n);
}

/** Search executable same-server/same-currency depth matches. */
export function findDirectOpportunities(
  input: MarketOffer[], options: AnalysisOptions, now = Date.now(),
): DirectOpportunity[] {
  const eligible = input.filter((o) => validOffer(o) && fresh(o, options.maxQuoteAgeSeconds, now));
  const groups = new Map<string, MarketOffer[]>();
  for (const offer of eligible) {
    const key = `${offer.serverId}\u0000${offer.itemId}\u0000${offer.currency}`;
    groups.set(key, [...(groups.get(key) ?? []), offer]);
  }
  const results: DirectOpportunity[] = [];
  for (const offers of groups.values()) {
    const asks = offers.filter((o) => o.action === 'buy').sort((a, b) => compareUnitPrice(money(a.totalPrice), a.quantity, money(b.totalPrice), b.quantity));
    const bids = offers.filter((o) => o.action === 'sell').sort((a, b) => -compareUnitPrice(money(a.totalPrice), a.quantity, money(b.totalPrice), b.quantity));
    if (!asks.length || !bids.length) continue;
    const serverId = asks[0].serverId;
    const fees = feePolicy(options, serverId);
    const buyPct = money(fees.buyPercent);
    const sellPct = money(fees.sellPercent);
    const taxPct = money(fees.taxPercent);
    let i = 0, j = 0, askLeft = asks[0].quantity, bidLeft = bids[0].quantity;
    let qty = 0, buyCost = ZERO, sellRevenue = ZERO, feesTotal = ZERO;
    const buyIds: string[] = [], sellIds: string[] = [], matched: MarketOffer[] = [];
    while (i < asks.length && j < bids.length) {
      const ask = asks[i], bid = bids[j];
      const marginalBuy = add(unitPriceCeil(ask), percentOfSafe(unitPriceCeil(ask), buyPct));
      const marginalSell = sub(unitPriceFloor(bid), add(percentOfSafe(unitPriceFloor(bid), sellPct), percentOfSafe(unitPriceFloor(bid), taxPct)));
      if (marginalBuy >= marginalSell) break;
      const take = Math.min(askLeft, bidLeft);
      const costPart = grossCostCeil(ask, take);
      const revenuePart = grossCost(bid, take);
      const buyFee = percentOfSafe(costPart, buyPct);
      const sellFee = percentOfSafe(revenuePart, sellPct);
      const tax = percentOfSafe(revenuePart, taxPct);
      buyCost = add(buyCost, costPart);
      sellRevenue = add(sellRevenue, revenuePart);
      feesTotal = add(feesTotal, add(buyFee, add(sellFee, tax)));
      qty += take;
      buyIds.push(ask.id); sellIds.push(bid.id); matched.push(ask, bid);
      askLeft -= take; bidLeft -= take;
      if (askLeft === 0) { i++; askLeft = asks[i]?.quantity ?? 0; }
      if (bidLeft === 0) { j++; bidLeft = bids[j]?.quantity ?? 0; }
    }
    feesTotal = add(feesTotal, add(money(fees.buyFixed), money(fees.sellFixed)));
    const capital = add(buyCost, add(percentOfSafe(buyCost, buyPct), money(fees.buyFixed)));
    const netProceeds = sub(sellRevenue, add(percentOfSafe(sellRevenue, sellPct), add(percentOfSafe(sellRevenue, taxPct), money(fees.sellFixed))));
    const profit = sub(netProceeds, capital);
    if (qty <= 0 || profit <= ZERO || profit < money(options.minProfit) || ratioPercent(profit, capital) < money(options.minRoiPercent)) continue;
    const first = asks[0];
    results.push({
      id: `direct:${serverId}:${first.itemId}:${first.currency}:${buyIds.join(',')}:${sellIds.join(',')}`,
      kind: 'direct', serverId, itemId: first.itemId, itemName: first.itemName,
      currency: first.currency, quantity: qty, buyCost: moneyString(buyCost),
      sellRevenue: moneyString(sellRevenue), fees: moneyString(feesTotal),
      netProfit: moneyString(profit), roiPercent: moneyString(ratioPercent(profit, capital)),
      quoteKind: quoteKind(matched), observedAt: oldestTimestamp(matched),
      buyOfferIds: [...new Set(buyIds)], sellOfferIds: [...new Set(sellIds)],
    });
  }
  return results.sort((a, b) => compareProfit(b.netProfit, a.netProfit)).slice(0, options.maxResults);
}

function percentOfSafe(amount: bigint, percent: bigint): bigint {
  const numerator = amount * percent;
  const denominator = 100n * 100_000_000n;
  return numerator / denominator + (numerator % denominator === 0n ? 0n : 1n);
}
function compareProfit(a: string, b: string): number {
  const aa = money(a), bb = money(b);
  return aa < bb ? -1 : aa > bb ? 1 : 0;
}

/** Cross-server price gaps are informational only: no asset transfer is assumed. */
export function findInterserverDifferences(input: MarketOffer[], options: AnalysisOptions, now = Date.now()): InterserverDifference[] {
  const eligible = input.filter((o) => validOffer(o) && fresh(o, options.maxQuoteAgeSeconds, now));
  const groups = new Map<string, MarketOffer[]>();
  for (const offer of eligible) {
    const key = `${offer.itemId}\u0000${offer.currency}`;
    groups.set(key, [...(groups.get(key) ?? []), offer]);
  }
  const results: InterserverDifference[] = [];
  for (const offers of groups.values()) {
    const asks = offers.filter((o) => o.action === 'buy').sort((a, b) => compareUnitPrice(money(a.totalPrice), a.quantity, money(b.totalPrice), b.quantity));
    const bids = offers.filter((o) => o.action === 'sell').sort((a, b) => -compareUnitPrice(money(a.totalPrice), a.quantity, money(b.totalPrice), b.quantity));
    const ask = asks.find((a) => bids.some((b) => b.serverId !== a.serverId && compareUnitPrice(money(a.totalPrice), a.quantity, money(b.totalPrice), b.quantity) < 0));
    if (!ask) continue;
    const bid = bids.find((b) => b.serverId !== ask.serverId && compareUnitPrice(money(ask.totalPrice), ask.quantity, money(b.totalPrice), b.quantity) < 0);
    if (!bid) continue;
    const quantity = Math.min(ask.quantity, bid.quantity);
    const buy = grossCostCeil(ask, quantity), sell = grossCost(bid, quantity);
    const gap = sub(sell, buy);
    if (gap <= ZERO) continue;
    results.push({
      id: `gap:${ask.itemId}:${ask.serverId}:${bid.serverId}:${ask.currency}`,
      kind: 'interserver', itemId: ask.itemId, itemName: ask.itemName, currency: ask.currency,
      buyServerId: ask.serverId, sellServerId: bid.serverId, quantity,
      referenceBuyCost: moneyString(buy), referenceSellRevenue: moneyString(sell), priceGap: moneyString(gap),
      executable: false, reason: 'Перенос товара или валюты между этими серверами не подтверждён',
      observedAt: oldestTimestamp([ask, bid]),
    });
  }
  return results.sort((a, b) => compareProfit(b.priceGap, a.priceGap)).slice(0, options.maxResults);
}

interface ConversionEdge {
  key: string;
  serverId: string;
  itemId: string;
  itemName: string;
  fromCurrency: string;
  toCurrency: string;
  buy: MarketOffer;
  sell: MarketOffer;
  capacity: number;
}
function buildEdges(offers: MarketOffer[], options: AnalysisOptions, now: number): ConversionEdge[] {
  const eligible = offers.filter((o) => validOffer(o) && fresh(o, options.maxQuoteAgeSeconds, now));
  const grouped = new Map<string, MarketOffer[]>();
  for (const o of eligible) {
    const key = `${o.serverId}\u0000${o.itemId}`;
    grouped.set(key, [...(grouped.get(key) ?? []), o]);
  }
  const edges: ConversionEdge[] = [];
  for (const group of grouped.values()) {
    const buys = group.filter((o) => o.action === 'buy');
    const sells = group.filter((o) => o.action === 'sell');
    for (const buy of buys) for (const sell of sells) {
      if (buy.currency === sell.currency || buy.serverId !== sell.serverId) continue;
      edges.push({
        key: `${buy.id}->${sell.id}`, serverId: buy.serverId, itemId: buy.itemId,
        itemName: buy.itemName, fromCurrency: buy.currency, toCurrency: sell.currency,
        buy, sell, capacity: Math.min(buy.quantity, sell.quantity),
      });
    }
  }
  return edges;
}

function executeEdge(edge: ConversionEdge, balance: bigint, options: AnalysisOptions): RouteLeg | null {
  const fees = feePolicy(options, edge.serverId);
  const buyPct = money(fees.buyPercent), sellPct = money(fees.sellPercent), taxPct = money(fees.taxPercent);
  const buyFixed = money(fees.buyFixed), sellFixed = money(fees.sellFixed);
  const total = money(edge.buy.totalPrice);
  const divisor = BigInt(edge.buy.quantity);
  const perUnit = total / divisor + (total % divisor === 0n ? 0n : 1n);
  const allInPerUnit = add(perUnit, percentOfSafe(perUnit, buyPct));
  const spendable = sub(balance, buyFixed);
  const quantity = Math.min(edge.capacity, floorUnits(spendable, allInPerUnit));
  if (quantity < 1) return null;
  const buyCost = grossCostCeil(edge.buy, quantity);
  const buyFee = add(percentOfSafe(buyCost, buyPct), buyFixed);
  const inputUsed = add(buyCost, buyFee);
  if (inputUsed > balance) return null;
  const sellGross = grossCost(edge.sell, quantity);
  const sellFees = add(percentOfSafe(sellGross, sellPct), add(percentOfSafe(sellGross, taxPct), sellFixed));
  const output = sub(sellGross, sellFees);
  if (output <= ZERO) return null;
  return {
    itemId: edge.itemId, itemName: edge.itemName, serverId: edge.serverId, quantity,
    fromCurrency: edge.fromCurrency, toCurrency: edge.toCurrency,
    buyCost: moneyString(buyCost), sellRevenue: moneyString(sellGross),
    feesFrom: moneyString(buyFee), feesTo: moneyString(sellFees),
    inputBalance: moneyString(balance), outputBalance: moneyString(output),
    buyOfferId: edge.buy.id, sellOfferId: edge.sell.id,
  };
}

/** Search currency cycles via goods. Every leg is a buy+sell pair; routes are independent of direct-deal search. */
export function findMultiStepRoutes(
  offers: MarketOffer[], options: AnalysisOptions, now = Date.now(),
): MultiStepOpportunity[] {
  const edges = buildEdges(offers, options, now);
  const currencies = [...new Set(edges.map((e) => e.fromCurrency))];
  const results: MultiStepOpportunity[] = [];
  const maxLegs = Math.max(2, Math.floor(options.maxOperations / 2));
  const startCapital = options.startingCapitalByCurrency ?? {};
  const starts = Object.keys(startCapital).length ? Object.keys(startCapital) : currencies;
  const seen = new Set<string>();

  const startedAt = Date.now();
  let combinations = 0;
  let stopped = false;
  for (const start of starts) {
    if (stopped) break;
    const outgoing = edges.filter((e) => e.fromCurrency === start);
    if (!outgoing.length) continue;
    const explicit = startCapital[start];
    const assumedCapital = explicit === undefined;
    const initial = explicit !== undefined
      ? money(explicit)
      : outgoing.reduce((max, edge) => {
          const required = add(money(edge.buy.totalPrice), add(percentOfSafe(money(edge.buy.totalPrice), money(feePolicy(options, edge.serverId).buyPercent)), money(feePolicy(options, edge.serverId).buyFixed)));
          return required > max ? required : max;
        }, ZERO);
    if (initial <= ZERO || (options.maxStartingCapital && initial > money(options.maxStartingCapital))) continue;

    const walk = (currency: string, balance: bigint, legs: RouteLeg[], usedItems: Set<string>, seenCurrencies: Set<string>) => {
      if (legs.length >= maxLegs) return;
      const candidates = edges.filter((e) => e.fromCurrency === currency && e.serverId === (legs[0]?.serverId ?? e.serverId) && !usedItems.has(e.itemId));
      for (const edge of candidates) {
        combinations++;
        if (combinations > options.maxCombinations || Date.now() - startedAt > options.maxDurationMs) { stopped = true; break; }
        const closesCycle = edge.toCurrency === start;
        if (!closesCycle && seenCurrencies.has(edge.toCurrency)) continue;
        if (!closesCycle && seenCurrencies.size - 1 >= options.maxIntermediateCurrencies) continue;
        if (usedItems.size >= options.maxUniqueItems) continue;
        const leg = executeEdge(edge, balance, options);
        if (!leg) continue;
        const nextLegs = [...legs, leg];
        if (closesCycle) {
          if (nextLegs.length < 2) continue;
          const routeId = nextLegs.map((x) => `${x.buyOfferId}:${x.sellOfferId}`).join('|');
          if (seen.has(routeId)) continue;
          seen.add(routeId);
          const finalCapital = money(leg.outputBalance);
          const profit = sub(finalCapital, initial);
          const capital = initial;
          if (profit <= ZERO || profit < money(options.minProfit) || ratioPercent(profit, capital) < money(options.minRoiPercent)) continue;
          const usedQuotes = nextLegs.flatMap((x) => [offers.find((o) => o.id === x.buyOfferId), offers.find((o) => o.id === x.sellOfferId)]).filter(Boolean) as MarketOffer[];
          results.push({
            id: `route:${start}:${routeId}`, kind: 'multi_step', serverId: edge.serverId,
            startCurrency: start, endCurrency: start, initialCapital: moneyString(capital),
            finalCapital: moneyString(finalCapital), netProfit: moneyString(profit),
            roiPercent: moneyString(ratioPercent(profit, capital)), operations: nextLegs.length * 2,
            legs: nextLegs, quoteKind: quoteKind(usedQuotes), observedAt: oldestTimestamp(usedQuotes),
            capitalAssumed: assumedCapital,
          });
          continue;
        }
        const nextUsed = new Set(usedItems); nextUsed.add(edge.itemId);
        const nextCurrencies = new Set(seenCurrencies); nextCurrencies.add(edge.toCurrency);
        walk(edge.toCurrency, money(leg.outputBalance), nextLegs, nextUsed, nextCurrencies);
      }
    };
    walk(start, initial, [], new Set(), new Set([start]));
  }
  return results.sort((a, b) => compareProfit(b.netProfit, a.netProfit)).slice(0, options.maxResults);
}

export function analyzeMarket(offers: MarketOffer[], options: AnalysisOptions, now = Date.now()): Opportunity[] {
  // These passes intentionally run independently; one search type never suppresses the other.
  const direct = findDirectOpportunities(offers, options, now);
  const routes = findMultiStepRoutes(offers, options, now);
  const interserver = findInterserverDifferences(offers, options, now);
  return [...direct, ...routes, ...interserver].sort((a, b) => {
    const ap = a.kind === 'interserver' ? a.priceGap : a.netProfit;
    const bp = b.kind === 'interserver' ? b.priceGap : b.netProfit;
    return compareProfit(bp, ap);
  });
}

export const DEFAULT_ANALYSIS_OPTIONS: AnalysisOptions = {
  maxOperations: 6, maxUniqueItems: 6, maxIntermediateCurrencies: 4,
  maxResults: 100, maxCombinations: 25000, maxDurationMs: 2000, minProfit: '0', minRoiPercent: '0', maxQuoteAgeSeconds: 900,
};
