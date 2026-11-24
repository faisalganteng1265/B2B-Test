import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { resetTestDb, deposits, backfillChunks, seed, type DbHandle } from '@mopay/db';
import { createLogger, depositWorkflowId } from '@mopay/shared';
import { Indexer, SimChain, type Dispatcher, type IndexerOptions, type SimChainOptions } from '../src';

const CHAIN = 84532;
const USDT = '0x00000000000000000000000000000000000000aa';
const CLIENT_WALLET = '0x00000000000000000000000000000000000000c1';
const ADDR_A = '0x000000000000000000000000000000000000a001';
const ADDR_B = '0x000000000000000000000000000000000000b002';
const log = createLogger('indexer-test', process.env.TEST_LOG ?? 'silent');

class FakeDispatcher implements Dispatcher {
  calls = new Map<string, number>();
  failing = false;
  async dispatch(workflowId: string) {
    if (this.failing) throw new Error('restate unavailable');
    const n = (this.calls.get(workflowId) ?? 0) + 1;
    this.calls.set(workflowId, n);
    return n === 1 ? ('accepted' as const) : ('duplicate' as const);
  }
}

let h: DbHandle;
let running: Indexer[] = [];

beforeEach(async () => {
  h = await resetTestDb();
  const addrs = [ADDR_A, ADDR_B];
  let i = 0;
  await seed(h.db, CHAIN, async () => addrs[i++]!);
});
afterEach(async () => {
  for (const x of running) await x.stop();
  running = [];
  await h.close();
});

function make(sim: SimChain, dispatcher: Dispatcher, over: Partial<IndexerOptions> = {}) {
  const idx = new Indexer(
    sim,
    h.db,
    dispatcher,
    {
      chainId: CHAIN,
      tokens: { [USDT]: 'USDT' },
      finality: { mode: 'distance', reorgSafeDistance: 12 },
      startBlock: 1,
      pollMs: 50,
      promoteIntervalMs: 100,
      housekeepingMs: 300,
      jumpThreshold: 100,
      chunkSize: 2000,
      concurrency: 4,
      leaseMs: 2000,
      sweeps: false,
      ...over,
    },
    log,
  );
  running.push(idx);
  return idx;
}

async function waitFor<T>(
  fn: () => Promise<T | undefined | null | false>,
  timeoutMs = 20_000,
  everyMs = 20,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

const depositByTx = (tx: string) => h.db.query.deposits.findFirst({ where: eq(deposits.txHash, tx) });
const allDeposits = () => h.db.select().from(deposits);

function newSim(opts: SimChainOptions = {}) {
  const sim = new SimChain(opts);
  sim.mine(5);
  return sim;
}

describe('live path', () => {
  it('detects a new deposit within 3s of being mined, then confirms and dispatches it exactly once', async () => {
    const sim = newSim();
    const disp = new FakeDispatcher();
    const idx = make(sim, disp);
    await idx.init();
    idx.start();
    await waitFor(async () => (await idx.store.getCheckpoint())!.liveHeadNumber === sim.head);

    const tx = sim.transfer(USDT, CLIENT_WALLET, ADDR_A, 1_000_000_000n);
    const minedAt = Date.now();
    sim.mine(1);
    const d = await waitFor(() => depositByTx(tx), 3000, 10);
    const latency = Date.now() - minedAt;
    expect(latency).toBeLessThan(3000);
    expect(d.status).toBe('seen');
    expect(d.amountBaseUnits).toBe(1_000_000_000n);

    sim.mine(11); // 11 blocks on top: not yet final at safe distance 12
    await new Promise((r) => setTimeout(r, 400));
    expect((await depositByTx(tx))!.status).toBe('seen');
    sim.mine(1);
    await waitFor(async () => (await depositByTx(tx))?.status === 'dispatched');
    expect(disp.calls.get(depositWorkflowId(CHAIN, tx, 0))).toBe(1);
  });

  it('ignores transfers to unknown addresses and other tokens', async () => {
    const sim = newSim();
    const idx = make(sim, new FakeDispatcher());
    await idx.init();
    idx.start();
    sim.transfer(USDT, CLIENT_WALLET, '0x000000000000000000000000000000000000dead', 5n);
    sim.transfer('0x00000000000000000000000000000000000000bb', CLIENT_WALLET, ADDR_A, 5n);
    sim.mine(3);
    await waitFor(async () => (await idx.store.getCheckpoint())!.liveHeadNumber === sim.head);
    expect(await allDeposits()).toHaveLength(0);
  });
});

describe('reorg safety', () => {
  it('orphans a deposit whose block is reorged away and never dispatches it', async () => {
    const sim = newSim();
    const disp = new FakeDispatcher();
    const idx = make(sim, disp);
    await idx.init();
    idx.start();

    const tx = sim.transfer(USDT, CLIENT_WALLET, ADDR_A, 7_000_000n);
    sim.mine(3);
    await waitFor(async () => (await depositByTx(tx))?.status === 'seen');
    await waitFor(async () => (await idx.store.getCheckpoint())!.liveHeadNumber === sim.head);

    sim.reorg(4, { extra: 2 }); // replace the block with the deposit; tx is dropped
    await waitFor(async () => (await depositByTx(tx))?.status === 'orphaned');
    const cp = (await idx.store.getCheckpoint())!;
    expect(cp.reorgsDetected).toBe(1);
    expect(cp.lastReorgDepth).toBeGreaterThanOrEqual(4);

    sim.mine(30);
    await waitFor(async () => (await idx.store.getCheckpoint())!.liveHeadNumber === sim.head);
    await new Promise((r) => setTimeout(r, 500));
    expect((await depositByTx(tx))!.status).toBe('orphaned');
    expect(disp.calls.size).toBe(0);
  });

  it('re-included transactions are processed once after becoming final on the new branch', async () => {
    const sim = newSim();
    const disp = new FakeDispatcher();
    const idx = make(sim, disp);
    await idx.init();
    idx.start();
    const tx = sim.transfer(USDT, CLIENT_WALLET, ADDR_A, 9n);
    sim.mine(2);
    await waitFor(async () => (await depositByTx(tx))?.status === 'seen');
    const before = (await depositByTx(tx))!.blockHash;
    sim.reorg(2, { reinclude: true });
    await waitFor(async () => {
      const d = await depositByTx(tx);
      return d?.status === 'seen' && d.blockHash !== before;
    });
    sim.mine(15);
    await waitFor(async () => (await depositByTx(tx))?.status === 'dispatched');
    expect([...disp.calls.values()]).toEqual([1]);
    expect(await allDeposits()).toHaveLength(1);
  });

  it('a reorg deeper than the safe distance (confirmed deposit) is flagged as an incident → manual_review, not dispatched', async () => {
    const sim = newSim();
    const disp = new FakeDispatcher();
    disp.failing = true; // keep it in `confirmed` (outbox) so we can observe the incident path
    const idx = make(sim, disp, { finality: { mode: 'distance', reorgSafeDistance: 2 } });
    await idx.init();
    idx.start();
    const tx = sim.transfer(USDT, CLIENT_WALLET, ADDR_A, 11n);
    sim.mine(4);
    await waitFor(async () => (await depositByTx(tx))?.status === 'confirmed');
    sim.reorg(6);
    const d = await waitFor(async () => {
      const x = await depositByTx(tx);
      return x?.status === 'manual_review' ? x : undefined;
    });
    expect(d.statusReason).toMatch(/INCIDENT/);
    disp.failing = false;
    sim.mine(10);
    await new Promise((r) => setTimeout(r, 500));
    expect((await depositByTx(tx))!.status).toBe('manual_review');
    expect(disp.calls.size).toBe(0);
  });
});

describe('catch-up after downtime', () => {
  it('backfills 50 missed deposits over 5000 blocks exactly once while new deposits are still detected fast', async () => {
    // Range-limited, slow-ish RPC so the backfill visibly takes time and must split ranges.
    const sim = newSim({ maxRange: 500, rangeLatencyMs: 250 });
    const disp = new FakeDispatcher();
    const first = make(sim, disp);
    await first.init();
    first.start();
    await waitFor(async () => (await first.store.getCheckpoint())!.liveHeadNumber === sim.head);
    await first.stop(); // indexer "down"

    const missed: string[] = [];
    for (let i = 0; i < 50; i++) {
      missed.push(sim.transfer(USDT, CLIENT_WALLET, i % 2 ? ADDR_A : ADDR_B, BigInt(1_000_000 * (i + 1))));
      sim.mine(80); // 50 * 80 = 4000 blocks
    }
    sim.mine(1000); // total ≈ 5000 blocks behind

    const second = make(sim, disp);
    await second.init();
    second.start();

    // Live jumps to the finalized boundary immediately...
    await waitFor(async () => (await second.store.getCheckpoint())!.liveHeadNumber >= sim.head - 12);
    // ...so a brand-new deposit is detected quickly although backfill is still running.
    const liveTx = sim.transfer(USDT, CLIENT_WALLET, ADDR_A, 123n);
    const t0 = Date.now();
    sim.mine(1);
    await waitFor(() => depositByTx(liveTx), 3000, 10);
    const liveLatency = Date.now() - t0;
    const progressAtDetection = await second.store.backfillProgress();
    expect(liveLatency).toBeLessThan(3000);
    expect(progressAtDetection.done).toBeLessThan(progressAtDetection.total);

    sim.mine(13);
    await waitFor(
      async () => (await allDeposits()).filter((d) => d.status === 'dispatched').length === 51,
      30_000,
      100,
    );

    const rows = await allDeposits();
    expect(rows).toHaveLength(51);
    expect(new Set(rows.map((r) => r.txHash))).toEqual(new Set([...missed, liveTx]));
    expect(rows.filter((r) => r.source === 'backfill')).toHaveLength(50);
    for (const n of disp.calls.values()) expect(n).toBe(1);
    expect(disp.calls.size).toBe(51);
    const p = await second.store.backfillProgress();
    expect(p.done).toBe(p.total);
    expect(sim.calls.rangeRejected).toBeGreaterThan(0); // adaptive split happened
  });

  it('a crashed backfill worker’s chunks are taken over after the lease expires; restart completes exactly once', async () => {
    const sim = newSim({ maxRange: 2000, rangeLatencyMs: 400 });
    const disp = new FakeDispatcher();
    const a = make(sim, disp, { concurrency: 2, leaseMs: 800, chunkSize: 500 });
    await a.init();
    const txs: string[] = [];
    for (let i = 0; i < 20; i++) {
      txs.push(sim.transfer(USDT, CLIENT_WALLET, ADDR_A, BigInt(i + 1)));
      sim.mine(250);
    }
    a.start();
    // wait until some chunks are done and some are still running/pending, then crash
    await waitFor(
      async () => {
        const p = await a.store.backfillProgress();
        return p.done >= 2 && p.done < p.total - 2;
      },
      20_000,
      20,
    );
    a.crash();
    const stuck = await h.db.select().from(backfillChunks).where(eq(backfillChunks.status, 'running'));
    expect(stuck.length).toBeGreaterThan(0); // leases still held by the dead worker

    const b = make(sim, disp, { concurrency: 4, leaseMs: 800, chunkSize: 500, workerId: 'restarted' });
    await b.init();
    b.start();
    sim.mine(13);
    await waitFor(
      async () => {
        const p = await b.store.backfillProgress();
        return p.total > 0 && p.done === p.total;
      },
      30_000,
      100,
    );
    await waitFor(
      async () => (await allDeposits()).filter((d) => d.status === 'dispatched').length === 20,
      20_000,
      100,
    );
    expect(await allDeposits()).toHaveLength(20);
    expect(disp.calls.size).toBe(20);
    const taken = await h.db.select().from(backfillChunks);
    expect(taken.some((c) => c.attempts > 1)).toBe(true); // at least one chunk was re-claimed
  });

  it('survives a flaky RPC (20% errors) during catch-up without losing or duplicating deposits', async () => {
    const sim = newSim({ maxRange: 1000 });
    const disp = new FakeDispatcher();
    const txs: string[] = [];
    for (let i = 0; i < 15; i++) {
      txs.push(sim.transfer(USDT, CLIENT_WALLET, ADDR_B, BigInt(i + 1)));
      sim.mine(200);
    }
    const idx = make(sim, disp);
    await idx.init();
    sim.opts.failRate = 0.2;
    idx.start();
    await waitFor(
      async () => (await allDeposits()).filter((d) => d.status === 'dispatched').length === 15,
      45_000,
      100,
    );
    expect(disp.calls.size).toBe(15);
    expect(sim.calls.failures).toBeGreaterThan(0);
  });
});

describe('sweeps (defense in depth)', () => {
  it('a final-range sweep confirms deposits even if the live path missed them', async () => {
    const sim = newSim();
    const disp = new FakeDispatcher();
    const idx = make(sim, disp, { sweeps: true, chunkSize: 50 });
    await idx.init();
    // simulate a live-path miss: a lagging RPC node silently returns no logs for the live
    // worker's small ranges (≤ liveBatch); the sweep's 50-block chunk hits a healthy node.
    const orig = sim.getTransferLogsByRange.bind(sim);
    sim.getTransferLogsByRange = async (from, to, tokens, addrs) =>
      to - from + 1 <= 25 ? [] : orig(from, to, tokens, addrs);
    idx.start();
    const tx = sim.transfer(USDT, CLIENT_WALLET, ADDR_A, 77n);
    sim.mine(80);
    await waitFor(async () => (await depositByTx(tx))?.status === 'dispatched', 20_000, 50);
    expect((await depositByTx(tx))!.source).toBe('backfill');
    sim.getTransferLogsByRange = orig;
  });
});
