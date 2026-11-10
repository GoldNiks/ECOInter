import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { MarketSnapshot } from '../../shared/types.ts';

export const normalizedSnapshotSchema = z.object({
  schemaVersion: z.literal('ecointer.market.v1'),
  sourceId: z.string().min(1),
  serverId: z.string().min(1),
  capturedAt: z.string().datetime(),
  offers: z.array(z.object({
    id: z.string().min(1), serverId: z.string().min(1), itemId: z.string().min(1),
    itemName: z.string().min(1), action: z.enum(['buy', 'sell']), currency: z.string().min(1),
    totalPrice: z.string().regex(/^\\d+(?:\\.\\d{1,8})?$/),
    quantity: z.number().int().positive().max(1_000_000),
    quoteKind: z.enum(['listing', 'reference']), observedAt: z.string().datetime(),
    sourceId: z.string().optional(),
  })),
});

const API_SUFFIX = '/api/v1/plugins/GoodPrice';
const SCALE = 100_000_000n;
const COLOR_TAG = /<\\/?color[^>]*>/gi;

export interface ProbeResult {
  reachable: boolean;
  verified: boolean;
  statusCode?: number;
  contentType?: string;
  elapsedMs: number;
  storesCount?: number;
  offersCount?: number;
  warning?: string;
  message: string;
}

export class GoodPriceError extends Error {
  constructor(message: string, readonly statusCode?: number) {
    super(message);
    this.name = 'GoodPriceError';
  }
}

/**
 * The server card historically stores the plugin page URL
 * (/plugin/GoodPrice). The data API is rooted at the server origin:
 * /api/v1/plugins/GoodPrice/<endpoint>.
 */
function apiEndpoint(configuredUrl: string, endpoint: string): URL {
  const base = new URL(configuredUrl);
  const path = base.pathname.replace(/\\/+$/, '');
  base.pathname = path.replace(/\\/plugin\\/GoodPrice$/i, '').replace(/\\/+$/, '');
  base.search = '';
  base.hash = '';
  return new URL(`${base.toString().replace(/\\/$/, '')}${API_SUFFIX}/${endpoint}`);
}

async function requestStores(configuredUrl: string, token?: string, timeoutMs = 8000): Promise<{
  payload: Record<string, unknown>;
  statusCode: number;
  contentType?: string;
  elapsedMs: number;
}> {
  const url = apiEndpoint(configuredUrl, 'stores');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) {
      headers['X-Auth-Token'] = token;
      headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    const contentType = response.headers.get('content-type') ?? undefined;
    if (!response.ok) {
      const message = response.status === 401 || response.status === 403
        ? token
          ? `GoodPrice отклонил токен (HTTP ${response.status}). World ticket действует около 24 часов — скопируйте новый из GoodPrice.`
          : `API GoodPrice доступен, но требует токен авторизации (HTTP ${response.status}).`
        : response.status === 404
          ? 'Маршрут API GoodPrice не найден (HTTP 404). Проверьте, что плагин установлен на этом сервере.'
          : `API GoodPrice вернул HTTP ${response.status}.`;
      throw new GoodPriceError(message, response.status);
    }
    let payload: unknown;
    try { payload = await response.json(); }
    catch { throw new GoodPriceError('GoodPrice ответил не JSON. API-ответ не распознан.', response.status); }
    if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { Stores?: unknown }).Stores)) {
      throw new GoodPriceError('Ответ API не содержит массива Stores. Возможно, используется другая версия GoodPrice.', response.status);
    }
    return { payload: payload as Record<string, unknown>, statusCode: response.status, contentType, elapsedMs: Date.now() - started };
  } catch (error) {
    if (error instanceof GoodPriceError) throw error;
    const message = error instanceof Error && error.name === 'AbortError'
      ? `Превышено время ожидания ответа GoodPrice (${timeoutMs} мс).`
      : `Не удалось подключиться к API GoodPrice: ${error instanceof Error ? error.message : 'неизвестная сетевая ошибка'}`;
    throw new GoodPriceError(message);
  } finally {
    clearTimeout(timer);
  }
}

function cleanName(value: unknown): string {
  return typeof value === 'string' ? value.replace(COLOR_TAG, '').trim() : '';
}
function positiveInt(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 1_000_000 ? parsed : 0;
}
function toScaledDecimal(value: unknown): bigint | null {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  const source = typeof value === 'string' ? value.trim() : number.toFixed(8);
  const match = /^(\\d+)(?:\\.(\\d+))?$/.exec(source);
  if (!match) return null;
  const fraction = (match[2] ?? '').slice(0, 8).padEnd(8, '0');
  return BigInt(match[1]) * SCALE + BigInt(fraction || '0');
}
function scaledToString(value: bigint): string {
  const whole = value / SCALE;
  const fraction = (value % SCALE).toString().padStart(8, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
function deterministicOfferId(serverId: string, storeIndex: number, offerIndex: number, item: string, action: string): string {
  return createHash('sha256')
    .update(`${serverId}\\0${storeIndex}\\0${offerIndex}\\0${item}\\0${action}`)
    .digest('hex').slice(0, 32);
}

/**
 * Convert the real GoodPrice /stores payload into ECOInter's internal schema.
 * GoodPrice Price is a per-item price; ECOInter stores totalPrice for the
 * complete available quantity. Buying=true means the shop buys from players.
 */
export function normalizeGoodPriceStores(payload: Record<string, unknown>, serverId: string, capturedAt = new Date().toISOString()): MarketSnapshot {
  const stores = Array.isArray(payload.Stores) ? payload.Stores : [];
  const offers: MarketSnapshot['offers'] = [];
  stores.forEach((rawStore, storeIndex) => {
    if (!rawStore || typeof rawStore !== 'object') return;
    const store = rawStore as Record<string, unknown>;
    if (store.Enabled === false) return;
    const storeName = cleanName(store.Name);
    const owner = cleanName(store.Owner);
    const currency = cleanName(store.CurrencyName);
    if (!storeName || !currency || !Array.isArray(store.AllOffers)) return;
    const balanceRaw = store.Balance;
    const balanceText = String(balanceRaw ?? '').trim().toLowerCase();
    const balance = balanceText.startsWith('inf') ? Number.POSITIVE_INFINITY : Number(balanceRaw);
    (store.AllOffers as unknown[]).forEach((rawOffer, offerIndex) => {
      if (!rawOffer || typeof rawOffer !== 'object') return;
      const offer = rawOffer as Record<string, unknown>;
      if (offer.Enabled === false) return;
      const itemName = cleanName(offer.ItemName);
      if (!itemName) return;
      const buying = offer.Buying === true;
      const action = buying ? 'sell' as const : 'buy' as const;
      const unitPrice = toScaledDecimal(offer.Price);
      const requested = buying ? positiveInt(offer.MaxNumWanted ?? offer.Quantity) : positiveInt(offer.Quantity);
      if (!unitPrice || requested < 1) return;
      // Empty sell slots use 999999 as a sentinel. Empty buy slots have Price=0.
      if (!buying && unitPrice >= 999999n * SCALE) return;
      if (buying && (!Number.isFinite(balance) && balance !== Number.POSITIVE_INFINITY || balance <= 0)) return;
      const totalPrice = unitPrice * BigInt(requested);
      offers.push({
        id: deterministicOfferId(serverId, storeIndex, offerIndex, itemName, action),
        serverId, itemId: itemName, itemName, action, currency,
        totalPrice: scaledToString(totalPrice), quantity: requested,
        quoteKind: 'listing', observedAt: capturedAt, sourceId: 'GoodPrice',
      });
    });
  });
  return { schemaVersion: 'ecointer.market.v1', sourceId: 'GoodPrice', serverId, capturedAt, offers };
}

export async function fetchGoodPriceSnapshot(configuredUrl: string, token: string, serverId: string, timeoutMs = 8000): Promise<MarketSnapshot> {
  if (!token.trim()) throw new GoodPriceError('Вставьте world ticket из GoodPrice перед синхронизацией.');
  const { payload } = await requestStores(configuredUrl, token, timeoutMs);
  return normalizeGoodPriceStores(payload, serverId);
}

/** Check the actual GoodPrice data endpoint; credentials are sent only when a token is supplied. */
export async function probeGoodPrice(url: string, token?: string, timeoutMs = 8000): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const result = await requestStores(url, token, timeoutMs);
    const count = (result.payload.Stores as unknown[]).length;
    const offerCount = (normalizeGoodPriceStores(result.payload, 'probe').offers).length;
    return {
      reachable: true, verified: true, statusCode: result.statusCode, contentType: result.contentType,
      elapsedMs: result.elapsedMs, storesCount: count, offersCount: offerCount,
      message: `GoodPrice API подтверждён: ${count} магазинов, ${offerCount} активных предложений. Рыночные данные пока не импортированы.`,
      warning: token && new URL(url).protocol === 'http:' ? 'Токен передаётся по незашифрованному HTTP.' : undefined,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Неизвестная ошибка GoodPrice';
    const statusCode = error instanceof GoodPriceError ? error.statusCode : undefined;
    const authRequired = !token && (statusCode === 401 || statusCode === 403);
    return {
      reachable: statusCode !== undefined,
      verified: false, statusCode, elapsedMs: Date.now() - started,
      message: detail,
      warning: authRequired ? 'TOKEN_REQUIRED' : new URL(url).protocol === 'http:' ? 'HTTP_INSECURE' : undefined,
    };
  }
}

export function parseNormalizedSnapshot(value: unknown): MarketSnapshot {
  // This is ECOInter's explicit import contract, not GoodPrice's raw API format.
  return normalizedSnapshotSchema.parse(value) as MarketSnapshot;
}
