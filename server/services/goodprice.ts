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
    totalPrice: z.string().regex(/^\d+(?:\.\d{1,8})?$/),
    quantity: z.number().int().positive().max(1_000_000),
    quoteKind: z.enum(['listing', 'reference']), observedAt: z.string().datetime(),
    sourceId: z.string().optional(),
  })),
});

export interface ProbeResult {
  reachable: boolean;
  verified: false;
  statusCode?: number;
  contentType?: string;
  elapsedMs: number;
  warning?: string;
  message: string;
}

/**
 * Deliberately probes only the configured page. It does not guess API routes,
 * authorization headers, JSON paths, or market field meanings.
 */
export async function probeGoodPrice(url: string, token?: string, timeoutMs = 8000): Promise<ProbeResult> {
  const parsed = new URL(url);
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { accept: 'text/html,application/json,*/*' };
    // Never guess whether the upstream expects Bearer, a query-string token, or a custom header.
    // Connectivity is probed without credentials; authentication remains explicitly unverified.
    const response = await fetch(parsed, { method: 'GET', headers, signal: controller.signal, redirect: 'manual' });
    const warnings = [
      parsed.protocol === 'http:' ? 'INSECURE_HTTP' : undefined,
      token ? 'TOKEN_NOT_SENT' : undefined,
    ].filter(Boolean);
    return {
      reachable: response.ok, verified: false, statusCode: response.status,
      contentType: response.headers.get('content-type') ?? undefined,
      elapsedMs: Date.now() - started,
      warning: warnings.join(',') || undefined,
      message: response.ok
        ? `Адрес отвечает, но формат API и авторизация не подтверждены.${token ? ' Токен не передавался.' : ''} Рыночные данные не импортированы.`
        : `Источник ответил HTTP ${response.status}. Формат API не подтверждён.${token ? ' Токен не передавался.' : ''}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown network error';
    return {
      reachable: false, verified: false, elapsedMs: Date.now() - started,
      warning: parsed.protocol === 'http:' ? 'INSECURE_HTTP' : undefined,
      message: `Не удалось подключиться к источнику: ${message}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function parseNormalizedSnapshot(value: unknown): MarketSnapshot {
  // This is ECOInter's explicit import contract, not an assertion about GoodPrice's actual API.
  return normalizedSnapshotSchema.parse(value) as MarketSnapshot;
}
