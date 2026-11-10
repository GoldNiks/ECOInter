import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity, AlertTriangle, ArrowDownRight, ArrowLeftRight, ArrowUpRight, Boxes, ChartNoAxesCombined,
  ChevronDown, CircleDollarSign, Clock3, Compass, Database, FileClock, Gauge, LayoutDashboard,
  ListFilter, LoaderCircle, Plus, RefreshCw, Route, Search, Settings2, ShieldCheck, ShoppingBag,
  Server, SlidersHorizontal, Trash2, TrendingUp, X,
} from 'lucide-react';
import { api } from './lib/api';
import type { AnalysisOptions, Opportunity, ServerRecord } from '../shared/types';

type Page = 'overview' | 'opportunities' | 'routes' | 'products' | 'history' | 'simulation' | 'servers' | 'journal' | 'settings';
const NAV: Array<{ id: Page; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'overview', label: 'Обзор', icon: LayoutDashboard },
  { id: 'opportunities', label: 'Возможности', icon: ChartNoAxesCombined },
  { id: 'routes', label: 'Конструктор маршрутов', icon: Route },
  { id: 'products', label: 'Товары', icon: Boxes },
  { id: 'history', label: 'История цен', icon: TrendingUp },
  { id: 'simulation', label: 'Симуляция', icon: Activity },
  { id: 'servers', label: 'Серверы', icon: Server },
  { id: 'journal', label: 'Журнал', icon: FileClock },
  { id: 'settings', label: 'Настройки', icon: Settings2 },
];
const fmt = (value: string | number, digits = 2) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(Number(value));
const time = (value?: string | null) => value ? new Date(value).toLocaleString('ru-RU') : '—';

export default function App() {
  const [page, setPage] = useState<Page>('overview');
  const [dashboard, setDashboard] = useState<Awaited<ReturnType<typeof api.dashboard>> | null>(null);
  const [servers, setServers] = useState<ServerRecord[]>([]);
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [products, setProducts] = useState<Awaited<ReturnType<typeof api.products>>>([]);
  const [events, setEvents] = useState<Awaited<ReturnType<typeof api.events>>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [d, s, o, p, e] = await Promise.all([api.dashboard(), api.servers(), api.opportunities(), api.products(), api.events()]);
      setDashboard(d); setServers(s); setOpportunities(o.opportunities); setProducts(p); setEvents(e);
    } catch (err) { setError(err instanceof Error ? err.message : 'Не удалось загрузить данные API'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const title = NAV.find((n) => n.id === page)?.label ?? 'Обзор';
  const activeOpps = useMemo(() => opportunities.filter((o) => o.kind !== 'interserver'), [opportunities]);
  const showNotice = useCallback((message: string) => { setNotice(message); window.setTimeout(() => setNotice(''), 5000); }, []);

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">E</div><div><strong>ECOInter</strong><span>MARKET ANALYZER</span></div></div>
      <div className="workspace"><span className="status-dot offline" /> Локальная аналитика <ChevronDown size={14} /></div>
      <div className="nav-caption">РАБОЧЕЕ ПРОСТРАНСТВО</div>
      <nav>{NAV.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-item ${page === id ? 'active' : ''}`} onClick={() => setPage(id)}><Icon size={17} /><span>{label}</span>{id === 'opportunities' && activeOpps.length > 0 && <em>{activeOpps.length}</em>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="source-card"><div className="source-head"><span className="status-dot warning" /> GoodPrice</div><p>Источник не проверен</p><small>Нет подтверждённого соединения</small></div><div className="local-note"><ShieldCheck size={14} /> Данные остаются локально</div></div>
    </aside>

    <main className="main-area">
      <header className="topbar"><div className="crumb">ECOInter <span>/</span> <b>{title}</b></div><div className="top-actions"><div className="api-state"><span className="status-dot warning" /> Источник не подтверждён</div><button className="icon-button" onClick={() => void refresh()} title="Обновить"><RefreshCw size={16} className={loading ? 'spin' : ''} /></button><div className="avatar">EI</div></div></header>
      <div className="page-wrap">
        {error && <div className="alert error"><AlertTriangle size={17} /> {error} <button onClick={() => void refresh()}>Повторить</button></div>}
        {notice && <div className="alert success">{notice}</div>}
        {page === 'overview' && <Dashboard dashboard={dashboard} opportunities={opportunities} servers={servers} loading={loading} setPage={setPage} />}
        {page === 'opportunities' && <OpportunitiesPage items={opportunities} loading={loading} />}
        {page === 'routes' && <RouteBuilder />}
        {page === 'products' && <ProductsPage items={products} />}
        {page === 'history' && <HistoryPage />}
        {page === 'simulation' && <SimulationPage opportunities={activeOpps} />}
        {page === 'servers' && <ServersPage servers={servers} onChange={refresh} notify={showNotice} />}
        {page === 'journal' && <JournalPage events={events} />}
        {page === 'settings' && <SettingsPage notify={showNotice} />}
      </div>
      <footer className="footer"><span>ECOInter · локальный режим</span><span>Рыночные данные не отправляются сторонним аналитическим сервисам</span><span>v0.1.0 · {loading ? 'Обновление…' : 'Готово'}</span></footer>
    </main>
  </div>;
}

function PageHeading({ eyebrow, title, text, action }: { eyebrow: string; title: string; text: string; action?: React.ReactNode }) {
  return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{text}</p></div>{action}</div>;
}
function Metric({ label, value, detail, icon: Icon, tone = 'normal' }: { label: string; value: string; detail: string; icon: typeof Activity; tone?: string }) {
  return <div className="metric-card"><div className={`metric-icon ${tone}`}><Icon size={18} /></div><div className="metric-label">{label}</div><div className="metric-value">{value}</div><div className="metric-detail">{detail}</div></div>;
}
function Dashboard({ dashboard, opportunities, servers, loading, setPage }: { dashboard: Awaited<ReturnType<typeof api.dashboard>> | null; opportunities: Opportunity[]; servers: ServerRecord[]; loading: boolean; setPage: (p: Page) => void }) {
  const best = opportunities.filter((o) => o.kind !== 'interserver').slice(0, 5);
  return <>
    <PageHeading eyebrow="MARKET OVERVIEW" title="Обзор рынка" text="Сводка реальных предложений и потенциальных торговых возможностей." action={<button className="button secondary" onClick={() => setPage('servers')}><Plus size={16} /> Добавить сервер</button>} />
    <div className="metrics-grid">
      <Metric label="Серверы с данными" value={`${dashboard?.connectedServers ?? 0} / ${dashboard?.servers ?? 0}`} detail="С импортированными предложениями" icon={Server} />
      <Metric label="Товаров в анализе" value={fmt(dashboard?.products ?? 0, 0)} detail="Уникальные позиции" icon={Boxes} tone="blue" />
      <Metric label="Рыночные предложения" value={fmt(dashboard?.offers ?? 0, 0)} detail="Получены из источников" icon={ShoppingBag} tone="violet" />
      <Metric label="Прямые сделки" value={fmt(dashboard?.direct ?? 0, 0)} detail="Покупка → продажа" icon={ArrowLeftRight} tone="green" />
      <Metric label="Многоэтапные маршруты" value={fmt(dashboard?.routes ?? 0, 0)} detail="Преобразование валют через товары" icon={Route} tone="green" />
    </div>
    <div className="section-row"><div><div className="eyebrow">OPPORTUNITY ENGINE</div><h2>Лучшие возможности</h2></div><button className="text-button" onClick={() => setPage('opportunities')}>Все возможности <ArrowUpRight size={15} /></button></div>
    <div className="panel opportunity-panel">
      {loading ? <Loading /> : best.length ? <OpportunityTable items={best} compact /> : <EmptyState icon={ChartNoAxesCombined} title="Пока нет подтверждённых возможностей" text="Добавьте сервер и импортируйте реальные предложения. Аналитика не показывает тестовые или выдуманные цены." action={<button className="button primary" onClick={() => setPage('servers')}>Настроить источник</button>} />}
    </div>
    <div className="lower-grid">
      <div className="panel panel-pad"><div className="panel-title"><div><h3>Состояние источников</h3><p>Подключённые игровые рынки</p></div><button className="icon-button" onClick={() => setPage('servers')}><ArrowUpRight size={16} /></button></div>
        {servers.length ? <div className="server-list">{servers.slice(0, 4).map((s) => <div className="server-row" key={s.id}><span className={`status-dot ${s.status === 'imported_normalized' ? 'online' : 'warning'}`} /><div className="server-name"><strong>{s.name}</strong><small>{s.goodPriceUrl}</small></div><span className="server-state">{statusLabel(s.status)}</span></div>)}</div> : <div className="muted-empty">Серверы ещё не добавлены.</div>}
      </div>
      <div className="panel panel-pad"><div className="panel-title"><div><h3>Свежесть данных</h3><p>Последнее наблюдение рынка</p></div><Clock3 size={17} className="muted-icon" /></div><div className="freshness-value">{time(dashboard?.lastUpdated)}</div><div className="freshness-note"><span className="status-dot warning" /> {dashboard?.dataReady ? 'Данные загружены; актуальность проверяйте по предложениям' : 'Нет импортированных рыночных данных'}</div><div className="mini-info"><Database size={15} /> История хранится в локальной SQLite</div></div>
    </div>
  </>;
}
function statusLabel(status: string) { return ({ imported_normalized: 'Данные импортированы', reachable_unverified: 'Ответ есть · API не проверен', unavailable: 'Недоступен', not_checked: 'Не проверен' } as Record<string, string>)[status] ?? status; }
function Loading() { return <div className="loading"><LoaderCircle className="spin" size={20} /> Загрузка данных…</div>; }
function EmptyState({ icon: Icon, title, text, action }: { icon: typeof Activity; title: string; text: string; action?: React.ReactNode }) { return <div className="empty-state"><div className="empty-icon"><Icon size={22} /></div><h3>{title}</h3><p>{text}</p>{action}</div>; }
function OpportunityTable({ items, compact = false }: { items: Opportunity[]; compact?: boolean }) {
  return <div className="table-scroll"><table><thead><tr><th>Возможность</th><th>Тип</th><th>Маршрут / сервер</th><th>Капитал</th><th>Результат</th><th>Доходность</th><th>Данные</th></tr></thead><tbody>{items.map((item) => {
    const name = item.kind === 'direct' ? item.itemName : item.kind === 'multi_step' ? item.legs.map((l) => l.itemName).join(' → ') : item.itemName;
    const profit = item.kind === 'interserver' ? item.priceGap : item.netProfit;
    const capital = item.kind === 'multi_step' ? `${item.initialCapital} ${item.startCurrency}` : item.kind === 'direct' ? `${item.buyCost} ${item.currency}` : `${item.referenceBuyCost} ${item.currency}`;
    const currency = item.kind === 'multi_step' ? item.startCurrency : item.currency;
    const roi = item.kind === 'interserver' ? 'не исполняется' : `${fmt(item.roiPercent)}%`;
    return <tr key={item.id}><td><strong>{name}</strong><small>{item.kind === 'multi_step' ? `${item.legs.length} товара · ${item.operations} операции` : item.kind === 'direct' ? `${item.quantity} ед.` : `${item.quantity} ед.`}</small></td><td><span className={`type-pill ${item.kind}`}>{item.kind === 'direct' ? 'Прямая' : item.kind === 'multi_step' ? 'Маршрут' : 'Разница цен'}</span></td><td>{item.kind === 'direct' ? item.serverId : item.kind === 'multi_step' ? `${item.startCurrency} → ${item.endCurrency}` : `${item.buyServerId} → ${item.sellServerId}`}</td><td className="mono">{capital}</td><td><strong className="positive mono">+{fmt(profit)} {currency}</strong></td><td className="mono">{roi}</td><td><span className="data-tag">{item.kind === 'interserver' ? 'Не исполняется' : item.quoteKind === 'listing' ? 'Предложения' : 'Оценка'}</span></td></tr>;
  })}</tbody></table></div>;
}
function OpportunitiesPage({ items, loading }: { items: Opportunity[]; loading: boolean }) {
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const filtered = items.filter((o) => (filter === 'all' || o.kind === filter) && JSON.stringify(o).toLowerCase().includes(search.toLowerCase()));
  return <><PageHeading eyebrow="LIVE SCANNER" title="Торговые возможности" text="Независимые результаты прямого анализа, маршрутов и межсерверного сравнения." action={<div className="search-box"><Search size={15} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Поиск по товару…" /></div>} />
    <div className="toolbar"><div className="segmented">{[['all', 'Все'], ['direct', 'Прямые сделки'], ['multi_step', 'Маршруты'], ['interserver', 'Разница серверов']].map(([key, label]) => <button key={key} className={filter === key ? 'selected' : ''} onClick={() => setFilter(key)}>{label}</button>)}</div><div className="toolbar-meta"><ListFilter size={14} /> {filtered.length} результатов</div></div>
    <div className="panel">{loading ? <Loading /> : filtered.length ? <OpportunityTable items={filtered} /> : <EmptyState icon={Search} title="Ничего не найдено" text="Проверьте фильтр или импортируйте рыночные предложения. Межсерверные разницы не считаются исполнимыми сделками." />}</div>
  </>;
}
function RouteBuilder() {
  const [currency, setCurrency] = useState('RELAX');
  const [capital, setCapital] = useState('150');
  const [routes, setRoutes] = useState<Extract<Opportunity, { kind: 'multi_step' }>[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const search = async () => {
    setBusy(true); setMessage(''); setSelected('');
    try { const result = await api.searchRoutes(currency.trim(), capital.trim()); setRoutes(result.routes); if (!result.routes.length) setMessage(`Маршруты из ${capital} ${currency} не найдены. Обработано предложений: ${result.analyzedOffers}.`); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Не удалось выполнить поиск'); }
    finally { setBusy(false); }
  };
  const chosen = routes.find((x) => x.id === selected);
  return <><PageHeading eyebrow="ROUTE LAB" title="Конструктор маршрутов" text="Поиск многоэтапных цепочек с заданной начальной валютой и капиталом." />
    <div className="builder-layout"><div className="panel panel-pad"><div className="panel-title"><div><h3>Параметры поиска</h3><p>Начальный актив и доступный капитал</p></div><SlidersHorizontal size={17} className="muted-icon" /></div><label className="field-label">Начальная валюта</label><input className="field" value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} placeholder="Например, RELAX" /><label className="field-label">Начальный капитал</label><input className="field" value={capital} onChange={(e) => setCapital(e.target.value)} inputMode="decimal" /><div className="hint-block"><AlertTriangle size={16} /> Маршрут состоит из последовательных пар «купить товар → продать товар». Все этапы в одном сервере; межсерверный перенос не предполагается.</div><button className="button primary full" onClick={() => void search()} disabled={busy || !currency.trim() || !capital.trim()}>{busy ? <><LoaderCircle size={14} className="spin" /> Анализ…</> : <><Compass size={14} /> Найти маршруты</>}</button>{message && <div className="probe-result">{message}</div>}</div>
      <div className="panel panel-pad route-results"><div className="panel-title"><div><h3>Результаты поиска</h3><p>{routes.length} маршрутов · отдельный многоэтапный движок</p></div><Route size={17} className="muted-icon" /></div>
        {chosen ? <><div className="route-summary"><div><span>Старт</span><b>{chosen.initialCapital} {chosen.startCurrency}</b></div><div><span>Финиш</span><b className="positive">{chosen.finalCapital} {chosen.endCurrency}</b></div><div><span>Чистая прибыль</span><b className="positive">+{chosen.netProfit}</b></div><div><span>Доходность</span><b>{fmt(chosen.roiPercent)}%</b></div></div><div className="route-step-list">{chosen.legs.map((leg, index) => <div className="route-step" key={`${leg.buyOfferId}-${leg.sellOfferId}`}><div className="step-number">{index + 1}</div><div className="step-content"><strong>{leg.itemName}</strong><small>Купить {leg.quantity} ед. за {leg.buyCost} {leg.fromCurrency}</small><small>Продать за {leg.sellRevenue} {leg.toCurrency}</small></div><div className="step-balance"><span>Баланс</span><b>{leg.outputBalance} {leg.toCurrency}</b></div></div>)}</div><div className="hint-block"><ShieldCheck size={16} /> {chosen.quoteKind === 'listing' ? 'Расчёт основан на предложениях типа listing. Доступность всё равно нужно перепроверить перед сделкой.' : 'В маршруте есть справочные котировки: результат является оценкой, а не исполнимой сделкой.'} {chosen.capitalAssumed ? 'Стартовый капитал был подобран автоматически.' : ''}</div><button className="text-button" onClick={() => setSelected('')}>Назад к списку</button></> : routes.length ? <div className="route-choice-list">{routes.map((r) => <button className="route-choice" key={r.id} onClick={() => setSelected(r.id)}><div><strong>{r.legs.map((x) => x.itemName).join(' → ')}</strong><small>{r.operations} операции · {r.startCurrency} → {r.endCurrency}</small></div><div><b className="positive">+{r.netProfit}</b><small>{fmt(r.roiPercent)}% ROI</small></div></button>)}</div> : <EmptyState icon={Route} title="Задайте капитал и запустите поиск" text="Конструктор покажет последовательность товаров, количества, стоимость каждого этапа, промежуточные балансы и итоговую прибыль." />}
      </div></div>
  </>;
}
function ProductsPage({ items }: { items: Awaited<ReturnType<typeof api.products>> }) {
  const [search, setSearch] = useState('');
  const data = items.filter((x) => `${x.itemName} ${x.itemId}`.toLowerCase().includes(search.toLowerCase()));
  return <><PageHeading eyebrow="ITEM CATALOG" title="Товары" text="Каталог формируется только из импортированных рыночных предложений." action={<div className="search-box"><Search size={15} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Название или ID" /></div>} />
    <div className="panel">{data.length ? <div className="table-scroll"><table><thead><tr><th>Товар</th><th>ID</th><th>Серверы</th><th>Валюты</th><th>Предложения</th><th>Последнее наблюдение</th></tr></thead><tbody>{data.map((x) => <tr key={x.itemId}><td><strong>{x.itemName}</strong></td><td className="mono">{x.itemId}</td><td>{x.servers.length}</td><td>{x.currencies.join(', ')}</td><td>{x.offerCount}</td><td>{time(x.latest)}</td></tr>)}</tbody></table></div> : <EmptyState icon={Boxes} title="Каталог пока пуст" text="Товары появятся после импорта нормализованных предложений от подключённого источника." />}</div>
  </>;
}
function HistoryPage() {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof api.history>>>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => { void api.history().then(setRows).catch(() => setRows([])).finally(() => setLoading(false)); }, []);
  const values = rows.slice(0, 40).reverse();
  const max = Math.max(1, ...values.map((x) => Number(x.totalPrice)));
  return <><PageHeading eyebrow="PRICE HISTORY" title="История цен" text="Сохранённые снимки предложений из локальной SQLite." />
    <div className="panel panel-pad">{loading ? <Loading /> : rows.length ? <><div className="history-summary"><div><span>Наблюдений</span><strong>{rows.length}</strong></div><div><span>Товаров в выборке</span><strong>{new Set(rows.map((x) => x.itemId)).size}</strong></div><div><span>Последняя запись</span><strong>{time(rows[0]?.observedAt)}</strong></div></div><div className="history-bars">{values.map((x) => <div key={x.id} title={`${x.itemId} · ${x.totalPrice} ${x.currency} · ${time(x.observedAt)}`} style={{ height: `${Math.max(4, Number(x.totalPrice) / max * 100)}%` }} />)}</div><div className="table-scroll"><table><thead><tr><th>Товар ID</th><th>Сервер</th><th>Операция</th><th>Общая цена</th><th>Количество</th><th>Наблюдение</th></tr></thead><tbody>{rows.map((x) => <tr key={x.id}><td>{x.itemId}</td><td>{x.serverId}</td><td>{x.action === 'buy' ? 'Покупка' : 'Продажа'}</td><td className="mono">{x.totalPrice} {x.currency}</td><td>{x.quantity}</td><td>{time(x.observedAt)}</td></tr>)}</tbody></table></div></> : <EmptyState icon={Clock3} title="История ещё не накоплена" text="После импорта реальные снимки предложений будут сохраняться в SQLite с отметкой времени." />}</div></>;
}
function SimulationPage({ opportunities }: { opportunities: Opportunity[] }) {
  type Simulation = Awaited<ReturnType<typeof api.simulations>>[number];
  const [selected, setSelected] = useState('');
  const [actual, setActual] = useState<Record<string, string>>({});
  const [records, setRecords] = useState<Simulation[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const candidates = opportunities.filter((o) => o.kind !== 'interserver');
  const load = useCallback(async () => { setRecords(await api.simulations()); }, []);
  useEffect(() => { void load().catch((e) => setMessage(e.message)); }, [load]);
  const start = async () => { if (!selected) return; setBusy(true); setMessage(''); try { await api.startSimulation(selected); await load(); setMessage('Создана виртуальная сделка. Никакие игровые ордера не отправлялись.'); } catch (e) { setMessage(e instanceof Error ? e.message : 'Не удалось создать симуляцию'); } finally { setBusy(false); } };
  const finish = async (record: Simulation, status: 'completed' | 'failed') => { setBusy(true); try { const profit = actual[record.id]?.trim(); await api.updateSimulation(record.id, { status, ...(profit ? { actualProfit: profit } : {}) }); await load(); setMessage(status === 'completed' ? 'Результат симуляции сохранён.' : 'Симуляция помечена как неудачная.'); } catch (e) { setMessage(e instanceof Error ? e.message : 'Не удалось сохранить результат'); } finally { setBusy(false); } };
  return <><PageHeading eyebrow="PAPER TRADING" title="Симуляция" text="Записывайте виртуальное исполнение найденных сделок и сравнивайте ожидаемую и фактическую прибыль." />
    <div className="panel panel-pad simulation-create"><div className="panel-title"><div><h3>Новая симуляция</h3><p>Выберите рассчитанную возможность и зафиксируйте план сделки</p></div><Activity size={17} className="muted-icon" /></div><div className="simulation-create-row"><select className="field" value={selected} onChange={(e) => setSelected(e.target.value)}><option value="">Выберите прямую сделку или маршрут</option>{candidates.map((o) => <option key={o.id} value={o.id}>{o.kind === 'direct' ? `Прямая · ${o.itemName}` : `Маршрут · ${o.legs.map((l) => l.itemName).join(' → ')}`}</option>)}</select><button className="button primary" disabled={!selected || busy} onClick={() => void start()}>Создать симуляцию</button></div>{message && <div className="probe-result">{message}</div>}{!candidates.length && <div className="empty-inline">Нет доступных сценариев. Сначала загрузите котировки и запустите анализ.</div>}</div>
    <div className="section-row simulation-heading"><div><div className="eyebrow">SIMULATION LOG</div><h2>История виртуального исполнения</h2></div><span className="toolbar-meta">{records.length} записей</span></div>
    <div className="panel">{records.length ? <div className="simulation-list">{records.map((r) => <div className="simulation-row" key={r.id}><div className="simulation-state"><span className={`event-level ${r.status === 'completed' ? 'info' : r.status === 'failed' ? 'error' : 'warning'}`}>{r.status === 'completed' ? 'ВЫПОЛНЕНО' : r.status === 'failed' ? 'НЕУДАЧА' : 'ЗАПЛАНИРОВАНО'}</span><small>{time(r.createdAt)}</small></div><div className="simulation-detail"><strong>{r.kind === 'direct' ? 'Прямая сделка' : 'Многоэтапный маршрут'}</strong><small>Капитал: {r.expectedCapital} {r.currency} · Ожидалось: +{r.expectedProfit} {r.currency}</small>{r.actualProfit !== null && <small>Фактически: {r.actualProfit} {r.currency}</small>}{r.note && <small>{r.note}</small>}</div>{r.status === 'planned' && <div className="simulation-actions"><input className="field actual-input" value={actual[r.id] ?? ''} onChange={(e) => setActual((x) => ({ ...x, [r.id]: e.target.value }))} placeholder="Факт. прибыль" /><button className="button secondary small" disabled={busy} onClick={() => void finish(r, 'completed')}>Выполнено</button><button className="button secondary small" disabled={busy} onClick={() => void finish(r, 'failed')}>Неудача</button></div>}</div>)}</div> : <EmptyState icon={Activity} title="Симуляций пока нет" text="Создайте виртуальный сценарий из актуальной найденной возможности. Статусы и фактическая прибыль сохраняются локально." />}</div>
  </>;
}
function ServersPage({ servers, onChange, notify }: { servers: ServerRecord[]; onChange: () => Promise<void>; notify: (s: string) => void }) {
  const [form, setForm] = useState({ name: '', gameServerUrl: '', goodPriceUrl: 'http://188.235.146.195:3001/plugin/GoodPrice', token: '' });
  const [busy, setBusy] = useState('');
  const [probe, setProbe] = useState<Record<string, string>>({});
  const add = async (e: React.FormEvent) => { e.preventDefault(); setBusy('add'); try { await api.addServer({ ...form, enabled: true, priority: 100, refreshSeconds: 300 }); setForm({ name: '', gameServerUrl: '', goodPriceUrl: 'http://188.235.146.195:3001/plugin/GoodPrice', token: '' }); await onChange(); notify('Сервер добавлен. Проверьте подключение.'); } catch (err) { notify(err instanceof Error ? err.message : 'Не удалось добавить сервер'); } finally { setBusy(''); } };
  const check = async (id: string) => { setBusy(id); try { const r = await api.probeServer(id); setProbe((p) => ({ ...p, [id]: `${r.message}${r.tokenNote ? ` ${r.tokenNote}` : ''}` })); await onChange(); } catch (err) { setProbe((p) => ({ ...p, [id]: err instanceof Error ? err.message : 'Ошибка проверки' })); } finally { setBusy(''); } };
  const remove = async (id: string) => { if (!window.confirm('Удалить сервер и его текущие предложения? История наблюдений сохранится.')) return; await api.removeServer(id); await onChange(); notify('Сервер удалён.'); };
  const importFile = async (file?: File) => { if (!file) return; setBusy('import'); try { const payload = JSON.parse(await file.text()); const result = await api.importSnapshot(payload); await onChange(); notify(`Импортировано предложений: ${result.imported}`); } catch (err) { notify(err instanceof Error ? err.message : 'Не удалось импортировать файл'); } finally { setBusy(''); } };
  return <><PageHeading eyebrow="CONNECTION MANAGER" title="Игровые серверы" text="У каждого сервера свои параметры, источник, история соединения и токен." />
    <div className="servers-layout"><div className="panel panel-pad"><div className="panel-title"><div><h3>Добавить сервер</h3><p>Новая конфигурация подключения</p></div><Plus size={17} className="muted-icon" /></div><form onSubmit={add}><label className="field-label">Название</label><input className="field" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Например, Eco World 1" /><label className="field-label">Адрес игрового сервера</label><input className="field" value={form.gameServerUrl} onChange={(e) => setForm({ ...form, gameServerUrl: e.target.value })} placeholder="https://…" /><label className="field-label">GoodPrice URL</label><input className="field" required value={form.goodPriceUrl} onChange={(e) => setForm({ ...form, goodPriceUrl: e.target.value })} /><label className="field-label">Токен (необязательно)</label><input className="field" type="password" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} placeholder="Сохранение доступно только с master key" /><div className="hint-block"><AlertTriangle size={16} /> URL использует HTTP. Токен не будет отправлен, пока формат авторизации GoodPrice не подтверждён.</div><button className="button primary full" disabled={busy === 'add'}>{busy === 'add' ? 'Добавление…' : 'Добавить сервер'}</button></form></div>
      <div className="server-cards"><div className="panel panel-pad import-panel"><div className="panel-title"><div><h3>Импорт рыночного снимка</h3><p>Файл JSON по внутреннему контракту ECOInter</p></div><Database size={17} className="muted-icon" /></div><input className="field file-field" type="file" accept=".json,application/json" disabled={busy === 'import'} onChange={(e) => void importFile(e.target.files?.[0])} /><small className="muted-text">Это не формат GoodPrice. Используйте только после получения и нормализации реальных предложений.</small></div>{servers.length ? servers.map((s) => <div className="panel server-card" key={s.id}><div className="server-card-top"><div><span className={`status-dot ${s.status === 'imported_normalized' ? 'online' : 'warning'}`} /><h3>{s.name}</h3></div><button className="icon-button danger-hover" onClick={() => void remove(s.id)} title="Удалить"><Trash2 size={15} /></button></div><p className="server-url">{s.goodPriceUrl}</p><div className="server-meta"><span>{statusLabel(s.status)}</span><span>Интервал: {s.refreshSeconds} сек.</span><span>{s.tokenConfigured ? 'Токен сохранён' : 'Без токена'}</span></div>{probe[s.id] && <div className="probe-result">{probe[s.id]}</div>}<div className="server-actions"><button className="button secondary small" disabled={busy === s.id} onClick={() => void check(s.id)}><RefreshCw size={14} className={busy === s.id ? 'spin' : ''} /> Проверить источник</button><span className="muted-text">Последняя синхронизация: {time(s.lastSyncAt)}</span></div></div>) : <div className="panel"><EmptyState icon={Server} title="Серверы не добавлены" text="Добавьте первый игровой сервер, чтобы настроить независимый источник данных." /></div>}</div></div>
  </>;
}
function JournalPage({ events }: { events: Awaited<ReturnType<typeof api.events>> }) { return <><PageHeading eyebrow="EVENT LOG" title="Журнал событий" text="Подключения, импорт, ошибки источников и изменения настроек." /><div className="panel">{events.length ? <div className="event-list">{events.map((e) => <div className="event-row" key={e.id}><span className={`event-level ${e.level}`}>{e.level.toUpperCase()}</span><div><strong>{e.message}</strong><small>{e.type} · {e.serverId ?? 'система'}</small></div><time>{time(e.createdAt)}</time></div>)}</div> : <EmptyState icon={FileClock} title="Журнал пуст" text="События появятся после добавления серверов, проверки источников и импорта данных." />}</div></>; }
function SettingsPage({ notify }: { notify: (s: string) => void }) {
  const [settings, setSettings] = useState<AnalysisOptions | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { void api.analysisSettings().then(setSettings).catch((e) => notify(e.message)); }, [notify]);
  if (!settings) return <Loading />;
  const update = (key: keyof AnalysisOptions, value: number | string) => setSettings((s) => s ? { ...s, [key]: value } : s);
  const save = async () => { setSaving(true); try { await api.saveAnalysisSettings(settings); notify('Настройки аналитики сохранены.'); } catch (e) { notify(e instanceof Error ? e.message : 'Ошибка сохранения'); } finally { setSaving(false); } };
  return <><PageHeading eyebrow="ANALYSIS SETTINGS" title="Настройки аналитики" text="Параметры прямого поиска и глубины многоэтапных торговых цепочек." />
    <div className="settings-grid"><div className="panel panel-pad"><h3>Глубина анализа</h3><div className="form-grid"><label><span>Максимум операций</span><input className="field" type="number" min="2" max="12" value={settings.maxOperations} onChange={(e) => update('maxOperations', Number(e.target.value))} /></label><label><span>Уникальных товаров</span><input className="field" type="number" min="1" max="20" value={settings.maxUniqueItems} onChange={(e) => update('maxUniqueItems', Number(e.target.value))} /></label><label><span>Промежуточных валют</span><input className="field" type="number" min="1" max="12" value={settings.maxIntermediateCurrencies} onChange={(e) => update('maxIntermediateCurrencies', Number(e.target.value))} /></label><label><span>Максимум результатов</span><input className="field" type="number" min="1" max="1000" value={settings.maxResults} onChange={(e) => update('maxResults', Number(e.target.value))} /></label><label><span>Лимит комбинаций</span><input className="field" type="number" min="100" max="1000000" value={settings.maxCombinations} onChange={(e) => update('maxCombinations', Number(e.target.value))} /></label><label><span>Лимит времени, мс</span><input className="field" type="number" min="100" max="30000" value={settings.maxDurationMs} onChange={(e) => update('maxDurationMs', Number(e.target.value))} /></label><label><span>Минимальная прибыль</span><input className="field" value={settings.minProfit} onChange={(e) => update('minProfit', e.target.value)} /></label><label><span>Минимальная доходность, %</span><input className="field" value={settings.minRoiPercent} onChange={(e) => update('minRoiPercent', e.target.value)} /></label><label><span>Макс. возраст котировки, сек.</span><input className="field" type="number" value={settings.maxQuoteAgeSeconds} onChange={(e) => update('maxQuoteAgeSeconds', Number(e.target.value))} /></label></div><button className="button primary" onClick={() => void save()} disabled={saving}>{saving ? 'Сохранение…' : 'Сохранить параметры'}</button></div>
      <div className="panel panel-pad"><h3>Надёжность расчётов</h3><div className="setting-row"><div><b>Прямые сделки</b><small>Вычисляются независимо от маршрутов</small></div><span className="toggle on">Включено</span></div><div className="setting-row"><div><b>Многоэтапные маршруты</b><small>Поиск циклов через валюты и товары</small></div><span className="toggle on">Включено</span></div><div className="setting-row"><div><b>Межсерверные различия</b><small>Не считаются исполнимыми без механизма переноса</small></div><span className="toggle on">Справочно</span></div><div className="hint-block"><ShieldCheck size={16} /> Комиссии по умолчанию равны нулю и применяются только после явной настройки. Для каждого сервера правила могут различаться.</div></div></div>
  </>;
}
