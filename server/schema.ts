import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const servers = sqliteTable('servers', {
  id: text('id').primaryKey(), name: text('name').notNull(), gameServerUrl: text('game_server_url').notNull(),
  goodPriceUrl: text('goodprice_url').notNull(), enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  priority: integer('priority').notNull().default(100), refreshSeconds: integer('refresh_seconds').notNull().default(300),
  encryptedToken: text('encrypted_token'), status: text('status').notNull().default('not_checked'),
  lastSyncAt: text('last_sync_at'), lastError: text('last_error'), createdAt: text('created_at').notNull(),
});

export const offers = sqliteTable('offers', {
  id: text('id').primaryKey(), serverId: text('server_id').notNull(), itemId: text('item_id').notNull(),
  itemName: text('item_name').notNull(), action: text('action').notNull(), currency: text('currency').notNull(),
  totalPrice: text('total_price').notNull(), quantity: integer('quantity').notNull(), quoteKind: text('quote_kind').notNull(),
  observedAt: text('observed_at').notNull(), sourceId: text('source_id'), importedAt: text('imported_at').notNull(),
});

export const priceHistory = sqliteTable('price_history', {
  id: integer('id').primaryKey({ autoIncrement: true }), offerId: text('offer_id').notNull(),
  serverId: text('server_id').notNull(), itemId: text('item_id').notNull(), action: text('action').notNull(),
  currency: text('currency').notNull(), totalPrice: text('total_price').notNull(), quantity: integer('quantity').notNull(),
  observedAt: text('observed_at').notNull(),
});

export const events = sqliteTable('events', {
  id: integer('id').primaryKey({ autoIncrement: true }), level: text('level').notNull(), type: text('type').notNull(),
  message: text('message').notNull(), serverId: text('server_id'), createdAt: text('created_at').notNull(),
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(), value: text('value').notNull(), updatedAt: text('updated_at').notNull(),
});


export const simulations = sqliteTable('simulations', {
  id: text('id').primaryKey(), opportunityId: text('opportunity_id').notNull(), kind: text('kind').notNull(),
  status: text('status').notNull(), currency: text('currency').notNull(), expectedCapital: text('expected_capital').notNull(),
  expectedProfit: text('expected_profit').notNull(), actualProfit: text('actual_profit'), note: text('note'),
  snapshot: text('snapshot').notNull(), createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull(),
});
