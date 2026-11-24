import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Durable mock-exchange state (SQLite, WAL). Integers that can exceed 2^53 are stored as TEXT
 * and handled as bigint in code. Every mutation runs inside `tx()` so a crash never leaves a
 * half-applied swap.
 */
export class MobeeStore {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS addresses (
        address TEXT PRIMARY KEY, subaccount TEXT NOT NULL, chain_id INTEGER NOT NULL,
        private_key TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE (subaccount, chain_id));
      CREATE TABLE IF NOT EXISTS balances (
        subaccount TEXT NOT NULL, asset TEXT NOT NULL, amount TEXT NOT NULL,
        PRIMARY KEY (subaccount, asset));
      CREATE TABLE IF NOT EXISTS deposits (
        tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, chain_id INTEGER NOT NULL,
        block_number INTEGER NOT NULL, subaccount TEXT NOT NULL, asset TEXT NOT NULL, amount TEXT NOT NULL,
        credit_after_ms INTEGER NOT NULL, status TEXT NOT NULL, credited_at TEXT,
        PRIMARY KEY (tx_hash, log_index));
      CREATE TABLE IF NOT EXISTS quotes (
        id TEXT PRIMARY KEY, subaccount TEXT NOT NULL, symbol TEXT NOT NULL, amount TEXT NOT NULL,
        rate_scaled TEXT NOT NULL, idr_amount TEXT NOT NULL, price_as_of TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL, order_id TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY, quote_id TEXT NOT NULL UNIQUE, subaccount TEXT NOT NULL, symbol TEXT NOT NULL,
        amount TEXT NOT NULL, rate_scaled TEXT NOT NULL, idr_amount TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS idempotency (
        key TEXT PRIMARY KEY, request_hash TEXT NOT NULL, status_code INTEGER NOT NULL, body TEXT NOT NULL,
        created_at TEXT NOT NULL);
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

  balance(sub: string, asset: string): bigint {
    const row = this.db
      .prepare('SELECT amount FROM balances WHERE subaccount = ? AND asset = ?')
      .get(sub, asset) as { amount: string } | undefined;
    return row ? BigInt(row.amount) : 0n;
  }

  addBalance(sub: string, asset: string, delta: bigint) {
    const next = this.balance(sub, asset) + delta;
    if (next < 0n) throw new Error(`negative balance ${sub} ${asset}`);
    this.db
      .prepare(
        `INSERT INTO balances (subaccount, asset, amount) VALUES (?, ?, ?)
         ON CONFLICT (subaccount, asset) DO UPDATE SET amount = excluded.amount`,
      )
      .run(sub, asset, next.toString());
  }

  balances(sub: string): Record<string, string> {
    const rows = this.db.prepare('SELECT asset, amount FROM balances WHERE subaccount = ?').all(sub) as {
      asset: string;
      amount: string;
    }[];
    const out: Record<string, string> = { USDT: '0', USDC: '0', IDR: '0' };
    for (const r of rows) out[r.asset] = r.amount;
    return out;
  }

  /** Total number of filled orders per quote (used by invariant checks). */
  orderCount(): number {
    return (this.db.prepare('SELECT count(*) AS n FROM orders').get() as { n: number }).n;
  }
}
