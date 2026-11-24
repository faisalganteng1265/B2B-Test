import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import { deposits, resetTestDb, seed, type DbHandle } from '@mopay/db';
import { createLogger } from '@mopay/shared';
import { Indexer, SimChain, type Dispatcher, type IndexerOptions } from '@mopay/indexer';
import { c } from './common';

export const SIM_DB = process.env.SIM_DATABASE_URL ?? 'postgres://postgres@localhost:5432/mopay_sim';
export const USDT = '0x00000000000000000000000000000000000000aa';
export const ADDR = {
  A: '0x000000000000000000000000000000000000a001',
  B: '0x000000000000000000000000000000000000b002',
};
export const WALLET = '0x00000000000000000000000000000000000000c1';

export class LoggingDispatcher implements Dispatcher {
  calls = new Map<string, number>();
  async dispatch(workflowId: string) {
    const n = (this.calls.get(workflowId) ?? 0) + 1;
    this.calls.set(workflowId, n);
    console.log(
      `    ${c.cyan('→ dispatch')} offramp workflow ${c.dim(workflowId.slice(0, 30))}…  (${n === 1 ? 'accepted' : 'duplicate, ignored by Restate'})`,
    );
    return n === 1 ? ('accepted' as const) : ('duplicate' as const);
  }
}

/** Fresh isolated database (mopay_sim) — never touches the live demo DB. */
export async function simDb(): Promise<DbHandle> {
  const admin = postgres(SIM_DB.replace(/\/[^/]+$/, '/postgres'), { max: 1, onnotice: () => {} });
  const name = SIM_DB.split('/').pop()!;
  const exists = await admin`select 1 from pg_database where datname = ${name}`;
  if (!exists.length) await admin.unsafe(`create database "${name}"`);
  await admin.end();
  const h = await resetTestDb(SIM_DB);
  const addrs = [ADDR.A, ADDR.B];
  let i = 0;
  await seed(h.db, 84532, async () => addrs[i++]!);
  return h;
}

export function simIndexer(sim: SimChain, h: DbHandle, d: Dispatcher, over: Partial<IndexerOptions> = {}) {
  return new Indexer(
    sim,
    h.db,
    d,
    {
      chainId: 84532,
      tokens: { [USDT]: 'USDT' },
      finality: { mode: 'distance', reorgSafeDistance: 12 },
      startBlock: 1,
      pollMs: 100,
      promoteIntervalMs: 200,
      housekeepingMs: 500,
      jumpThreshold: 100,
      sweeps: false,
      ...over,
    },
    createLogger('sim-indexer', process.env.LOG_LEVEL ?? 'silent'),
  );
}

export const byTx = (h: DbHandle, tx: string) =>
  h.db.query.deposits.findFirst({ where: eq(deposits.txHash, tx) });
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until<T>(
  fn: () => Promise<T | undefined | null | false>,
  timeoutMs = 30_000,
): Promise<T> {
  const t = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t > timeoutMs) throw new Error('timeout');
    await sleep(50);
  }
}
