import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Durable mock state for ONE Indodax account (Mopay's corporate account). Big numbers are TEXT. */
export class IndodaxStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deposit_addresses (
        coin TEXT NOT NULL, network TEXT NOT NULL, address TEXT NOT NULL, private_key TEXT NOT NULL,
        PRIMARY KEY (coin, network));
      CREATE TABLE IF NOT EXISTS balances (asset TEXT PRIMARY KEY, free TEXT NOT NULL, locked TEXT NOT NULL DEFAULT '0');
      CREATE TABLE IF NOT EXISTS coin_deposits (
        id INTEGER PRIMARY KEY AUTOINCREMENT, coin TEXT NOT NULL, network TEXT NOT NULL,
        tx_id TEXT NOT NULL, log_index INTEGER NOT NULL, from_address TEXT NOT NULL, address TEXT NOT NULL,
        amount_base TEXT NOT NULL, decimals INTEGER NOT NULL, block_number INTEGER NOT NULL,
        status TEXT NOT NULL, insert_time INTEGER NOT NULL, complete_time INTEGER, credit_after INTEGER NOT NULL,
        UNIQUE (tx_id, log_index));
      CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT, client_order_id TEXT NOT NULL UNIQUE, symbol TEXT NOT NULL,
        side TEXT NOT NULL, type TEXT NOT NULL, orig_qty TEXT NOT NULL, executed_qty TEXT NOT NULL,
        status TEXT NOT NULL, time INTEGER NOT NULL, visible_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS trades (
        trade_id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, client_order_id TEXT NOT NULL,
        symbol TEXT NOT NULL, price TEXT NOT NULL, qty TEXT NOT NULL, quote_qty TEXT NOT NULL,
        commission TEXT NOT NULL, is_buyer INTEGER NOT NULL, time INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS fiat_withdrawals (
        order_no TEXT PRIMARY KEY, client_request_id TEXT UNIQUE, request_hash TEXT NOT NULL,
        amount TEXT NOT NULL, fee TEXT NOT NULL, bank_code TEXT NOT NULL, account_number TEXT NOT NULL,
        status TEXT NOT NULL, create_time INTEGER NOT NULL, update_time INTEGER NOT NULL, settle_at INTEGER NOT NULL);
    `);
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  meta(k: string): string | undefined {
    return (this.db.prepare('SELECT v FROM meta WHERE k = ?').get(k) as { v: string } | undefined)?.v;
  }
  setMeta(k: string, v: string) {
    this.db
      .prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v')
      .run(k, v);
  }

  /** Balances are stored in integer "atoms": 1e8 per coin unit, 1 per rupiah. */
  balance(asset: string): bigint {
    const r = this.db.prepare('SELECT free FROM balances WHERE asset = ?').get(asset) as
      { free: string } | undefined;
    return r ? BigInt(r.free) : 0n;
  }
  addBalance(asset: string, delta: bigint) {
    const next = this.balance(asset) + delta;
    if (next < 0n) throw new Error(`negative ${asset} balance`);
    this.db
      .prepare(
        `INSERT INTO balances (asset, free) VALUES (?, ?) ON CONFLICT (asset) DO UPDATE SET free = excluded.free`,
      )
      .run(asset, next.toString());
  }
}

export const COIN_SCALE = 100_000_000n; // Indodax quantities have 8 decimals (quantity_increment 1e-8)
