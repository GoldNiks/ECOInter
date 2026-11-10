import type { AnalysisOptions, Opportunity, ServerRecord } from '../../shared/types';

const API = '/api';
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  // Fastify rejects an empty request body when JSON Content-Type is set.
  // Only send that header for requests that actually carry a body.
  if (init?.body !== undefined && init.body !== null && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers,
  });
  const raw = await response.text();
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
  } catch {
    // Vite proxy and startup failures may return plain text or HTML, not JSON.
  }
  if (!response.ok) {
    const detail = typeof body.error === 'string' ? body.error
      : raw.trim() && !raw.trimStart().startsWith('<') ? raw.trim().slice(0, 500)
      : `HTTP ${response.status}`;
    throw new Error(`${path}: ${detail}`);
  }
  return body as T;
}
export const api = {
  health: () => request<{ ok: boolean; time: string; goodPrice: string }>('/health'),
  dashboard: () => request<{
    servers: number; connectedServers: number; products: number; offers: number; opportunities: number;
    direct: number; routes: number; bestProfit: string; lastUpdated: string | null; dataReady: boolean;
  }>('/dashboard'),
  servers: () => request<ServerRecord[]>('/servers'),
  addServer: (payload: unknown) => request('/servers', { method: 'POST', body: JSON.stringify(payload) }),
  removeServer: (id: string) => request(`/servers/${id}`, { method: 'DELETE' }),
  probeServer: (id: string) => request<{ reachable: boolean; verified: boolean; statusCode?: number; message: string; warning?: string; storesCount?: number; offersCount?: number; tokenConfigured: boolean }>(`/servers/${id}/probe`, { method: 'POST' }),
  saveServerToken: (id: string, token: string) => request<{ ok: boolean; tokenConfigured: boolean }>(`/servers/${id}/token`, { method: 'POST', body: JSON.stringify({ token }) }),
  syncServer: (id: string) => request<{ ok: boolean; imported: number; capturedAt: string }>(`/servers/${id}/sync`, { method: 'POST', body: JSON.stringify({}) }),
  opportunities: (kind = 'all') => request<{ opportunities: Opportunity[]; count: number; analyzedOffers: number }>(`/opportunities?kind=${kind}`),
  searchRoutes: (currency: string, capital: string) => request<{ routes: import('../../shared/types').MultiStepOpportunity[]; count: number; analyzedOffers: number }>('/routes/search', { method: 'POST', body: JSON.stringify({ currency, capital }) }),
  marketOffers: () => request<Array<import('../../shared/types').MarketOffer>>('/market/offers'),
  history: () => request<Array<{ id: number; offerId: string; serverId: string; itemId: string; action: string; currency: string; totalPrice: string; quantity: number; observedAt: string }>>('/history'),
  importSnapshot: (payload: unknown) => request<{ ok: boolean; imported: number }>('/market/import', { method: 'POST', body: JSON.stringify(payload) }),
  products: () => request<Array<{ itemId: string; itemName: string; servers: string[]; currencies: string[]; offerCount: number; latest: string }>>('/products'),
  simulations: () => request<Array<{ id: string; opportunityId: string; kind: string; status: string; currency: string; expectedCapital: string; expectedProfit: string; actualProfit: string | null; note: string | null; snapshot: string; createdAt: string; updatedAt: string }>>('/simulations'),
  startSimulation: (opportunityId: string) => request<{ id: string; status: string }>('/simulations', { method: 'POST', body: JSON.stringify({ opportunityId }) }),
  updateSimulation: (id: string, value: { status: 'completed' | 'failed'; actualProfit?: string; note?: string }) => request('/simulations/' + id, { method: 'PATCH', body: JSON.stringify(value) }),
  events: () => request<Array<{ id: number; level: string; type: string; message: string; serverId: string | null; createdAt: string }>>('/events'),
  analysisSettings: () => request<AnalysisOptions>('/settings/analysis'),
  saveAnalysisSettings: (value: AnalysisOptions) => request('/settings/analysis', { method: 'POST', body: JSON.stringify(value) }),
};
