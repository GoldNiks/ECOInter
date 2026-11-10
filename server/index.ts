import Fastify from 'fastify';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, sqlite } from './db.ts';
import { events, offers, priceHistory, servers, settings, simulations } from './schema.ts';
import { analyzeMarket, DEFAULT_ANALYSIS_OPTIONS, findMultiStepRoutesDetailed } from './engine/opportunities.ts';
import { canEncryptSecrets, decryptSecret, encryptSecret } from './services/crypto.ts';
import { money, moneyString } from './domain/money.ts';
import { fetchGoodPriceSnapshot, parseNormalizedSnapshot, probeGoodPrice } from './services/goodprice.ts';
import type { AnalysisOptions, MarketOffer, MarketSnapshot, RestrictedOfferSummary } from '../shared/types.ts';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.authorization', 'req.headers.x-api-key', 'req.headers.x-auth-token'] } });
await app.register(cors, { origin: ['http://127.0.0.1:5173', 'http://localhost:5173'] });

const nonNegativeMoney = z.string().regex(/^\d+(?:\.\d{1,8})?$/);
const serverInput = z.object({
  name: z.string().trim().min(1).max(100),
  gameServerUrl: z.string().trim().url().or(z.literal('')),
  goodPriceUrl: z.string().trim().url().default('http://188.235.146.195:3001/plugin/GoodPrice'),
  enabled: z.boolean().default(true), priority: z.number().int().min(0).max(1000).default(100),
  refreshSeconds: z.number().int().min(30).max(86400).default(300), token: z.string().optional(),
});
const analysisOptionsSchema = z.object({
  maxOperations: z.number().int().min(2).max(12).default(8), maxUniqueItems: z.number().int().min(1).max(20).default(8),
  maxIntermediateCurrencies: z.number().int().min(1).max(12).default(6), maxResults: z.number().int().min(1).max(1000).default(250),
  maxCombinations: z.number().int().min(100).max(1_000_000).default(250000), maxDurationMs: z.number().int().min(100).max(30000).default(8000),
  minProfit: nonNegativeMoney.default('0'), minRoiPercent: nonNegativeMoney.default('0'), minRouteRoiPercent: nonNegativeMoney.default('5'), maxQuoteAgeSeconds: z.number().int().min(1).max(604800).default(900),
  startingCapitalByCurrency: z.record(z.string(), nonNegativeMoney).optional(),
  storeLocations: z.record(z.string(), z.object({
    x: z.number().finite().optional(),
    z: z.number().finite().optional(),
  })).optional(),
  storeAcceptedItems: z.record(z.string(), z.array(z.string().trim().min(1))).optional(),
  feesByServer: z.record(z.string(), z.object({
    buyPercent: nonNegativeMoney, sellPercent: nonNegativeMoney, taxPercent: nonNegativeMoney, buyFixed: nonNegativeMoney, sellFixed: nonNegativeMoney,
  })).optional(),
});

function logEvent(level: string, type: string, message: string, serverId?: string) {
  db.insert(events).values({ level, type, message, serverId: serverId ?? null, createdAt: new Date().toISOString() }).run();
}

function summarizeRestrictedOffers(marketOffers: MarketOffer[], options: AnalysisOptions = DEFAULT_ANALYSIS_OPTIONS): RestrictedOfferSummary[] {
  const grouped = new Map<string, { count: number; items: Set<string>; reason: string }>();
  for (const offer of marketOffers) {
    const storeKey = `${offer.serverId}::${offer.storeId?.trim() || offer.storeName?.trim() || 'unknown'}`;
    const allowed = options.storeAcceptedItems?.[storeKey] ?? [];
    const manuallyConfirmed = allowed.some((name) =>
      name.trim().normalize('NFKC').toLocaleLowerCase('ru-RU') === offer.itemName.trim().normalize('NFKC').toLocaleLowerCase('ru-RU'));
    if (offer.tradeAllowed !== false || manuallyConfirmed) continue;
    const storeName = offer.storeName?.trim() || 'Специализированный магазин';
    const entry = grouped.get(storeName) ?? {
      count: 0, items: new Set<string>(),
      reason: offer.tradeRestriction || 'Совместимость товара с хранилищем магазина не подтверждена.',
    };
    entry.count++;
    entry.items.add(offer.itemName);
    grouped.set(storeName, entry);
  }
  return [...grouped.entries()].map(([storeName, entry]) => ({
    storeName, count: entry.count, sampleItems: [...entry.items].slice(0, 5), reason: entry.reason,
  })).sort((a, b) => b.count - a.count);
}

function restrictedOfferCount(restrictions: RestrictedOfferSummary[]): number {
  return restrictions.reduce((total, restriction) => total + restriction.count, 0);
}

function persistSnapshot(snapshot: MarketSnapshot) {
  const now = new Date().toISOString();
  const tx = sqlite.transaction(() => {
    // Replace the live order book for this server so removed/disabled offers do not linger.
    db.delete(offers).where(eq(offers.serverId, snapshot.serverId)).run();
    for (const offer of snapshot.offers) {
      const row = { ...offer, importedAt: now };
      db.insert(offers).values(row).onConflictDoUpdate({ target: offers.id, set: row }).run();
      db.insert(priceHistory).values({
        offerId: offer.id, serverId: offer.serverId, itemId: offer.itemId, action: offer.action,
        currency: offer.currency, totalPrice: offer.totalPrice, quantity: offer.quantity, observedAt: offer.observedAt,
      }).run();
    }
    db.update(servers).set({
      status: 'imported_normalized', lastSyncAt: now, lastError: null,
    }).where(eq(servers.id, snapshot.serverId)).run();
  });
  tx();
  const restrictedCount = snapshot.offers.filter((offer) => offer.tradeAllowed === false).length;
  logEvent('info', 'market_sync',
    `GoodPrice: импортировано предложений — ${snapshot.offers.length}; исключено из исполнимых расчётов из-за ограничений хранилищ — ${restrictedCount}`,
    snapshot.serverId);
}

const syncInProgress = new Set<string>();
const syncRetryAfter = new Map<string, number>();

async function syncGoodPriceServer(serverId: string): Promise<MarketSnapshot> {
  if (syncInProgress.has(serverId)) throw new Error('Синхронизация этого сервера уже выполняется.');
  const server = db.select().from(servers).where(eq(servers.id, serverId)).get();
  if (!server) throw new Error('Сервер не найден.');
  if (!server.encryptedToken) throw new Error('Для загрузки рынка нужен world ticket GoodPrice.');

  syncInProgress.add(serverId);
  try {
    const token = decryptSecret(server.encryptedToken);
    const snapshot = await fetchGoodPriceSnapshot(server.goodPriceUrl, token, serverId);
    persistSnapshot(snapshot);
    syncRetryAfter.delete(serverId);
    return snapshot;
  } catch (error) {
    const detail = safeError(error);
    const statusCode = typeof error === 'object' && error && 'statusCode' in error
      ? Number((error as { statusCode?: unknown }).statusCode) : undefined;
    const authFailure = statusCode === 401 || statusCode === 403;
    db.update(servers).set({
      status: authFailure ? 'auth_failed' : 'sync_error',
      lastError: detail,
    }).where(eq(servers.id, serverId)).run();
    logEvent('error', 'market_sync_failed', detail, serverId);
    syncRetryAfter.set(serverId, Date.now() + Math.max(60, server.refreshSeconds) * 1000);
    throw error;
  } finally {
    syncInProgress.delete(serverId);
  }
}

async function syncDueServers(force = false) {
  const now = Date.now();
  const configured = db.select().from(servers).all();
  for (const server of configured) {
    if (!server.enabled || !server.encryptedToken || server.status === 'auth_failed' || syncInProgress.has(server.id)) continue;
    if (now < (syncRetryAfter.get(server.id) ?? 0)) continue;
    const lastSync = server.lastSyncAt ? Date.parse(server.lastSyncAt) : 0;
    const intervalMs = Math.max(30, server.refreshSeconds) * 1000;
    if (!force && lastSync && now - lastSync < intervalMs) continue;
    try { await syncGoodPriceServer(server.id); } catch { /* the failure is stored in the local journal */ }
  }
}
function getOptions(): AnalysisOptions {
  const row = db.select().from(settings).where(eq(settings.key, 'analysis')).get();
  if (!row) return DEFAULT_ANALYSIS_OPTIONS;
  try { return { ...DEFAULT_ANALYSIS_OPTIONS, ...analysisOptionsSchema.parse(JSON.parse(row.value)) }; }
  catch { return DEFAULT_ANALYSIS_OPTIONS; }
}
function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown error';
  return message.replace(/(token|authorization|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]').slice(0, 600);
}

app.get('/api/health', async (_request, reply) => {
  try {
    // Exercise every local table used by the UI, not just the SQLite connection.
    db.select().from(servers).limit(1).all();
    db.select().from(offers).limit(1).all();
    db.select().from(priceHistory).limit(1).all();
    db.select().from(events).limit(1).all();
    db.select().from(settings).limit(1).all();
    db.select().from(simulations).limit(1).all();
    return { ok: true, app: 'ECOInter', time: new Date().toISOString(), database: 'ready', goodPrice: 'not_verified' };
  } catch (error) {
    reply.code(503);
    return {
      ok: false, app: 'ECOInter', time: new Date().toISOString(),
      database: 'error', error: safeError(error), goodPrice: 'not_verified',
    };
  }
});

app.get('/api/servers', async () => {
  const rows = db.select().from(servers).orderBy(desc(servers.priority)).all();
  return rows.map((s) => ({
    id: s.id, name: s.name, gameServerUrl: s.gameServerUrl, goodPriceUrl: s.goodPriceUrl,
    enabled: !!s.enabled, priority: s.priority, refreshSeconds: s.refreshSeconds,
    status: s.status, lastSyncAt: s.lastSyncAt, lastError: s.lastError,
    tokenConfigured: !!s.encryptedToken,
  }));
});

app.post('/api/servers', async (request, reply) => {
  const parsed = serverInput.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Некорректные параметры сервера', details: parsed.error.flatten() });
  const input = parsed.data;
  let encryptedToken: string | null = null;
  if (input.token) {
    encryptedToken = encryptSecret(input.token);
    if (!encryptedToken) return reply.code(500).send({ error: 'Не удалось создать локальный ключ шифрования. Проверьте доступ к папке data.' });
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  db.insert(servers).values({
    id, name: input.name, gameServerUrl: input.gameServerUrl, goodPriceUrl: input.goodPriceUrl,
    enabled: input.enabled, priority: input.priority, refreshSeconds: input.refreshSeconds,
    encryptedToken, status: 'not_checked', createdAt: now,
  }).run();
  logEvent('info', 'server_added', `Добавлен сервер «${input.name}»`, id);
  return reply.code(201).send({ id, name: input.name, tokenConfigured: !!encryptedToken, status: 'not_checked' });
});

app.delete('/api/servers/:id', async (request, reply) => {
  const { id } = request.params as { id: string };
  const existing = db.select().from(servers).where(eq(servers.id, id)).get();
  if (!existing) return reply.code(404).send({ error: 'Сервер не найден' });
  db.delete(offers).where(eq(offers.serverId, id)).run();
  db.delete(servers).where(eq(servers.id, id)).run();
  logEvent('warning', 'server_removed', `Удалён сервер «${existing.name}»`, id);
  return { ok: true };
});

app.post('/api/servers/:id/probe', async (request, reply) => {
  const { id } = request.params as { id: string };
  const existing = db.select().from(servers).where(eq(servers.id, id)).get();
  if (!existing) return reply.code(404).send({ error: 'Сервер не найден' });
  const token = existing.encryptedToken ? decryptSecret(existing.encryptedToken) : undefined;
  const result = await probeGoodPrice(existing.goodPriceUrl, token);
  const authError = result.statusCode === 401 || result.statusCode === 403;
  const nextStatus = result.verified ? 'api_verified'
    : authError ? (token ? 'auth_failed' : 'auth_required')
    : result.reachable ? 'reachable_unverified' : 'unavailable';
  db.update(servers).set({
    status: nextStatus, lastError: result.verified ? null : result.message,
  }).where(eq(servers.id, id)).run();
  logEvent(result.verified ? 'info' : result.reachable ? 'warning' : 'error', 'source_probe', result.message, id);
  return { ...result, tokenConfigured: !!existing.encryptedToken };
});

app.post('/api/servers/:id/token', async (request, reply) => {
  const { id } = request.params as { id: string };
  const existing = db.select().from(servers).where(eq(servers.id, id)).get();
  if (!existing) return reply.code(404).send({ error: 'Сервер не найден' });
  const parsed = z.object({ token: z.string().trim().min(16).max(10000) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Вставьте полный world ticket из GoodPrice.' });
  const encryptedToken = encryptSecret(parsed.data.token);
  if (!encryptedToken) return reply.code(500).send({ error: 'Не удалось создать локальный ключ для шифрования токена. Проверьте доступ к папке data.' });
  db.update(servers).set({ encryptedToken, status: 'not_checked', lastError: null }).where(eq(servers.id, id)).run();
  logEvent('info', 'token_updated', 'Токен GoodPrice сохранён локально', id);
  return { ok: true, tokenConfigured: true };
});

app.post('/api/servers/:id/sync', async (request, reply) => {
  const { id } = request.params as { id: string };
  const existing = db.select().from(servers).where(eq(servers.id, id)).get();
  if (!existing) return reply.code(404).send({ error: 'Сервер не найден' });
  if (!existing.encryptedToken) return reply.code(400).send({
    error: 'Для загрузки рынка нужен world ticket GoodPrice. Сохраните токен в карточке сервера.',
  });
  try {
    const snapshot = await syncGoodPriceServer(id);
    return { ok: true, imported: snapshot.offers.length, capturedAt: snapshot.capturedAt };
  } catch (error) {
    const statusCode = typeof error === 'object' && error && 'statusCode' in error
      ? Number((error as { statusCode?: unknown }).statusCode) : undefined;
    return reply.code(statusCode === 401 || statusCode === 403 ? 401 : 502).send({ error: safeError(error) });
  }
});

app.get('/api/market/offers', async () => db.select().from(offers).orderBy(desc(offers.observedAt)).all());

app.post('/api/market/import', async (request, reply) => {
  let snapshot;
  try { snapshot = parseNormalizedSnapshot(request.body); }
  catch (error) { return reply.code(400).send({ error: 'Импорт отклонён: JSON не соответствует внутреннему контракту ECOInter.', details: safeError(error) }); }
  const server = db.select().from(servers).where(eq(servers.id, snapshot.serverId)).get();
  if (!server) return reply.code(400).send({ error: 'Сначала добавьте сервер с таким serverId.' });
  if (snapshot.offers.some((offer) => offer.serverId !== snapshot.serverId)) return reply.code(400).send({ error: 'Все предложения снимка должны относиться к его serverId.' });
  persistSnapshot(snapshot);
  return { ok: true, imported: snapshot.offers.length, capturedAt: snapshot.capturedAt };
});


app.post('/api/routes/search', async (request, reply) => {
  const parsed = z.object({ currency: z.string().trim().min(1), capital: z.string().regex(/^\d+(?:\.\d{1,8})?$/) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Укажите валюту и корректный стартовый капитал.' });
  const marketOffers = db.select().from(offers).all() as MarketOffer[];
  const options = { ...getOptions(), startingCapitalByCurrency: { [parsed.data.currency]: parsed.data.capital } };
  const search = findMultiStepRoutesDetailed(marketOffers, options);
  const restrictions = summarizeRestrictedOffers(marketOffers, options);
  return {
    routes: search.routes, count: search.routes.length, analyzedOffers: marketOffers.length,
    excludedOffers: restrictedOfferCount(restrictions), restrictions, searchStats: search.stats,
  };
});

app.get('/api/opportunities', async (request) => {
  const query = request.query as { kind?: string };
  const marketOffers = db.select().from(offers).all() as MarketOffer[];
  const options = getOptions();
  const results = analyzeMarket(marketOffers, options);
  const restrictions = summarizeRestrictedOffers(marketOffers, options);
  const summary = { analyzedOffers: marketOffers.length, excludedOffers: restrictedOfferCount(restrictions), restrictions };
  if (!query.kind || query.kind === 'all') return { opportunities: results, count: results.length, ...summary };
  const filtered = results.filter((x) => x.kind === query.kind);
  return { opportunities: filtered, count: filtered.length, ...summary };
});

app.post('/api/settings/analysis', async (request, reply) => {
  const parsed = analysisOptionsSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Некорректные настройки аналитики', details: parsed.error.flatten() });
  const value = JSON.stringify(parsed.data);
  db.insert(settings).values({ key: 'analysis', value, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date().toISOString() } }).run();
  logEvent('info', 'settings_updated', 'Обновлены настройки аналитики');
  return { ok: true, settings: parsed.data };
});

app.get('/api/settings/analysis', async () => getOptions());
app.get('/api/products', async () => {
  const rows = db.select().from(offers).all();
  const grouped = new Map<string, { itemId: string; itemName: string; servers: Set<string>; currencies: Set<string>; offerCount: number; latest: string }>();
  for (const row of rows) {
    const current = grouped.get(row.itemId) ?? { itemId: row.itemId, itemName: row.itemName, servers: new Set<string>(), currencies: new Set<string>(), offerCount: 0, latest: row.observedAt };
    current.servers.add(row.serverId); current.currencies.add(row.currency); current.offerCount++; if (row.observedAt > current.latest) current.latest = row.observedAt;
    grouped.set(row.itemId, current);
  }
  return [...grouped.values()].map((x) => ({ ...x, servers: [...x.servers], currencies: [...x.currencies] }));
});
app.get('/api/history', async (request) => {
  const query = request.query as { itemId?: string; limit?: string };
  const limit = Math.min(2000, Math.max(1, Number(query.limit ?? 500)));
  const rows = query.itemId
    ? db.select().from(priceHistory).where(eq(priceHistory.itemId, query.itemId)).orderBy(desc(priceHistory.id)).limit(limit).all()
    : db.select().from(priceHistory).orderBy(desc(priceHistory.id)).limit(limit).all();
  return rows;
});

app.get('/api/events', async (request) => {
  const query = request.query as { limit?: string };
  const limit = Math.min(500, Math.max(1, Number(query.limit ?? 100)));
  return db.select().from(events).orderBy(desc(events.id)).limit(limit).all();
});
app.get('/api/simulations', async () => db.select().from(simulations).orderBy(desc(simulations.createdAt)).all());

app.post('/api/simulations', async (request, reply) => {
  const parsed = z.object({ opportunityId: z.string().min(1) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Выберите торговую возможность.' });
  const marketOffers = db.select().from(offers).all() as MarketOffer[];
  const opportunity = analyzeMarket(marketOffers, getOptions()).find((x) => x.id === parsed.data.opportunityId);
  if (!opportunity) return reply.code(404).send({ error: 'Возможность больше не найдена: котировки могли измениться.' });
  if (opportunity.kind === 'interserver') return reply.code(400).send({ error: 'Межсерверную разницу нельзя симулировать как исполнимую сделку.' });
  const id = randomUUID(); const now = new Date().toISOString();
  const currency = opportunity.kind === 'direct' ? opportunity.currency : opportunity.startCurrency;
  const expectedCapital = opportunity.kind === 'direct' ? opportunity.buyCost : opportunity.initialCapital;
  db.insert(simulations).values({
    id, opportunityId: opportunity.id, kind: opportunity.kind, status: 'planned', currency,
    expectedCapital, expectedProfit: opportunity.netProfit, actualProfit: null, note: null,
    snapshot: JSON.stringify(opportunity), createdAt: now, updatedAt: now,
  }).run();
  logEvent('info', 'simulation_started', `Создана бумажная симуляция ${id}`);
  return reply.code(201).send({ id, opportunityId: opportunity.id, status: 'planned' });
});

app.patch('/api/simulations/:id', async (request, reply) => {
  const { id } = request.params as { id: string };
  const parsed = z.object({ status: z.enum(['completed', 'failed']), actualProfit: z.string().regex(/^-?\d+(?:\.\d{1,8})?$/).optional(), note: z.string().max(1000).optional() }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Некорректный результат симуляции.' });
  const existing = db.select().from(simulations).where(eq(simulations.id, id)).get();
  if (!existing) return reply.code(404).send({ error: 'Симуляция не найдена.' });
  const now = new Date().toISOString();
  db.update(simulations).set({ status: parsed.data.status, actualProfit: parsed.data.actualProfit ?? null, note: parsed.data.note ?? null, updatedAt: now }).where(eq(simulations.id, id)).run();
  logEvent(parsed.data.status === 'completed' ? 'info' : 'warning', 'simulation_updated', `Симуляция ${id}: ${parsed.data.status}`);
  return { ok: true };
});

app.get('/api/dashboard', async () => {
  const serverRows = db.select().from(servers).all();
  const offerRows = db.select().from(offers).all() as MarketOffer[];
  const opportunities = analyzeMarket(offerRows, getOptions());
  const profitable = opportunities.filter((o) => o.kind !== 'interserver');
  return {
    servers: serverRows.length, connectedServers: serverRows.filter((s) => s.status === 'imported_normalized').length,
    products: new Set(offerRows.map((o) => o.itemId)).size, offers: offerRows.length,
    opportunities: opportunities.length, direct: opportunities.filter((o) => o.kind === 'direct').length,
    routes: opportunities.filter((o) => o.kind === 'multi_step').length,
    bestProfit: moneyString(profitable.reduce((best, o) => {
      const amount = o.kind === 'multi_step' || o.kind === 'direct' ? money(o.netProfit) : 0n;
      return amount > best ? amount : best;
    }, 0n)), lastUpdated: offerRows.map((o) => o.observedAt).sort().at(-1) ?? null,
    dataReady: offerRows.length > 0,
  };
});

app.setErrorHandler((error, request, reply) => {
  const detail = safeError(error);
  const route = request.routeOptions.url ?? request.url.split('?')[0];
  app.log.error({ err: detail, method: request.method, route }, 'Request failed');

  // Keep the UI journal truthful: persist sanitized server errors when possible.
  // If SQLite itself is failing, fall back to Fastify's local console logger.
  try {
    logEvent('error', 'api_error', `${request.method} ${route}: ${detail}`);
  } catch (loggingError) {
    app.log.error({ err: safeError(loggingError) }, 'Could not persist API error to the local journal');
  }

  reply.code(500).send({ error: `Ошибка ${request.method} ${route}: ${detail}` });
});

export async function startServer() {
  const host = process.env.HOST ?? '127.0.0.1';
  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ host, port });
  app.log.info(`ECOInter API listening on http://${host}:${port}`);
  if (!canEncryptSecrets()) app.log.warn('Local token encryption is unavailable; GoodPrice token persistence is disabled.');
  const syncScheduler = setInterval(() => { void syncDueServers(); }, 15_000);
  syncScheduler.unref();
  void syncDueServers(true);
}

// Importing the API in tests must not bind a port or start background sync jobs.
const isMainModule = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMainModule) await startServer();

export { app };
