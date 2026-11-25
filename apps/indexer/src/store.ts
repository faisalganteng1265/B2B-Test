import { and, asc, desc, eq, gt, inArray, lt, lte, sql } from 'drizzle-orm';
import {
  auditLog,
  backfillChunks,
  chainBlocks,
  clientWallets,
  depositAddresses,
  deposits,
  indexerCheckpoints,
  type Db,
  type Tx,
} from '@mopay/db';
import { depositWorkflowId } from '@mopay/shared';
import type { BlockHeader, TransferLog } from './types';

export interface AddressInfo {
  clientId: string | null;
}

export const UNATTRIBUTED_REASON = (from: string) =>
  `UNATTRIBUTED: sender ${from} is not a registered client wallet; assign the deposit to a client to process it`;

/** Deposit address → client, refreshed periodically (new addresses can be created via the API). */
/**
 * Which deposits we watch and who they belong to.
 *  - `client` address (one per client, e.g. Mobee sub-accounts): the destination identifies the client.
 *  - `shared` address (Indodax: one per exchange account): the SENDER identifies the client, via the
 *    wallets each client registered (KYB). Unknown sender → clientId null (never processed until assigned).
 */
export class AddressBook {
  private addresses = new Map<string, { kind: 'client' | 'shared'; clientId: string | null }>();
  private wallets = new Map<string, string>();
  constructor(
    private readonly db: Db,
    private readonly chainId: number,
  ) {}
  async refresh() {
    const rows = await this.db
      .select({
        address: depositAddresses.address,
        clientId: depositAddresses.clientId,
        kind: depositAddresses.kind,
      })
      .from(depositAddresses)
      .where(eq(depositAddresses.chainId, this.chainId));
    this.addresses = new Map(
      rows.map((r) => [
        r.address.toLowerCase(),
        { kind: r.kind === 'shared' ? 'shared' : 'client', clientId: r.clientId },
      ]),
    );
    const ws = await this.db
      .select({ address: clientWallets.address, clientId: clientWallets.clientId })
      .from(clientWallets)
      .where(eq(clientWallets.chainId, this.chainId));
    this.wallets = new Map(ws.map((w) => [w.address.toLowerCase(), w.clientId]));
  }
  /** undefined = not a deposit to us; { clientId: null } = ours but sender unknown. */
  attribute(to: string, from: string): AddressInfo | undefined {
    const a = this.addresses.get(to.toLowerCase());
    if (!a) return undefined;
    if (a.kind === 'client') return { clientId: a.clientId };
    return { clientId: this.wallets.get(from.toLowerCase()) ?? null };
  }
  list() {
    return [...this.addresses.keys()];
  }
}

export type Checkpoint = typeof indexerCheckpoints.$inferSelect;

export interface ReorgOutcome {
  ancestor: number;
  depth: number;
  orphanedBlocks: number;
  orphanedDeposits: number;
  incidents: { id: string; status: string }[];
}

export class IndexerStore {
  constructor(
    readonly db: Db,
    readonly chainId: number,
    private readonly tokenSymbols: Record<string, string>,
  ) {}

  async getCheckpoint(): Promise<Checkpoint | undefined> {
    return this.db.query.indexerCheckpoints.findFirst({
      where: eq(indexerCheckpoints.chainId, this.chainId),
    });
  }

  /** Initialise the checkpoint at an anchor block (the block BEFORE the first block to index). */
  async initCheckpoint(anchor: BlockHeader) {
    await this.db.transaction(async (tx) => {
      await tx.insert(chainBlocks).values(this.blockRow(anchor)).onConflictDoNothing();
      await tx
        .insert(indexerCheckpoints)
        .values({
          chainId: this.chainId,
          liveHeadNumber: anchor.number,
          liveHeadHash: anchor.hash,
          finalizedCursor: anchor.number,
        })
        .onConflictDoNothing();
    });
  }

  async canonicalBlock(number: number, tx: Db | Tx = this.db) {
    return tx.query.chainBlocks.findFirst({
      where: and(
        eq(chainBlocks.chainId, this.chainId),
        eq(chainBlocks.number, number),
        eq(chainBlocks.status, 'canonical'),
      ),
    });
  }

  /** Our canonical headers at or below `from`, highest first. */
  async canonicalWindowDesc(from: number, limit: number) {
    return this.db
      .select({ number: chainBlocks.number, hash: chainBlocks.hash })
      .from(chainBlocks)
      .where(
        and(
          eq(chainBlocks.chainId, this.chainId),
          eq(chainBlocks.status, 'canonical'),
          lte(chainBlocks.number, from),
        ),
      )
      .orderBy(desc(chainBlocks.number))
      .limit(limit);
  }

  private blockRow(b: BlockHeader) {
    return {
      chainId: this.chainId,
      number: b.number,
      hash: b.hash,
      parentHash: b.parentHash,
      timestamp: b.timestamp,
    };
  }

  private depositRow(
    l: TransferLog,
    clientId: string | null,
    source: 'live' | 'backfill',
    status: 'seen' | 'confirmed',
  ) {
    return {
      chainId: this.chainId,
      tokenAddress: l.token,
      tokenSymbol: this.tokenSymbols[l.token] ?? 'UNKNOWN',
      txHash: l.txHash,
      logIndex: l.logIndex,
      blockNumber: l.blockNumber,
      blockHash: l.blockHash,
      fromAddress: l.from,
      toAddress: l.to,
      amountBaseUnits: l.value,
      clientId,
      status,
      source,
      workflowId: depositWorkflowId(this.chainId, l.txHash, l.logIndex),
      confirmedAt: status === 'confirmed' ? new Date() : null,
    };
  }

  /**
   * Live path: atomically record a contiguous batch of blocks, their deposits (status `seen`) and
   * advance the live head.
   * `expectedPrev` guards against a concurrent writer (optimistic concurrency on the checkpoint).
   */
  async ingestLiveBatch(
    blocks: BlockHeader[],
    logs: { log: TransferLog; clientId: string | null }[],
    expectedPrev: number,
    head: number,
  ) {
    const last = blocks[blocks.length - 1];
    if (!last) return 0;
    return this.db.transaction(async (tx) => {
      const upd = await tx
        .update(indexerCheckpoints)
        .set({ liveHeadNumber: last.number, liveHeadHash: last.hash, chainHead: head, updatedAt: new Date() })
        .where(
          and(
            eq(indexerCheckpoints.chainId, this.chainId),
            eq(indexerCheckpoints.liveHeadNumber, expectedPrev),
          ),
        )
        .returning({ n: indexerCheckpoints.liveHeadNumber });
      if (upd.length === 0) throw new Error(`checkpoint moved concurrently (expected ${expectedPrev})`);
      await tx
        .insert(chainBlocks)
        .values(blocks.map((b) => this.blockRow(b)))
        .onConflictDoNothing();
      let inserted = 0;
      for (const { log, clientId } of logs) {
        inserted += await this.upsertSeen(tx, log, clientId);
      }
      return inserted;
    });
  }

  /** Insert a live-observed deposit, or resurrect an orphaned one re-included in a new block. */
  private async upsertSeen(tx: Tx, log: TransferLog, clientId: string | null): Promise<number> {
    const ins = await tx
      .insert(deposits)
      .values(this.depositRow(log, clientId, 'live', 'seen'))
      .onConflictDoNothing()
      .returning({ id: deposits.id });
    if (ins.length) return 1;
    const res = await tx
      .update(deposits)
      .set({
        status: 'seen',
        blockHash: log.blockHash,
        blockNumber: log.blockNumber,
        statusReason: 'REINCLUDED_AFTER_REORG',
      })
      .where(
        and(
          eq(deposits.chainId, this.chainId),
          eq(deposits.txHash, log.txHash),
          eq(deposits.logIndex, log.logIndex),
          eq(deposits.status, 'orphaned'),
        ),
      )
      .returning({ id: deposits.id });
    return res.length;
  }

  /**
   * Backfill path: logs from a FINAL range go straight to `confirmed` (the outbox).
   * Existing rows: seen → confirmed (with the canonical block info), orphaned → seen → confirmed.
   */
  async upsertFinal(logs: { log: TransferLog; clientId: string | null }[]): Promise<number> {
    if (!logs.length) return 0;
    return this.db.transaction(async (tx) => {
      let n = 0;
      for (const { log, clientId } of logs) {
        if (clientId === null) {
          // Final but unattributed: record for an operator, never confirm (DB CHECK enforces this too).
          const ins = await tx
            .insert(deposits)
            .values({
              ...this.depositRow(log, null, 'backfill', 'seen'),
              status: 'manual_review',
              statusReason: UNATTRIBUTED_REASON(log.from),
            })
            .onConflictDoNothing()
            .returning({ id: deposits.id });
          if (!ins.length) {
            await tx
              .update(deposits)
              .set({
                status: 'manual_review',
                statusReason: UNATTRIBUTED_REASON(log.from),
                blockHash: log.blockHash,
                blockNumber: log.blockNumber,
              })
              .where(
                and(
                  eq(deposits.chainId, this.chainId),
                  eq(deposits.txHash, log.txHash),
                  eq(deposits.logIndex, log.logIndex),
                  eq(deposits.status, 'seen'),
                ),
              );
          }
          n++;
          continue;
        }
        const ins = await tx
          .insert(deposits)
          .values(this.depositRow(log, clientId, 'backfill', 'confirmed'))
          .onConflictDoNothing()
          .returning({ id: deposits.id });
        if (ins.length) {
          n++;
          continue;
        }
        const key = and(
          eq(deposits.chainId, this.chainId),
          eq(deposits.txHash, log.txHash),
          eq(deposits.logIndex, log.logIndex),
        );
        const existing = await tx.query.deposits.findFirst({ where: key });
        if (!existing) continue;
        if (existing.status === 'orphaned') {
          await tx
            .update(deposits)
            .set({ status: 'seen', statusReason: 'REINCLUDED_AFTER_REORG' })
            .where(key);
        }
        if ((existing.status === 'orphaned' || existing.status === 'seen') && existing.clientId) {
          await tx
            .update(deposits)
            .set({
              status: 'confirmed',
              blockHash: log.blockHash,
              blockNumber: log.blockNumber,
              confirmedAt: new Date(),
            })
            .where(key);
          n++;
        }
      }
      return n;
    });
  }

  /**
   * Reorg rollback: everything above `ancestor` is orphaned, in ONE transaction.
   * Deposits there that were only `seen` become `orphaned`. Anything already confirmed/dispatched
   * is an INCIDENT (should be impossible with a correct safe distance) → manual_review.
   */
  async rollbackTo(ancestor: BlockHeader, previousHead: number): Promise<ReorgOutcome> {
    return this.db.transaction(async (tx) => {
      const orphaned = await tx
        .update(chainBlocks)
        .set({ status: 'orphaned' })
        .where(
          and(
            eq(chainBlocks.chainId, this.chainId),
            gt(chainBlocks.number, ancestor.number),
            eq(chainBlocks.status, 'canonical'),
          ),
        )
        .returning({ hash: chainBlocks.hash });
      const hashes = orphaned.map((b) => b.hash);
      let orphanedDeposits = 0;
      let incidents: { id: string; status: string }[] = [];
      if (hashes.length) {
        const inOrphan = and(eq(deposits.chainId, this.chainId), inArray(deposits.blockHash, hashes));
        const o = await tx
          .update(deposits)
          .set({ status: 'orphaned', statusReason: `REORG: block replaced (ancestor ${ancestor.number})` })
          .where(and(inOrphan, eq(deposits.status, 'seen')))
          .returning({ id: deposits.id });
        orphanedDeposits = o.length;
        incidents = await tx
          .update(deposits)
          .set({ status: 'manual_review', statusReason: 'INCIDENT: reorg after confirmation' })
          .where(and(inOrphan, inArray(deposits.status, ['confirmed', 'dispatched'])))
          .returning({ id: deposits.id, status: deposits.status });
        for (const i of incidents) {
          await tx.insert(auditLog).values({
            actor: 'indexer',
            action: 'reorg_incident',
            entity: 'deposit',
            entityId: i.id,
            data: { ancestor: ancestor.number },
          });
        }
      }
      const depth = previousHead - ancestor.number;
      await tx
        .update(indexerCheckpoints)
        .set({
          liveHeadNumber: ancestor.number,
          liveHeadHash: ancestor.hash,
          reorgsDetected: sql`${indexerCheckpoints.reorgsDetected} + 1`,
          lastReorgDepth: depth,
          updatedAt: new Date(),
        })
        .where(eq(indexerCheckpoints.chainId, this.chainId));
      await tx.insert(auditLog).values({
        actor: 'indexer',
        action: 'reorg',
        entity: 'chain',
        entityId: String(this.chainId),
        data: {
          ancestor: ancestor.number,
          depth,
          orphanedBlocks: hashes.length,
          orphanedDeposits,
          incidents: incidents.length,
        },
      });
      return { ancestor: ancestor.number, depth, orphanedBlocks: hashes.length, orphanedDeposits, incidents };
    });
  }

  /**
   * Catch-up: move the live head to `anchor` (the finalized boundary) and enqueue the gap
   * (liveHead, anchor.number] as backfill chunks — all in one transaction.
   */
  async jumpAndPlanBackfill(anchor: BlockHeader, fromLive: number, chunks: [number, number][]) {
    await this.db.transaction(async (tx) => {
      const upd = await tx
        .update(indexerCheckpoints)
        .set({ liveHeadNumber: anchor.number, liveHeadHash: anchor.hash, updatedAt: new Date() })
        .where(
          and(eq(indexerCheckpoints.chainId, this.chainId), eq(indexerCheckpoints.liveHeadNumber, fromLive)),
        )
        .returning({ n: indexerCheckpoints.liveHeadNumber });
      if (!upd.length) throw new Error('checkpoint moved concurrently during jump');
      await tx.insert(chainBlocks).values(this.blockRow(anchor)).onConflictDoNothing();
      if (chunks.length) {
        await tx
          .insert(backfillChunks)
          .values(chunks.map(([fromBlock, toBlock]) => ({ chainId: this.chainId, fromBlock, toBlock })))
          .onConflictDoNothing();
      }
      await tx.insert(auditLog).values({
        actor: 'indexer',
        action: 'catchup_jump',
        entity: 'chain',
        entityId: String(this.chainId),
        data: { from: fromLive, to: anchor.number, chunks: chunks.length },
      });
    });
  }

  /** Claim the lowest available chunk (pending, or running with an expired lease). */
  async claimChunk(workerId: string, leaseMs: number) {
    const rows = await this.db.execute<{
      id: number;
      from_block: number;
      to_block: number;
      attempts: number;
    }>(sql`
      UPDATE backfill_chunks SET status = 'running', locked_by = ${workerId},
        locked_until = now() + (${leaseMs} || ' milliseconds')::interval, attempts = attempts + 1, updated_at = now()
      WHERE id = (
        SELECT id FROM backfill_chunks
        WHERE chain_id = ${this.chainId}
          AND (status = 'pending' OR (status IN ('running', 'failed') AND (locked_until IS NULL OR locked_until < now())))
        ORDER BY from_block
        FOR UPDATE SKIP LOCKED
        LIMIT 1)
      RETURNING id, from_block::int8 AS from_block, to_block::int8 AS to_block, attempts`);
    const r = rows[0];
    return r
      ? { id: Number(r.id), from: Number(r.from_block), to: Number(r.to_block), attempts: Number(r.attempts) }
      : null;
  }

  async extendLease(id: number, workerId: string, leaseMs: number) {
    await this.db
      .update(backfillChunks)
      .set({ lockedUntil: sql`now() + (${leaseMs} || ' milliseconds')::interval` })
      .where(and(eq(backfillChunks.id, id), eq(backfillChunks.lockedBy, workerId)));
  }

  async completeChunk(id: number, workerId: string, logsFound: number) {
    await this.db
      .update(backfillChunks)
      .set({
        status: 'done',
        lockedBy: null,
        lockedUntil: null,
        logsFound,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(and(eq(backfillChunks.id, id), eq(backfillChunks.lockedBy, workerId)));
  }

  /** Failed attempt: keep it claimable again after a backoff (lease used as the backoff timer). */
  async failChunk(id: number, workerId: string, error: string, backoffMs: number) {
    await this.db
      .update(backfillChunks)
      .set({
        status: 'failed',
        lastError: error.slice(0, 500),
        lockedBy: null,
        lockedUntil: sql`now() + (${backoffMs} || ' milliseconds')::interval`,
        updatedAt: new Date(),
      })
      .where(and(eq(backfillChunks.id, id), eq(backfillChunks.lockedBy, workerId)));
  }

  /** Graceful shutdown: hand chunks back immediately. */
  async releaseChunks(workerId: string) {
    await this.db
      .update(backfillChunks)
      .set({ status: 'pending', lockedBy: null, lockedUntil: null })
      .where(and(eq(backfillChunks.lockedBy, workerId), eq(backfillChunks.status, 'running')));
  }

  async backfillProgress() {
    const rows = await this.db
      .select({
        status: backfillChunks.status,
        n: sql<number>`count(*)::int`,
        blocks: sql<number>`coalesce(sum(to_block - from_block + 1), 0)::int8`,
      })
      .from(backfillChunks)
      .where(eq(backfillChunks.chainId, this.chainId))
      .groupBy(backfillChunks.status);
    const by = Object.fromEntries(
      rows.map((r) => [r.status, { chunks: Number(r.n), blocks: Number(r.blocks) }]),
    );
    const total = rows.reduce((a, r) => a + Number(r.n), 0);
    return { byStatus: by, total, done: by.done?.chunks ?? 0 };
  }

  /** Lowest block not yet covered by a finished backfill chunk minus 1, bounded by the live head and boundary. */
  async updateFinalizedCursor(boundary: number, chainHead: number) {
    const [open] = await this.db
      .select({ min: sql<number | null>`min(from_block)` })
      .from(backfillChunks)
      .where(and(eq(backfillChunks.chainId, this.chainId), sql`status <> 'done'`));
    const cp = await this.getCheckpoint();
    if (!cp) return;
    const openMin = open?.min === null || open?.min === undefined ? null : Number(open.min);
    const cursor = Math.min(
      cp.liveHeadNumber,
      boundary,
      openMin === null ? Number.MAX_SAFE_INTEGER : openMin - 1,
    );
    await this.db
      .update(indexerCheckpoints)
      .set({
        finalizedCursor: Math.max(cursor, 0),
        finalizedBoundary: boundary,
        chainHead,
        updatedAt: new Date(),
      })
      .where(eq(indexerCheckpoints.chainId, this.chainId));
  }

  /** Keep ~`keep` blocks of headers below the finalized boundary; never delete the live head. */
  async pruneBlocks(boundary: number, keep: number) {
    const cp = await this.getCheckpoint();
    if (!cp) return 0;
    const below = Math.min(boundary - keep, cp.liveHeadNumber - 1);
    const res = await this.db
      .delete(chainBlocks)
      .where(and(eq(chainBlocks.chainId, this.chainId), lt(chainBlocks.number, below)))
      .returning({ n: chainBlocks.number });
    return res.length;
  }

  // ---- promoter / outbox ----

  async seenUpTo(boundary: number, limit = 200) {
    return this.db
      .select()
      .from(deposits)
      .where(
        and(
          eq(deposits.chainId, this.chainId),
          eq(deposits.status, 'seen'),
          lte(deposits.blockNumber, boundary),
        ),
      )
      .orderBy(asc(deposits.blockNumber))
      .limit(limit);
  }

  async updateConfirmations(head: number) {
    await this.db.execute(sql`
      UPDATE deposits SET confirmations = GREATEST(0, ${head} - block_number + 1)
      WHERE chain_id = ${this.chainId} AND status = 'seen'`);
  }

  async promote(id: string, blockHash: string) {
    const r = await this.db
      .update(deposits)
      .set({ status: 'confirmed', confirmedAt: new Date() })
      .where(and(eq(deposits.id, id), eq(deposits.status, 'seen'), eq(deposits.blockHash, blockHash)))
      .returning({ id: deposits.id });
    return r.length === 1;
  }

  /** Final + canonical but no client: park it for an operator (seen → manual_review). */
  async parkUnattributed(id: string, reason: string) {
    const r = await this.db
      .update(deposits)
      .set({ status: 'manual_review', statusReason: reason })
      .where(and(eq(deposits.id, id), eq(deposits.status, 'seen')))
      .returning({ id: deposits.id });
    return r.length === 1;
  }

  async orphanSeen(id: string, reason: string) {
    await this.db
      .update(deposits)
      .set({ status: 'orphaned', statusReason: reason })
      .where(and(eq(deposits.id, id), eq(deposits.status, 'seen')));
  }

  async outbox(limit = 50) {
    return this.db
      .select({ id: deposits.id, workflowId: deposits.workflowId, attempts: deposits.dispatchAttempts })
      .from(deposits)
      .where(and(eq(deposits.chainId, this.chainId), eq(deposits.status, 'confirmed')))
      .orderBy(asc(deposits.confirmedAt))
      .limit(limit);
  }

  async markDispatched(id: string) {
    await this.db
      .update(deposits)
      .set({ status: 'dispatched', dispatchedAt: new Date(), lastDispatchError: null })
      .where(and(eq(deposits.id, id), eq(deposits.status, 'confirmed')));
  }

  async markDispatchFailed(id: string, err: string) {
    await this.db
      .update(deposits)
      .set({ dispatchAttempts: sql`${deposits.dispatchAttempts} + 1`, lastDispatchError: err.slice(0, 500) })
      .where(eq(deposits.id, id));
  }

  async depositCountsByStatus() {
    const rows = await this.db
      .select({ status: deposits.status, n: sql<number>`count(*)::int` })
      .from(deposits)
      .where(eq(deposits.chainId, this.chainId))
      .groupBy(deposits.status);
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)])) as Record<string, number>;
  }
}
