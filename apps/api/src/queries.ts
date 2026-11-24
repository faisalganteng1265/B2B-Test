import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import {
  auditLog,
  backfillChunks,
  clientBankAccounts,
  clients,
  depositAddresses,
  deposits,
  indexerCheckpoints,
  ledgerEntries,
  offrampRuns,
  offrampStepEvents,
  payouts,
  type Db,
} from '@mopay/db';
import { formatDecimal } from '@mopay/shared';

type DepositStatus = (typeof deposits.$inferSelect)['status'];

const tok = (v: bigint | null | undefined) => (v === null || v === undefined ? null : formatDecimal(v, 6));
const str = (v: bigint | null | undefined) => (v === null || v === undefined ? null : v.toString());

/** Public JSON shape of a deposit (bigints as strings, token amounts also as decimals). */
export function depositJson(
  d: typeof deposits.$inferSelect,
  extra: { run?: typeof offrampRuns.$inferSelect | null; clientName?: string | null } = {},
) {
  const r = extra.run;
  return {
    id: d.id,
    chainId: d.chainId,
    clientId: d.clientId,
    clientName: extra.clientName ?? undefined,
    token: d.tokenSymbol,
    tokenAddress: d.tokenAddress,
    txHash: d.txHash,
    logIndex: d.logIndex,
    blockNumber: d.blockNumber,
    from: d.fromAddress,
    to: d.toAddress,
    amount: tok(d.amountBaseUnits),
    amountBaseUnits: str(d.amountBaseUnits),
    status: d.status,
    statusReason: d.statusReason,
    source: d.source,
    confirmations: d.confirmations,
    workflowId: d.workflowId,
    firstSeenAt: d.firstSeenAt,
    confirmedAt: d.confirmedAt,
    dispatchedAt: d.dispatchedAt,
    completedAt: d.completedAt,
    offramp: r
      ? {
          step: r.step,
          quoteId: r.quoteId,
          rate: r.rateScaled === null ? null : formatDecimal(r.rateScaled, 6, 2),
          priceAsOf: r.priceAsOf,
          priceSource: r.priceSource,
          grossIdr: str(r.grossIdr),
          feeIdr: str(r.feeIdr),
          idrAmount: str(r.idrAmount),
          exchangeOrderId: r.exchangeOrderId,
          quoteAttempts: r.quoteAttempts,
          attempts: r.attempts,
          lastError: r.lastError,
          updatedAt: r.updatedAt,
        }
      : null,
  };
}

export async function listDeposits(
  db: Db,
  opts: { clientId?: string; status?: DepositStatus; limit?: number },
) {
  const where = and(
    opts.clientId ? eq(deposits.clientId, opts.clientId) : undefined,
    opts.status ? eq(deposits.status, opts.status) : undefined,
  );
  const rows = await db
    .select({ d: deposits, r: offrampRuns, clientName: clients.name })
    .from(deposits)
    .leftJoin(offrampRuns, eq(offrampRuns.depositId, deposits.id))
    .innerJoin(clients, eq(clients.id, deposits.clientId))
    .where(where)
    .orderBy(desc(deposits.firstSeenAt))
    .limit(Math.min(opts.limit ?? 100, 500));
  return rows.map((x) => depositJson(x.d, { run: x.r, clientName: x.clientName }));
}

export const WORKFLOW_STEPS = [
  'load-deposit',
  'record-received',
  'wait-exchange-credit',
  'lock-quote',
  'confirm-swap',
  'record-swap',
  'account-inquiry',
  'create-payout',
  'await-payout-result',
  'finalize',
] as const;

export async function depositDetail(db: Db, id: string, clientId?: string) {
  const row = await db
    .select({ d: deposits, r: offrampRuns, clientName: clients.name })
    .from(deposits)
    .leftJoin(offrampRuns, eq(offrampRuns.depositId, deposits.id))
    .innerJoin(clients, eq(clients.id, deposits.clientId))
    .where(and(eq(deposits.id, id), clientId ? eq(deposits.clientId, clientId) : undefined))
    .limit(1);
  const x = row[0];
  if (!x) return null;
  const events = await db
    .select()
    .from(offrampStepEvents)
    .where(eq(offrampStepEvents.depositId, id))
    .orderBy(asc(offrampStepEvents.id));
  const timeline = WORKFLOW_STEPS.map((step) => {
    const ev = events.filter((e) => e.step === step);
    const failures = ev.filter((e) => e.kind === 'retrying' || e.kind === 'failed');
    const succeeded = ev.find((e) => e.kind === 'succeeded');
    const lastErr = failures[failures.length - 1];
    const state = succeeded
      ? 'done'
      : ev.some((e) => e.kind === 'failed')
        ? 'failed'
        : ev.length
          ? 'running'
          : 'pending';
    return {
      step,
      state,
      attempts: ev.filter((e) => e.kind === 'started').length,
      retries: failures.length,
      lastError: lastErr?.error ?? null,
      startedAt: ev[0]?.createdAt ?? null,
      finishedAt: succeeded?.createdAt ?? null,
    };
  });
  const payout = await db.query.payouts.findFirst({ where: eq(payouts.depositId, id) });
  const ledger = await db
    .select()
    .from(ledgerEntries)
    .where(eq(ledgerEntries.depositId, id))
    .orderBy(asc(ledgerEntries.id));
  const audit = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entity, 'deposit'), eq(auditLog.entityId, id)))
    .orderBy(asc(auditLog.id));
  return {
    ...depositJson(x.d, { run: x.r, clientName: x.clientName }),
    timeline,
    events: events.map((e) => ({
      step: e.step,
      kind: e.kind,
      attempt: e.attempt,
      error: e.error,
      at: e.createdAt,
    })),
    payout: payout
      ? {
          id: payout.id,
          status: payout.status,
          amountIdr: payout.amountIdr.toString(),
          bifastRef: payout.bifastRef,
          idempotencyKey: payout.idempotencyKey,
          failureReason: payout.failureReason,
          createdAt: payout.createdAt,
          updatedAt: payout.updatedAt,
        }
      : null,
    ledger: ledger.map(ledgerJson),
    audit: audit.map((a) => ({ action: a.action, actor: a.actor, data: a.data, at: a.createdAt })),
  };
}

function ledgerJson(l: typeof ledgerEntries.$inferSelect) {
  return {
    id: l.id,
    journalId: l.journalId,
    account: l.account,
    currency: l.currency,
    debit: l.debit.toString(),
    credit: l.credit.toString(),
    depositId: l.depositId,
    at: l.createdAt,
  };
}

export async function indexerStatus(db: Db, chainId: number) {
  const cp = await db.query.indexerCheckpoints.findFirst({ where: eq(indexerCheckpoints.chainId, chainId) });
  const chunks = await db
    .select({
      status: backfillChunks.status,
      n: sql<number>`count(*)::int`,
      blocks: sql<string>`coalesce(sum(to_block - from_block + 1), 0)::text`,
    })
    .from(backfillChunks)
    .where(eq(backfillChunks.chainId, chainId))
    .groupBy(backfillChunks.status);
  const by = Object.fromEntries(
    chunks.map((c) => [c.status, { chunks: Number(c.n), blocks: Number(c.blocks) }]),
  );
  const total = chunks.reduce((a, c) => a + Number(c.n), 0);
  const totalBlocks = chunks.reduce((a, c) => a + Number(c.blocks), 0);
  const doneBlocks = by.done?.blocks ?? 0;
  return {
    chainHead: cp?.chainHead ?? null,
    liveHead: cp?.liveHeadNumber ?? null,
    lag: cp?.chainHead && cp ? Math.max(0, cp.chainHead - cp.liveHeadNumber) : null,
    finalizedBoundary: cp?.finalizedBoundary ?? null,
    finalizedCursor: cp?.finalizedCursor ?? null,
    reorgsDetected: cp?.reorgsDetected ?? 0,
    lastReorgDepth: cp?.lastReorgDepth ?? null,
    updatedAt: cp?.updatedAt ?? null,
    backfill: {
      chunks: total,
      done: by.done?.chunks ?? 0,
      running: by.running?.chunks ?? 0,
      pending: by.pending?.chunks ?? 0,
      failed: by.failed?.chunks ?? 0,
      pct: totalBlocks ? Math.floor((doneBlocks / totalBlocks) * 1000) / 10 : 100,
    },
  };
}

export async function depositCounts(db: Db) {
  const rows = await db
    .select({ status: deposits.status, n: sql<number>`count(*)::int` })
    .from(deposits)
    .groupBy(deposits.status);
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)])) as Partial<
    Record<DepositStatus, number>
  >;
}

/** Successful payouts since local midnight (WIB, UTC+7). */
export async function payoutsToday(db: Db) {
  const now = new Date();
  const wibMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), -7));
  if (wibMidnight.getTime() > now.getTime()) wibMidnight.setUTCDate(wibMidnight.getUTCDate() - 1);
  const [r] = await db
    .select({ n: sql<number>`count(*)::int`, idr: sql<string>`coalesce(sum(amount_idr), 0)::text` })
    .from(payouts)
    .where(and(eq(payouts.status, 'success'), gte(payouts.updatedAt, wibMidnight)));
  return { count: Number(r?.n ?? 0), idr: r?.idr ?? '0', since: wibMidnight };
}

export async function alerts(db: Db) {
  const rows = await db
    .select({
      id: deposits.id,
      status: deposits.status,
      reason: deposits.statusReason,
      at: deposits.updatedAt,
      txHash: deposits.txHash,
    })
    .from(deposits)
    .where(eq(deposits.status, 'manual_review'))
    .orderBy(desc(deposits.updatedAt))
    .limit(20);
  const retryAlerts = await db
    .select({ entityId: auditLog.entityId, data: auditLog.data, at: auditLog.createdAt })
    .from(auditLog)
    .where(eq(auditLog.action, 'step_retry_alert'))
    .orderBy(desc(auditLog.id))
    .limit(10);
  return {
    manualReview: rows.map((r) => ({ ...r, incident: (r.reason ?? '').startsWith('INCIDENT') })),
    retryAlerts,
  };
}

export async function listClients(db: Db, chainId: number) {
  const cs = await db.select().from(clients).orderBy(asc(clients.createdAt));
  const ids = cs.map((c) => c.id);
  if (!ids.length) return [];
  const addrs = await db.select().from(depositAddresses).where(inArray(depositAddresses.clientId, ids));
  const banks = await db.select().from(clientBankAccounts).where(inArray(clientBankAccounts.clientId, ids));
  const stats = await db
    .select({
      clientId: deposits.clientId,
      n: sql<number>`count(*)::int`,
      completed: sql<number>`count(*) filter (where status = 'completed')::int`,
      volume: sql<string>`coalesce(sum(amount_base_units) filter (where status = 'completed'), 0)::text`,
    })
    .from(deposits)
    .where(inArray(deposits.clientId, ids))
    .groupBy(deposits.clientId);
  const paid = await db
    .select({ clientId: deposits.clientId, idr: sql<string>`coalesce(sum(payouts.amount_idr), 0)::text` })
    .from(payouts)
    .innerJoin(deposits, eq(deposits.id, payouts.depositId))
    .where(eq(payouts.status, 'success'))
    .groupBy(deposits.clientId);
  return cs.map((c) => {
    const s = stats.find((x) => x.clientId === c.id);
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      subAccountId: c.exchangeSubaccount,
      apiKeyPrefix: c.apiKeyPrefix,
      createdAt: c.createdAt,
      depositAddresses: addrs
        .filter((a) => a.clientId === c.id)
        .map((a) => ({
          chainId: a.chainId,
          address: a.address,
          source: a.source,
          current: a.chainId === chainId,
        })),
      bankAccounts: banks
        .filter((b) => b.clientId === c.id)
        .map((b) => ({
          id: b.id,
          bankCode: b.bankCode,
          accountNumber: b.accountNumber,
          accountName: b.accountName,
          verifiedAt: b.verifiedAt,
        })),
      stats: {
        deposits: Number(s?.n ?? 0),
        completed: Number(s?.completed ?? 0),
        volumeUsdt: formatDecimal(BigInt(s?.volume ?? '0'), 6),
        paidOutIdr: paid.find((p) => p.clientId === c.id)?.idr ?? '0',
      },
    };
  });
}

export async function ledgerOverview(db: Db, depositId?: string) {
  const totals = await db
    .select({
      account: ledgerEntries.account,
      currency: ledgerEntries.currency,
      debit: sql<string>`sum(debit)::text`,
      credit: sql<string>`sum(credit)::text`,
    })
    .from(ledgerEntries)
    .groupBy(ledgerEntries.account, ledgerEntries.currency);
  const entries = await db
    .select({ e: ledgerEntries, txHash: deposits.txHash })
    .from(ledgerEntries)
    .leftJoin(deposits, eq(deposits.id, ledgerEntries.depositId))
    .where(depositId ? eq(ledgerEntries.depositId, depositId) : undefined)
    .orderBy(desc(ledgerEntries.id))
    .limit(depositId ? 1000 : 300);
  const journals = new Map<
    string,
    {
      journalId: string;
      depositId: string | null;
      txHash: string | null;
      at: Date;
      lines: ReturnType<typeof ledgerJson>[];
    }
  >();
  for (const { e, txHash } of entries) {
    const j = journals.get(e.journalId) ?? {
      journalId: e.journalId,
      depositId: e.depositId,
      txHash,
      at: e.createdAt,
      lines: [],
    };
    j.lines.push(ledgerJson(e));
    journals.set(e.journalId, j);
  }
  const list = [...journals.values()].map((j) => {
    const byCur = new Map<string, bigint>();
    for (const l of j.lines)
      byCur.set(l.currency, (byCur.get(l.currency) ?? 0n) + BigInt(l.debit) - BigInt(l.credit));
    return { ...j, kind: j.journalId.split(':').pop(), balanced: [...byCur.values()].every((v) => v === 0n) };
  });
  const [unb] = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM (
      SELECT journal_id FROM ledger_entries GROUP BY journal_id, currency HAVING sum(debit) <> sum(credit)) x`);
  return {
    balanced: Number(unb?.n ?? 0) === 0,
    unbalancedJournals: Number(unb?.n ?? 0),
    totals: totals.map((t) => ({ ...t, balance: (BigInt(t.debit) - BigInt(t.credit)).toString() })),
    journals: list,
  };
}
