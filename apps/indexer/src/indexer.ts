import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { backfillChunks, type Db } from '@mopay/db';
import { errMsg, sleep, type Logger } from '@mopay/shared';
import type { Dispatcher } from './dispatcher';
import { getFinalizedBoundary, type FinalityConfig } from './finality';
import { IndexerMetrics } from './metrics';
import { fetchLogsAdaptive, splitRange } from './ranges';
import { findCommonAncestor } from './reorg';
import { AddressBook, IndexerStore } from './store';
import type { BlockHeader, ChainSource, TransferLog } from './types';

export interface IndexerOptions {
  chainId: number;
  /** token address (lowercase) -> symbol */
  tokens: Record<string, string>;
  finality: FinalityConfig;
  /** first block to index (used only when there is no checkpoint yet) */
  startBlock: number;
  pollMs?: number;
  /** max blocks the live worker validates and ingests per step (fetched in parallel / JSON-RPC batch) */
  liveBatch?: number;
  /** if the live head is further behind than this, jump to the finalized boundary and backfill */
  jumpThreshold?: number;
  chunkSize?: number;
  concurrency?: number;
  leaseMs?: number;
  promoteIntervalMs?: number;
  housekeepingMs?: number;
  /** blocks of headers kept below the finalized boundary (reorg detection window) */
  pruneKeep?: number;
  /** enqueue final-range reconciliation sweeps behind the live worker */
  sweeps?: boolean;
  workerId?: string;
}

type LiveResult = 'advanced' | 'idle' | 'reorg' | 'jumped';

/**
 * Two independent paths over one durable store:
 *  - live: sequential, block-by-block near the head, parent-hash reorg detection
 *  - backfill: parallel chunk workers below the finalized boundary (SKIP LOCKED + leases)
 * plus the promoter (seen -> confirmed once final) and the outbox dispatcher (confirmed -> Restate).
 */
export class Indexer {
  readonly store: IndexerStore;
  readonly addresses: AddressBook;
  readonly metrics: IndexerMetrics;
  readonly o: Required<IndexerOptions>;
  private readonly tokenList: string[];
  private stopping = false;
  /** set only by crash(): in-flight work is abandoned like a killed process */
  private dead = false;
  private loops: Promise<void>[] = [];
  private wakers = new Set<() => void>();
  /** live-path leadership (advisory lock); backfill runs regardless */
  isLeader: () => boolean = () => true;

  constructor(
    private readonly src: ChainSource,
    private readonly db: Db,
    private readonly dispatcher: Dispatcher,
    opts: IndexerOptions,
    private readonly log: Logger,
  ) {
    this.o = {
      pollMs: 1000,
      liveBatch: 25,
      jumpThreshold: 100,
      chunkSize: 2000,
      concurrency: 4,
      leaseMs: 30_000,
      promoteIntervalMs: 1000,
      housekeepingMs: 5000,
      pruneKeep: opts.finality.reorgSafeDistance * 2,
      sweeps: true,
      workerId: `idx-${process.pid}-${randomUUID().slice(0, 8)}`,
      ...opts,
    };
    this.tokenList = Object.keys(opts.tokens);
    this.store = new IndexerStore(db, opts.chainId, opts.tokens);
    this.addresses = new AddressBook(db, opts.chainId);
    this.metrics = new IndexerMetrics(this.store);
    this.src = this.instrument(src);
  }

  /** Count RPC errors per method without changing behaviour. */
  private instrument(src: ChainSource): ChainSource {
    const m = this.metrics;
    return new Proxy(src, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (typeof v !== 'function') return v;
        return async (...args: unknown[]) => {
          try {
            return await v.apply(target, args);
          } catch (e) {
            m.rpcErrors.inc({ method: String(prop) });
            throw e;
          }
        };
      },
    });
  }

  async init() {
    await this.addresses.refresh();
    if (!(await this.store.getCheckpoint())) {
      const anchor = await this.mustGetBlock(Math.max(0, this.o.startBlock - 1));
      await this.store.initCheckpoint(anchor);
      this.log.info({ anchor: anchor.number }, 'checkpoint initialised');
    }
  }

  start() {
    this.stopping = false;
    this.loops = [
      this.loop('live', () => this.liveStep(), true),
      this.loop('promoter', async () => (await this.promoteOnce(), 'idle'), true, this.o.promoteIntervalMs),
      this.loop(
        'dispatcher',
        async () => ((await this.dispatchOnce()) > 0 ? 'advanced' : 'idle'),
        true,
        this.o.promoteIntervalMs,
      ),
      this.loop('housekeeping', async () => (await this.housekeeping(), 'idle'), true, this.o.housekeepingMs),
      ...Array.from({ length: this.o.concurrency }, (_, i) =>
        this.loop(
          `backfill-${i}`,
          async () => ((await this.backfillOnce(`${this.o.workerId}-${i}`)) ? 'advanced' : 'idle'),
          false,
          this.o.pollMs,
        ),
      ),
    ];
  }

  /** Graceful stop: finish the in-flight step of every loop, then hand back leases. */
  async stop() {
    this.stopping = true;
    for (const w of this.wakers) w();
    await Promise.allSettled(this.loops);
    for (let i = 0; i < this.o.concurrency; i++) await this.store.releaseChunks(`${this.o.workerId}-${i}`);
  }

  /** Test hook: simulate a crash (stop loops WITHOUT releasing leases or finishing cleanly). */
  crash() {
    this.dead = true;
    this.stopping = true;
    for (const w of this.wakers) w();
  }

  private async loop(
    name: string,
    step: () => Promise<LiveResult | 'idle'>,
    leaderOnly: boolean,
    idleMs = this.o.pollMs,
  ) {
    let failures = 0;
    while (!this.stopping) {
      if (leaderOnly && !this.isLeader()) {
        await this.nap(idleMs);
        continue;
      }
      try {
        const r = await step();
        failures = 0;
        if (r === 'idle') await this.nap(idleMs);
      } catch (e) {
        failures++;
        const backoff = Math.min(10_000, 200 * 2 ** Math.min(failures, 6)) + Math.floor(Math.random() * 200);
        this.log.warn(
          { loop: name, err: errMsg(e), failures, backoffMs: backoff },
          'loop step failed, retrying',
        );
        await this.nap(backoff);
      }
    }
  }

  private nap(ms: number) {
    if (this.stopping) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.wakers.delete(done);
        resolve();
      };
      const t = setTimeout(done, ms);
      this.wakers.add(done);
    });
  }

  private async mustGetBlock(n: number): Promise<BlockHeader> {
    const b = await this.src.getBlock(n);
    if (!b) throw new Error(`block ${n} not available`);
    return b;
  }

  private withClients(logs: TransferLog[]) {
    return logs.flatMap((log) => {
      const a = this.addresses.get(log.to);
      return a ? [{ log, clientId: a.clientId }] : [];
    });
  }

  // ------------------------------------------------------------------ live path

  async liveStep(): Promise<LiveResult> {
    const cp = await this.store.getCheckpoint();
    if (!cp) throw new Error('no checkpoint; call init()');
    const head = await this.src.getHeadNumber();
    this.metrics.chainHead.set(head);
    this.metrics.liveHead.set(cp.liveHeadNumber);
    this.metrics.headLag.set(Math.max(0, head - cp.liveHeadNumber));

    if (head - cp.liveHeadNumber > this.o.jumpThreshold) {
      // Before trusting our old head, make sure it was not reorged away while we were down.
      const remote = await this.src.getBlock(cp.liveHeadNumber);
      if (!remote || remote.hash !== cp.liveHeadHash) {
        await this.handleReorg(cp.liveHeadNumber);
        return 'reorg';
      }
      const boundary = await getFinalizedBoundary(this.src, this.o.finality, head);
      if (boundary > cp.liveHeadNumber) {
        const anchor = await this.mustGetBlock(boundary);
        const chunks = splitRange(cp.liveHeadNumber + 1, boundary, this.o.chunkSize);
        await this.store.jumpAndPlanBackfill(anchor, cp.liveHeadNumber, chunks);
        this.log.info(
          { from: cp.liveHeadNumber, to: boundary, head, chunks: chunks.length },
          'catch-up: live jumped to finalized boundary, gap queued for backfill',
        );
        return 'jumped';
      }
    }

    if (cp.liveHeadNumber >= head) return 'idle';
    const from = cp.liveHeadNumber + 1;
    const to = Math.min(head, cp.liveHeadNumber + this.o.liveBatch);
    const fetched = await Promise.all(
      Array.from({ length: to - from + 1 }, (_, i) => this.src.getBlock(from + i)),
    );

    // Keep the longest prefix that forms a parent-hash chain starting at our checkpoint.
    const blocks: BlockHeader[] = [];
    let prevHash = cp.liveHeadHash;
    for (const b of fetched) {
      if (!b || b.parentHash !== prevHash) break;
      blocks.push(b);
      prevHash = b.hash;
    }
    if (!blocks.length) {
      if (fetched[0] && fetched[0].parentHash !== cp.liveHeadHash) {
        await this.handleReorg(cp.liveHeadNumber);
        return 'reorg';
      }
      return 'idle'; // first block not available yet
    }
    // A break inside the batch means the chain moved while we fetched; the next step re-validates.

    // One range getLogs over the validated prefix, then require every log to carry the hash of the
    // header we validated at its height. Any mismatch means the chain moved between the two
    // requests: discard the batch and retry. (Per-block getLogs-by-blockHash is ~10x slower on
    // public RPCs and cannot keep up with Base's ~5 blocks/s.) A lagging RPC node that silently
    // returns fewer logs is covered by the final-range sweep, so a deposit is delayed, never lost.
    const first = blocks[0]!;
    const lastB = blocks[blocks.length - 1]!;
    const rangeLogs = await fetchLogsAdaptive(
      this.src,
      first.number,
      lastB.number,
      this.tokenList,
      this.addresses.list(),
      () => this.metrics.rangeSplits.inc(),
    );
    const hashAt = new Map(blocks.map((b) => [b.number, b.hash]));
    const inconsistent = rangeLogs.find((l) => hashAt.get(l.blockNumber) !== l.blockHash);
    if (inconsistent) {
      this.log.warn(
        { block: inconsistent.blockNumber },
        'live: log/header hash mismatch (chain moved mid-fetch); retrying batch',
      );
      return 'advanced';
    }
    const logs = this.withClients(rangeLogs);
    const inserted = await this.store.ingestLiveBatch(blocks, logs, cp.liveHeadNumber, head);
    const last = blocks[blocks.length - 1]!;
    if (inserted) {
      this.metrics.depositsDetected.inc({ source: 'live' }, inserted);
      this.log.info({ from, to: last.number, deposits: inserted }, 'live: deposits seen');
    }
    this.metrics.liveHead.set(last.number);
    this.metrics.headLag.set(Math.max(0, head - last.number));
    return last.number < head ? 'advanced' : 'idle';
  }

  /** Walk back from `fromNumber` to the common ancestor and roll back everything above it. */
  private async handleReorg(fromNumber: number) {
    // Every stored canonical header is a candidate (the unfinal window can be hundreds of blocks).
    const window = await this.store.canonicalWindowDesc(fromNumber, 20_000);
    let ancestorNumber: number | null = null;
    const remote = new Map<number, string>();
    // Fetch remote hashes in small parallel batches, then run the pure ancestor search.
    for (let i = 0; i < window.length && ancestorNumber === null; i += 32) {
      const batch = window.slice(i, i + 32);
      const headers = await Promise.all(batch.map((b) => this.src.getBlock(b.number)));
      headers.forEach((h) => h && remote.set(h.number, h.hash));
      ancestorNumber = findCommonAncestor(batch, (n) => remote.get(n));
    }
    if (ancestorNumber === null) {
      this.metrics.reorgIncidents.inc();
      throw new Error(
        `REORG_TOO_DEEP: no common ancestor within ${window.length} stored blocks below ${fromNumber}; manual intervention required`,
      );
    }
    const ancestor = await this.mustGetBlock(ancestorNumber);
    const out = await this.store.rollbackTo(ancestor, fromNumber);
    this.metrics.reorgs.inc();
    this.metrics.reorgDepth.set(out.depth);
    const level = out.incidents.length ? 'error' : 'warn';
    this.log[level](
      { ...out, incidents: out.incidents.length },
      out.incidents.length
        ? 'REORG INCIDENT: confirmed deposits were reorged'
        : 'reorg detected and rolled back',
    );
    if (out.incidents.length) this.metrics.reorgIncidents.inc(out.incidents.length);
  }

  // ------------------------------------------------------------------ promoter / outbox

  /** seen → confirmed once the block is final AND still canonical (checked against DB and RPC). */
  async promoteOnce(): Promise<number> {
    const head = await this.src.getHeadNumber();
    const boundary = await getFinalizedBoundary(this.src, this.o.finality, head);
    this.metrics.finalizedBoundary.set(boundary);
    await this.store.updateConfirmations(head);
    const rows = await this.store.seenUpTo(boundary);
    if (!rows.length) return 0;
    const heights = [...new Set(rows.map((r) => r.blockNumber))];
    const remote = new Map<number, string | undefined>();
    await Promise.all(heights.map(async (h) => remote.set(h, (await this.src.getBlock(h))?.hash)));
    let promoted = 0;
    for (const d of rows) {
      const canonical = remote.get(d.blockNumber);
      if (canonical === undefined) continue;
      if (canonical !== d.blockHash) {
        await this.store.orphanSeen(d.id, `REORG: block ${d.blockNumber} hash changed before finality`);
        this.log.warn(
          { correlationId: d.id, block: d.blockNumber },
          'promoter: deposit block no longer canonical; orphaned',
        );
        continue;
      }
      if (await this.store.promote(d.id, d.blockHash)) {
        promoted++;
        this.log.info({ correlationId: d.id, block: d.blockNumber }, 'deposit confirmed (final)');
      }
    }
    return promoted;
  }

  /** Transactional outbox: every `confirmed` deposit is dispatched until it succeeds. */
  async dispatchOnce(): Promise<number> {
    const rows = await this.store.outbox();
    let n = 0;
    await Promise.all(
      rows.map(async (r) => {
        try {
          const res = await this.dispatcher.dispatch(r.workflowId, r.id);
          await this.store.markDispatched(r.id);
          this.metrics.dispatches.inc({ result: res });
          this.log.info({ correlationId: r.id, workflowId: r.workflowId, res }, 'dispatched to restate');
          n++;
        } catch (e) {
          this.metrics.dispatches.inc({ result: 'error' });
          await this.store.markDispatchFailed(r.id, errMsg(e));
          this.log.warn(
            { correlationId: r.id, err: errMsg(e), attempts: r.attempts + 1 },
            'dispatch failed; will retry',
          );
        }
      }),
    );
    if (rows.length && n === 0) throw new Error('all dispatches failed'); // trigger loop backoff
    return n;
  }

  // ------------------------------------------------------------------ backfill

  async backfillOnce(workerId: string): Promise<boolean> {
    const chunk = await this.store.claimChunk(workerId, this.o.leaseMs);
    if (!chunk) return false;
    const heartbeat = setInterval(
      () => !this.dead && void this.store.extendLease(chunk.id, workerId, this.o.leaseMs).catch(() => {}),
      this.o.leaseMs / 3,
    );
    try {
      const logs = await fetchLogsAdaptive(
        this.src,
        chunk.from,
        chunk.to,
        this.tokenList,
        this.addresses.list(),
        () => this.metrics.rangeSplits.inc(),
      );
      if (this.dead) return false; // simulated kill: the result is never written, lease stays held
      const matched = this.withClients(logs);
      const n = await this.store.upsertFinal(matched);
      if (n) this.metrics.depositsDetected.inc({ source: 'backfill' }, n);
      await this.store.completeChunk(chunk.id, workerId, matched.length);
      this.log.info(
        { chunk: chunk.id, from: chunk.from, to: chunk.to, found: matched.length, newOrConfirmed: n },
        'backfill chunk done',
      );
      return true;
    } catch (e) {
      const backoff = Math.min(30_000, 1000 * 2 ** Math.min(chunk.attempts, 5));
      await this.store.failChunk(chunk.id, workerId, errMsg(e), backoff);
      this.log.warn(
        { chunk: chunk.id, err: errMsg(e), attempts: chunk.attempts, backoffMs: backoff },
        'backfill chunk failed',
      );
      return true;
    } finally {
      clearInterval(heartbeat);
    }
  }

  // ------------------------------------------------------------------ housekeeping

  async housekeeping() {
    await this.addresses.refresh();
    const head = await this.src.getHeadNumber();
    const boundary = await getFinalizedBoundary(this.src, this.o.finality, head);
    if (this.o.sweeps) await this.enqueueSweeps(boundary);
    await this.store.updateFinalizedCursor(boundary, head);
    await this.store.pruneBlocks(boundary, this.o.pruneKeep);
  }

  /**
   * Defense in depth: once a full chunk behind the live worker is final, re-scan it with a range
   * getLogs. Catches anything the live path could have missed (e.g. a lagging RPC node behind a
   * load balancer). Idempotent through the same unique key.
   */
  private async enqueueSweeps(boundary: number) {
    const [r] = await this.db
      .select({ max: sql<number | null>`max(to_block)` })
      .from(backfillChunks)
      .where(sql`chain_id = ${this.o.chainId}`);
    let next = r?.max === null || r?.max === undefined ? this.o.startBlock : Number(r.max) + 1;
    const rows: { chainId: number; fromBlock: number; toBlock: number }[] = [];
    while (next + this.o.chunkSize - 1 <= boundary && rows.length < 100) {
      rows.push({ chainId: this.o.chainId, fromBlock: next, toBlock: next + this.o.chunkSize - 1 });
      next += this.o.chunkSize;
    }
    if (rows.length) await this.db.insert(backfillChunks).values(rows).onConflictDoNothing();
  }

  async status() {
    const cp = await this.store.getCheckpoint();
    const progress = await this.store.backfillProgress();
    return { checkpoint: cp, backfill: progress, deposits: await this.store.depositCountsByStatus() };
  }
}

export { sleep };
