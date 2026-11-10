import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.ts';

const location = process.env.DATABASE_PATH ?? './data/ecointer.sqlite';
fs.mkdirSync(path.dirname(path.resolve(location)), { recursive: true });
export const sqlite = new Database(location);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');
sqlite.exec(`
CREATE TABLE IF NOT EXISTS servers (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, game_server_url TEXT NOT NULL, goodprice_url TEXT NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 1, priority INTEGER NOT NULL DEFAULT 100, refresh_seconds INTEGER NOT NULL DEFAULT 300,
 encrypted_token TEXT, status TEXT NOT NULL DEFAULT 'not_checked', last_sync_at TEXT, last_error TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS offers (
 id TEXT PRIMARY KEY, server_id TEXT NOT NULL, item_id TEXT NOT NULL, item_name TEXT NOT NULL,
 action TEXT NOT NULL, currency TEXT NOT NULL, total_price TEXT NOT NULL, quantity INTEGER NOT NULL,
 quote_kind TEXT NOT NULL, observed_at TEXT NOT NULL, source_id TEXT, imported_at TEXT NOT NULL,
 store_id TEXT, store_name TEXT, trade_allowed INTEGER NOT NULL DEFAULT 1, trade_restriction TEXT
);
CREATE INDEX IF NOT EXISTS offers_lookup_idx ON offers(server_id, item_id, currency, action);
CREATE INDEX IF NOT EXISTS offers_observed_idx ON offers(observed_at);
CREATE TABLE IF NOT EXISTS price_history (
 id INTEGER PRIMARY KEY AUTOINCREMENT, offer_id TEXT NOT NULL, server_id TEXT NOT NULL, item_id TEXT NOT NULL,
 action TEXT NOT NULL, currency TEXT NOT NULL, total_price TEXT NOT NULL, quantity INTEGER NOT NULL, observed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS history_item_idx ON price_history(server_id, item_id, observed_at);
CREATE TABLE IF NOT EXISTS events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT NOT NULL, type TEXT NOT NULL, message TEXT NOT NULL,
 server_id TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS simulations (
 id TEXT PRIMARY KEY, opportunity_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, currency TEXT NOT NULL,
 expected_capital TEXT NOT NULL, expected_profit TEXT NOT NULL, actual_profit TEXT, note TEXT, snapshot TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS simulations_created_idx ON simulations(created_at);
`);

// Upgrade existing local databases in place. Previously imported offers remain valid by
// default until the next GoodPrice sync replaces them with store-aware snapshots.
const offerColumns = new Set((sqlite.pragma('table_info(offers)') as Array<{ name: string }>).map((column) => column.name));
if (!offerColumns.has('store_id')) sqlite.exec('ALTER TABLE offers ADD COLUMN store_id TEXT');
if (!offerColumns.has('store_name')) sqlite.exec('ALTER TABLE offers ADD COLUMN store_name TEXT');
if (!offerColumns.has('trade_allowed')) sqlite.exec('ALTER TABLE offers ADD COLUMN trade_allowed INTEGER NOT NULL DEFAULT 1');
if (!offerColumns.has('trade_restriction')) sqlite.exec('ALTER TABLE offers ADD COLUMN trade_restriction TEXT');

export const db = drizzle(sqlite, { schema });
