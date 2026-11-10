export type OfferAction = 'buy' | 'sell';
export type QuoteKind = 'listing' | 'reference';
export type OpportunityKind = 'direct' | 'multi_step' | 'interserver';

/** Normalized internal quote. totalPrice is the price for the entire listed quantity. */
export interface MarketOffer {
  id: string;
  serverId: string;
  itemId: string;
  itemName: string;
  action: OfferAction;
  currency: string;
  totalPrice: string;
  quantity: number;
  quoteKind: QuoteKind;
  observedAt: string;
  sourceId?: string;
  storeId?: string;
  storeName?: string;
  /** False when the destination store's storage is known to reject this item or has unverified profession rules. */
  tradeAllowed?: boolean;
  tradeRestriction?: string;
}

export interface RestrictedOfferSummary {
  storeName: string;
  count: number;
  sampleItems: string[];
  reason: string;
}

export interface FeePolicy {
  buyPercent: string;
  sellPercent: string;
  taxPercent: string;
  buyFixed: string;
  sellFixed: string;
}

export interface StoreLocation {
  x?: number;
  z?: number;
}

export interface AnalysisOptions {
  maxOperations: number;
  maxUniqueItems: number;
  maxIntermediateCurrencies: number;
  maxResults: number;
  maxCombinations: number;
  maxDurationMs: number;
  minProfit: string;
  minRoiPercent: string;
  /** Separate quality floor for multi-step routes. */
  minRouteRoiPercent: string;
  startingCapitalByCurrency?: Record<string, string>;
  feesByServer?: Record<string, FeePolicy>;
  maxQuoteAgeSeconds: number;
  /** Eco world coordinates keyed by serverId::storeId (or store name fallback). */
  storeLocations?: Record<string, StoreLocation>;
  /** Exact item names manually confirmed as accepted by a restricted store. */
  storeAcceptedItems?: Record<string, string[]>;
}

export interface DirectOpportunity {
  id: string;
  kind: 'direct';
  serverId: string;
  itemId: string;
  itemName: string;
  currency: string;
  quantity: number;
  buyCost: string;
  sellRevenue: string;
  fees: string;
  netProfit: string;
  roiPercent: string;
  quoteKind: QuoteKind;
  observedAt: string;
  buyOfferIds: string[];
  sellOfferIds: string[];
  buyStoreId?: string;
  buyStoreName?: string;
  sellStoreId?: string;
  sellStoreName?: string;
  distanceUnits?: number | null;
  offerCount?: number;
}

export interface InterserverDifference {
  id: string;
  kind: 'interserver';
  itemId: string;
  itemName: string;
  currency: string;
  buyServerId: string;
  sellServerId: string;
  quantity: number;
  referenceBuyCost: string;
  referenceSellRevenue: string;
  priceGap: string;
  executable: false;
  reason: string;
  observedAt: string;
}

export interface RouteLeg {
  itemId: string;
  itemName: string;
  serverId: string;
  quantity: number;
  fromCurrency: string;
  toCurrency: string;
  buyCost: string;
  sellRevenue: string;
  feesFrom: string;
  feesTo: string;
  inputBalance: string;
  outputBalance: string;
  /** Funds left in the input currency because the available lot was smaller than the balance. */
  unspentInputBalance: string;
  buyOfferId: string;
  sellOfferId: string;
  buyOfferIds: string[];
  sellOfferIds: string[];
  buyStoreId?: string;
  buyStoreName?: string;
  sellStoreId?: string;
  sellStoreName?: string;
  /** Straight-line distance from the purchase store to the sale store, in Eco map units. */
  distanceUnits?: number | null;
}

export interface MultiStepOpportunity {
  id: string;
  kind: 'multi_step';
  serverId: string;
  startCurrency: string;
  endCurrency: string;
  initialCapital: string;
  finalCapital: string;
  netProfit: string;
  roiPercent: string;
  operations: number;
  legs: RouteLeg[];
  quoteKind: QuoteKind;
  observedAt: string;
  capitalAssumed: boolean;
  /** Total known route travel, including transfers between consecutive stores. */
  distanceUnits?: number | null;
  offerCount?: number;
}

export type Opportunity = DirectOpportunity | InterserverDifference | MultiStepOpportunity;

export interface ServerRecord {
  id: string;
  name: string;
  gameServerUrl: string;
  goodPriceUrl: string;
  enabled: boolean;
  priority: number;
  refreshSeconds: number;
  status: string;
  lastSyncAt?: string;
  lastError?: string;
  tokenConfigured: boolean;
}

export interface MarketSnapshot {
  schemaVersion: 'ecointer.market.v1';
  sourceId: string;
  serverId: string;
  capturedAt: string;
  offers: MarketOffer[];
}
