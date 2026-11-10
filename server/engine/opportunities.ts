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
function storeKey(serverId: string, storeId?: string, storeName?: string): string {
  return `${serverId}::${storeId?.trim() || storeName?.trim() || 'unknown'}`;
}
function normalizedItemName(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('ru-RU');
}
function storeLocation(options: AnalysisOptions, serverId: string, storeId?: string, storeName?: string) {
  const location = options.storeLocations?.[storeKey(serverId, storeId, storeName)];
  return location && Number.isFinite(location.x) && Number.isFinite(location.z)
    ? { x: location.x as number, z: location.z as number }
    : null;
}
function distanceBetweenStores(
  options: AnalysisOptions,
  serverId: string,
  a: { storeId?: string; storeName?: string },
  b: { storeId?: string; storeName?: string },
): number | null {
  const left = storeLocation(options, serverId, a.storeId, a.storeName);
  const right = storeLocation(options, serverId, b.storeId, b.storeName);
  if (!left || !right) return null;
  return Math.round(Math.hypot(left.x - right.x, left.z - right.z) * 100) / 100;
}
function isManuallyAccepted(offer: MarketOffer, options: AnalysisOptions): boolean {
  const accepted = options.storeAcceptedItems?.[storeKey(offer.serverId, offer.storeId, offer.storeName)] ?? [];
  return accepted.some((name) => normalizedItemName(name) === normalizedItemName(offer.itemName));
}
function validOffer(offer: MarketOffer, options: AnalysisOptions): boolean {
  // Professional-store offers stay excluded until the user explicitly confirms
  // this exact item for this exact store in local settings.
  if (offer.tradeAllowed === false && !isManuallyAccepted(offer, options)) return false;
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
  const eligible = input.filter((o) => validOffer(o, options) && fresh(o, options.maxQuoteAgeSeconds, now));
  const groups = new Map<string, MarketOffer[]>();
  for (const offer of eligible) {
    const key = `${offer.serverId}\\u0000${offer.itemId}\\u0000${currencyKey(offer.currency)}`;
    groups.set(key, [...(groups.get(key) ?? []), offer]);
  }

  const results: DirectOpportunity[] = [];
  for (const offers of groups.values()) {
    const asksByStore = new Map<string, MarketOffer[]>();
    const bidsByStore = new Map<string, MarketOffer[]>();
    for (const offer of offers) {
      const key = storeKey(offer.serverId, offer.storeId, offer.storeName);
      const target = offer.action === 'buy' ? asksByStore : bidsByStore;
      target.set(key, [...(target.get(key) ?? []), offer]);
    }

    // Every physical buy-store/sell-store pair is evaluated separately. This
    // preserves alternatives instead of merging the whole server into one deal.
    for (const asksRaw of asksByStore.values()) {
      const asks = [...asksRaw].sort((a, b) => compareUnitPrice(
        money(a.totalPrice), a.quantity, money(b.totalPrice), b.quantity,
      ));
      for (const bidsRaw of bidsByStore.values()) {
        const bids = [...bidsRaw].sort((a, b) => -compareUnitPrice(
          money(a.totalPrice), a.quantity, money(b.totalPrice), b.quantity,
        ));
        if (!asks.length || !bids.length) continue;

        const first = asks[0], last = bids[0];
        const fees = feePolicy(options, first.serverId);
        const buyPct = money(fees.buyPercent);
        const sellPct = money(fees.sellPercent);
        const taxPct = money(fees.taxPercent);
        let i = 0, j = 0, askLeft = asks[0].quantity, bidLeft = bids[0].quantity;
        let qty = 0, buyCost = ZERO, sellRevenue = ZERO, feesTotal = ZERO;
        const buyIds: string[] = [], sellIds: string[] = [], matched: MarketOffer[] = [];
        while (i < asks.length && j < bids.length) {
          const ask = asks[i], bid = bids[j];
          const marginalBuy = add(unitPriceCeil(ask), percentOfSafe(unitPriceCeil(ask), buyPct));
          const marginalSell = sub(unitPriceFloor(bid), add(
            percentOfSafe(unitPriceFloor(bid), sellPct),
            percentOfSafe(unitPriceFloor(bid), taxPct),
          ));
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
        if (qty <= 0) continue;
        feesTotal = add(feesTotal, add(money(fees.buyFixed), money(fees.sellFixed)));
        const capital = add(buyCost, add(percentOfSafe(buyCost, buyPct), money(fees.buyFixed)));
        const netProceeds = sub(sellRevenue, add(
          percentOfSafe(sellRevenue, sellPct),
          add(percentOfSafe(sellRevenue, taxPct), money(fees.sellFixed)),
        ));
        const profit = sub(netProceeds, capital);
        if (profit <= ZERO || profit < money(options.minProfit)
          || ratioPercent(profit, capital) < money(options.minRoiPercent)) continue;

        const distanceUnits = distanceBetweenStores(options, first.serverId,
          { storeId: first.storeId, storeName: first.storeName },
          { storeId: last.storeId, storeName: last.storeName });
        const uniqueBuyIds = [...new Set(buyIds)];
        const uniqueSellIds = [...new Set(sellIds)];
        results.push({
          id: `direct:${first.serverId}:${first.itemId}:${first.currency}:${storeKey(first.serverId, first.storeId, first.storeName)}:${storeKey(last.serverId, last.storeId, last.storeName)}:${uniqueBuyIds.join(',')}:${uniqueSellIds.join(',')}`,
          kind: 'direct', serverId: first.serverId, itemId: first.itemId, itemName: first.itemName,
          currency: first.currency, quantity: qty, buyCost: moneyString(buyCost),
          sellRevenue: moneyString(sellRevenue), fees: moneyString(feesTotal),
          netProfit: moneyString(profit), roiPercent: moneyString(ratioPercent(profit, capital)),
          quoteKind: quoteKind(matched), observedAt: oldestTimestamp(matched),
          buyOfferIds: uniqueBuyIds, sellOfferIds: uniqueSellIds,
          buyStoreId: first.storeId, buyStoreName: first.storeName ?? 'Магазин не указан',
          sellStoreId: last.storeId, sellStoreName: last.storeName ?? 'Магазин не указан',
          distanceUnits, offerCount: new Set([...uniqueBuyIds, ...uniqueSellIds]).size,
        });
      }
    }
  }
  return results.sort((a, b) => compareQuality(
    a.netProfit, a.distanceUnits ?? null, a.offerCount ?? 0, a.quantity,
    b.netProfit, b.distanceUnits ?? null, b.offerCount ?? 0, b.quantity,
  )).slice(0, options.maxResults);
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
/** Ranking balances net profit, known travel distance and usable order-book depth. */
function qualityScore(profit: string, distance: number | null, offerCount: number, quantity: number): number {
  const profitValue = Number(profit);
  const distanceFactor = distance === null ? 1 : 1 / (1 + distance / 100);
  const depthFactor = 1 + Math.log2(1 + Math.max(0, offerCount)) * 0.08
    + Math.log2(1 + Math.max(0, quantity)) * 0.04;
  return profitValue * distanceFactor * depthFactor;
}
function compareQuality(
  profitA: string, distanceA: number | null, offersA: number, quantityA: number,
  profitB: string, distanceB: number | null, offersB: number, quantityB: number,
): number {
  const scoreA = qualityScore(profitA, distanceA, offersA, quantityA);
  const scoreB = qualityScore(profitB, distanceB, offersB, quantityB);
  if (scoreA !== scoreB) return scoreB - scoreA;
  const byProfit = compareProfit(profitA, profitB);
  if (byProfit !== 0) return byProfit;
  if (distanceA !== null && distanceB !== null && distanceA !== distanceB) return distanceA - distanceB;
  return offersB - offersA;
}

/** Cross-server price gaps are informational only: no asset transfer is assumed. */
export function findInterserverDifferences(input: MarketOffer[], options: AnalysisOptions, now = Date.now()): InterserverDifference[] {
  const eligible = input.filter((o) => validOffer(o, options) && fresh(o, options.maxQuoteAgeSeconds, now));
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
  buyOffers: MarketOffer[];
  sellOffers: MarketOffer[];
  capacity: number;
  buyStoreId?: string;
  buyStoreName?: string;
  sellStoreId?: string;
  sellStoreName?: string;
  distanceUnits: number | null;
}
function currencyKey(currency: string): string {
  return currency.trim().normalize('NFKC').toLocaleLowerCase('ru-RU');
}

function totalListedQuantity(book: MarketOffer[]): number {
  return book.reduce((sum, offer) => Math.min(Number.MAX_SAFE_INTEGER, sum + offer.quantity), 0);
}

/** Prefix boundaries preserve both shallow, high-margin fills and deeper fills. */
function quantityBreakpoints(book: MarketOffer[], limit: number): number[] {
  const points = new Set<number>();
  let total = 0;
  for (const offer of book) {
    total = Math.min(Number.MAX_SAFE_INTEGER, total + offer.quantity);
    if (total > 0 && total <= limit) points.add(total);
  }
  return [...points];
}

function buildEdges(offers: MarketOffer[], options: AnalysisOptions, now: number): ConversionEdge[] {
  const eligible = offers.filter((o) => validOffer(o, options) && fresh(o, options.maxQuoteAgeSeconds, now));
  const grouped = new Map<string, MarketOffer[]>();
  for (const offer of eligible) {
    const key = `${offer.serverId}\\u0000${offer.itemId}`;
    grouped.set(key, [...(grouped.get(key) ?? []), offer]);
  }
  const edges: ConversionEdge[] = [];
  for (const group of grouped.values()) {
    const buyBooks = new Map<string, { storeId?: string; storeName?: string; currencies: Map<string, MarketOffer[]> }>();
    const sellBooks = new Map<string, { storeId?: string; storeName?: string; currencies: Map<string, MarketOffer[]> }>();
    for (const offer of group) {
      const target = offer.action === 'buy' ? buyBooks : sellBooks;
      const key = storeKey(offer.serverId, offer.storeId, offer.storeName);
      const store = target.get(key) ?? {
        storeId: offer.storeId, storeName: offer.storeName,
        currencies: new Map<string, MarketOffer[]>(),
      };
      const currency = currencyKey(offer.currency);
      store.currencies.set(currency, [...(store.currencies.get(currency) ?? []), offer]);
      target.set(key, store);
    }

    // Keep the physical source and destination shop on every conversion edge.
    // This lets route search account for the walk between consecutive stores.
    for (const buyStore of buyBooks.values()) {
      for (const sellStore of sellBooks.values()) {
        for (const [fromKey, rawBuys] of buyStore.currencies) {
          const buyOffers = [...rawBuys].sort((a, b) =>
            compareUnitPrice(money(a.totalPrice), a.quantity, money(b.totalPrice), b.quantity));
          for (const [toKey, rawSells] of sellStore.currencies) {
            if (fromKey === toKey) continue;
            const sellOffers = [...rawSells].sort((a, b) =>
              -compareUnitPrice(money(a.totalPrice), a.quantity, money(b.totalPrice), b.quantity));
            const capacity = Math.min(totalListedQuantity(buyOffers), totalListedQuantity(sellOffers));
            if (capacity <= 0) continue;
            const breakpoints = new Set<number>([
              ...quantityBreakpoints(buyOffers, capacity),
              ...quantityBreakpoints(sellOffers, capacity),
              capacity,
            ]);
            const distanceUnits = distanceBetweenStores(options, group[0].serverId,
              { storeId: buyStore.storeId, storeName: buyStore.storeName },
              { storeId: sellStore.storeId, storeName: sellStore.storeName });
            for (const limit of [...breakpoints].filter((x) => x > 0).sort((a, b) => a - b)) {
              edges.push({
                key: `${group[0].serverId}:${group[0].itemId}:${fromKey}:${toKey}:${storeKey(group[0].serverId, buyStore.storeId, buyStore.storeName)}:${storeKey(group[0].serverId, sellStore.storeId, sellStore.storeName)}:${limit}`,
                serverId: group[0].serverId, itemId: group[0].itemId,
                itemName: buyOffers[0].itemName, fromCurrency: buyOffers[0].currency.trim(),
                toCurrency: sellOffers[0].currency.trim(), buyOffers, sellOffers, capacity: limit,
                buyStoreId: buyStore.storeId, buyStoreName: buyStore.storeName,
                sellStoreId: sellStore.storeId, sellStoreName: sellStore.storeName,
                distanceUnits,
              });
            }
          }
        }
      }
    }
  }
  return edges;
}

function buyBookCost(book: MarketOffer[], quantity: number): { total: bigint; ids: string[] } {
  let left = quantity, total = ZERO;
  const ids: string[] = [];
  for (const offer of book) {
    if (left <= 0) break;
    const take = Math.min(left, offer.quantity);
    if (take <= 0) continue;
    total = add(total, grossCostCeil(offer, take));
    ids.push(offer.id);
    left -= take;
  }
  return { total, ids };
}

function sellBookRevenue(book: MarketOffer[], quantity: number): { total: bigint; ids: string[] } {
  let left = quantity, total = ZERO;
  const ids: string[] = [];
  for (const offer of book) {
    if (left <= 0) break;
    const take = Math.min(left, offer.quantity);
    if (take <= 0) continue;
    total = add(total, grossCost(offer, take));
    ids.push(offer.id);
    left -= take;
  }
  return { total, ids };
}

function executeEdge(edge: ConversionEdge, balance: bigint, options: AnalysisOptions): RouteLeg | null {
  const fees = feePolicy(options, edge.serverId);
  const buyPct = money(fees.buyPercent), sellPct = money(fees.sellPercent), taxPct = money(fees.taxPercent);
  const buyFixed = money(fees.buyFixed), sellFixed = money(fees.sellFixed);
  if (balance <= buyFixed) return null;

  // Find the largest whole quantity affordable across the cumulative ask levels.
  let low = 0, high = edge.capacity;
  while (low < high) {
    const mid = low + Math.ceil((high - low) / 2);
    const cost = buyBookCost(edge.buyOffers, mid).total;
    const required = add(cost, add(percentOfSafe(cost, buyPct), buyFixed));
    if (required <= balance) low = mid;
    else high = mid - 1;
  }
  const quantity = low;
  if (quantity < 1) return null;

  const buy = buyBookCost(edge.buyOffers, quantity);
  const sell = sellBookRevenue(edge.sellOffers, quantity);
  if (buy.ids.length === 0 || sell.ids.length === 0) return null;
  const buyFee = add(percentOfSafe(buy.total, buyPct), buyFixed);
  const inputUsed = add(buy.total, buyFee);
  if (inputUsed > balance) return null;
  const sellFees = add(percentOfSafe(sell.total, sellPct), add(percentOfSafe(sell.total, taxPct), sellFixed));
  const output = sub(sell.total, sellFees);
  if (output <= ZERO) return null;

  return {
    itemId: edge.itemId, itemName: edge.itemName, serverId: edge.serverId, quantity,
    fromCurrency: edge.fromCurrency, toCurrency: edge.toCurrency,
    buyCost: moneyString(buy.total), sellRevenue: moneyString(sell.total),
    feesFrom: moneyString(buyFee), feesTo: moneyString(sellFees),
    inputBalance: moneyString(balance), outputBalance: moneyString(output),
    unspentInputBalance: moneyString(sub(balance, inputUsed)),
    buyOfferId: buy.ids[0], sellOfferId: sell.ids[0],
    buyOfferIds: buy.ids, sellOfferIds: sell.ids,
    buyStoreId: edge.buyStoreId, buyStoreName: edge.buyStoreName ?? 'Магазин не указан',
    sellStoreId: edge.sellStoreId, sellStoreName: edge.sellStoreName ?? 'Магазин не указан',
    distanceUnits: edge.distanceUnits,
  };
}

function totalRouteDistance(legs: RouteLeg[], options: AnalysisOptions, serverId: string): number | null {
  let total = 0;
  for (let index = 0; index < legs.length; index++) {
    const current = legs[index];
    if (current.distanceUnits === null || current.distanceUnits === undefined) return null;
    total += current.distanceUnits;
    if (index > 0) {
      const previous = legs[index - 1];
      const transfer = distanceBetweenStores(options, serverId,
        { storeId: previous.sellStoreId, storeName: previous.sellStoreName },
        { storeId: current.buyStoreId, storeName: current.buyStoreName });
      if (transfer === null) return null;
      total += transfer;
    }
  }
  return Math.round(total * 100) / 100;
}

/** Search diagnostics prevent a bounded search from being misreported as a definitive empty result. */
export interface RouteSearchStats {
  edgeCount: number;
  combinations: number;
  durationMs: number;
  truncated: boolean;
  stopReason: 'max_combinations' | 'max_duration' | null;
}

export interface RouteSearchResult {
  routes: MultiStepOpportunity[];
  stats: RouteSearchStats;
}

/** Search currency cycles via goods. Every leg is a buy+sell pair; routes are independent of direct-deal search. */
export function findMultiStepRoutesDetailed(
  offers: MarketOffer[], options: AnalysisOptions, now = Date.now(),
): RouteSearchResult {
  const startedAt = Date.now();
  const edges = buildEdges(offers, options, now);
  const results: MultiStepOpportunity[] = [];
  const maxLegs = Math.max(2, Math.floor(options.maxOperations / 2));
  const startCapital = options.startingCapitalByCurrency ?? {};
  const currencyLabels = new Map<string, string>();
  for (const edge of edges) {
    if (!currencyLabels.has(currencyKey(edge.fromCurrency))) currencyLabels.set(currencyKey(edge.fromCurrency), edge.fromCurrency);
    if (!currencyLabels.has(currencyKey(edge.toCurrency))) currencyLabels.set(currencyKey(edge.toCurrency), edge.toCurrency);
  }

  // Resolve a user-entered currency to the exact spelling used by GoodPrice.
  // Keep the configured capital alongside it; object lookup by original case
  // would otherwise lose the amount after canonicalizing the currency name.
  const requestedStarts = Object.entries(startCapital);
  const starts = requestedStarts.length
    ? requestedStarts.flatMap(([requested, capital]) => {
        const start = currencyLabels.get(currencyKey(requested));
        return start ? [{ start, explicitCapital: capital }] : [];
      })
    : [...currencyLabels.values()].map((start) => ({ start, explicitCapital: undefined as string | undefined }));
  const outgoingByCurrency = new Map<string, ConversionEdge[]>();
  for (const edge of edges) {
    const key = currencyKey(edge.fromCurrency);
    const bucket = outgoingByCurrency.get(key) ?? [];
    bucket.push(edge);
    outgoingByCurrency.set(key, bucket);
  }
  const offerById = new Map(offers.map((offer) => [offer.id, offer]));
  const seen = new Set<string>();
  let combinations = 0;
  let stopped = Date.now() - startedAt >= options.maxDurationMs;
  let stopReason: RouteSearchStats['stopReason'] = stopped ? 'max_duration' : null;
  for (const { start, explicitCapital } of starts) {
    if (stopped) break;
    const startKey = currencyKey(start);
    const outgoing = edges.filter((e) => currencyKey(e.fromCurrency) === startKey);
    if (!outgoing.length) continue;
    const assumedCapital = explicitCapital === undefined;
    const initial = explicitCapital !== undefined
      ? money(explicitCapital)
      : outgoing.reduce((max, edge) => {
          const buyCost = buyBookCost(edge.buyOffers, edge.capacity).total;
          const fees = feePolicy(options, edge.serverId);
          const required = add(buyCost, add(percentOfSafe(buyCost, money(fees.buyPercent)), money(fees.buyFixed)));
          return required > max ? required : max;
        }, ZERO);
    if (initial <= ZERO) continue;

    const walk = (currency: string, balance: bigint, legs: RouteLeg[], usedItems: Set<string>, seenCurrencies: Set<string>) => {
      if (stopped || legs.length >= maxLegs) return;
      const currentKey = currencyKey(currency);
      const candidates = (outgoingByCurrency.get(currentKey) ?? []).filter((e) =>
        e.serverId === (legs[0]?.serverId ?? e.serverId) && !usedItems.has(e.itemId));
      for (const edge of candidates) {
        if (combinations >= options.maxCombinations) { stopped = true; stopReason = 'max_combinations'; break; }
        if (Date.now() - startedAt >= options.maxDurationMs) { stopped = true; stopReason = 'max_duration'; break; }
        combinations++;
        const nextCurrencyKey = currencyKey(edge.toCurrency);
        const closesCycle = nextCurrencyKey === startKey;
        if (!closesCycle && seenCurrencies.has(nextCurrencyKey)) continue;
        if (!closesCycle && seenCurrencies.size - 1 >= options.maxIntermediateCurrencies) continue;
        if (usedItems.size >= options.maxUniqueItems) continue;
        const leg = executeEdge(edge, balance, options);
        if (!leg) continue;
        const nextLegs = [...legs, leg];
        if (closesCycle) {
          if (nextLegs.length < 2) continue;
          const routeId = nextLegs.map((x) => `${x.buyOfferIds.join(',')}:${x.sellOfferIds.join(',')}:${x.quantity}`).join('|');
          if (seen.has(routeId)) continue;
          seen.add(routeId);
          // The first buy can be limited by available listing quantity. Cash that
          // was not spent remains in the starting currency and must not vanish
          // from the account balance when the route closes its cycle.
          const startingReserve = money(nextLegs[0].unspentInputBalance);
          const finalCapital = add(money(leg.outputBalance), startingReserve);
          const profit = sub(finalCapital, initial);
          const capital = initial;
          const requiredRouteRoi = money(options.minRouteRoiPercent ?? '0');
          const requiredGlobalRoi = money(options.minRoiPercent);
          const minimumRoi = requiredRouteRoi > requiredGlobalRoi ? requiredRouteRoi : requiredGlobalRoi;
          if (profit <= ZERO || profit < money(options.minProfit) || ratioPercent(profit, capital) < minimumRoi) continue;
          const usedQuotes = nextLegs.flatMap((x) => [...x.buyOfferIds, ...x.sellOfferIds].map((id) => offerById.get(id))).filter(Boolean) as MarketOffer[];
          results.push({
            id: `route:${start}:${routeId}`, kind: 'multi_step', serverId: edge.serverId,
            startCurrency: start, endCurrency: start, initialCapital: moneyString(capital),
            finalCapital: moneyString(finalCapital), netProfit: moneyString(profit),
            roiPercent: moneyString(ratioPercent(profit, capital)), operations: nextLegs.length * 2,
            legs: nextLegs, quoteKind: quoteKind(usedQuotes), observedAt: oldestTimestamp(usedQuotes),
            capitalAssumed: assumedCapital,
            distanceUnits: totalRouteDistance(nextLegs, options, edge.serverId),
            offerCount: new Set(usedQuotes.map((offer) => offer.id)).size,
          });
          continue;
        }
        const nextUsed = new Set(usedItems); nextUsed.add(edge.itemId);
        const nextCurrencies = new Set(seenCurrencies); nextCurrencies.add(nextCurrencyKey);
        walk(edge.toCurrency, money(leg.outputBalance), nextLegs, nextUsed, nextCurrencies);
      }
    };
    walk(start, initial, [], new Set(), new Set([startKey]));
  }
  const routes = results.sort((a, b) => compareQuality(
    a.netProfit, a.distanceUnits ?? null, a.offerCount ?? 0, a.legs.reduce((sum, leg) => sum + leg.quantity, 0),
    b.netProfit, b.distanceUnits ?? null, b.offerCount ?? 0, b.legs.reduce((sum, leg) => sum + leg.quantity, 0),
  )).slice(0, options.maxResults);
  return {
    routes,
    stats: { edgeCount: edges.length, combinations, durationMs: Date.now() - startedAt, truncated: stopped, stopReason },
  };
}

export function findMultiStepRoutes(
  offers: MarketOffer[], options: AnalysisOptions, now = Date.now(),
): MultiStepOpportunity[] {
  return findMultiStepRoutesDetailed(offers, options, now).routes;
}

export function analyzeMarket(offers: MarketOffer[], options: AnalysisOptions, now = Date.now()): Opportunity[] {
  // These passes intentionally run independently; one search type never suppresses the other.
  const direct = findDirectOpportunities(offers, options, now);
  const routes = findMultiStepRoutes(offers, options, now);
  const interserver = findInterserverDifferences(offers, options, now);
  const quality = (item: Opportunity): number => {
    if (item.kind === 'interserver') return -1;
    if (item.kind === 'direct') return qualityScore(
      item.netProfit, item.distanceUnits ?? null, item.offerCount ?? 0, item.quantity,
    );
    return qualityScore(
      item.netProfit, item.distanceUnits ?? null, item.offerCount ?? 0,
      item.legs.reduce((sum, leg) => sum + leg.quantity, 0),
    );
  };
  return [...direct, ...routes, ...interserver].sort((a, b) => quality(b) - quality(a));
}

export const DEFAULT_ANALYSIS_OPTIONS: AnalysisOptions = {
  maxOperations: 8, maxUniqueItems: 8, maxIntermediateCurrencies: 6,
  maxResults: 250, maxCombinations: 250000, maxDurationMs: 8000, minProfit: '0', minRoiPercent: '0', minRouteRoiPercent: '0', maxQuoteAgeSeconds: 900,
};
