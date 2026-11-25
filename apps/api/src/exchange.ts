import { and, desc, eq, isNull } from 'drizzle-orm';
import { depositAddresses, postJournal, treasurySweeps, type Db } from '@mopay/db';
import {
  feeIdr,
  formatDecimal,
  formatRate,
  IndodaxClient,
  indodaxClientId,
  PriceFeed,
  tokenToIdr,
  type Logger,
} from '@mopay/shared';

/** Retry transient exchange errors (5xx, timeouts, rate limits) a few times with backoff. */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!(e as { retryable?: boolean }).retryable) throw e;
      await new Promise((r) => setTimeout(r, 200 * 2 ** i));
    }
  }
  throw last;
}

/** Mopay's exchange deposit address (Indodax: ONE per account; clients are told apart by sender). */
export async function sharedDepositAddress(db: Db, chainId: number) {
  return db.query.depositAddresses.findFirst({
    where: and(eq(depositAddresses.chainId, chainId), eq(depositAddresses.kind, 'shared')),
  });
}

/** Dashboard price card: real Indodax book (bid/ask/last/VWAP for 10k USDT). */
export async function priceView(feed: PriceFeed) {
  const r = await feed.read();
  const s = r.snapshot;
  let vwap;
  try {
    const q = PriceFeed.quoteSell(s, 10_000_000_000n);
    vwap = {
      amount: '10000000000',
      rate: formatRate(q.vwapScaled),
      levelsUsed: q.levelsUsed,
      slippageBps: q.slippageBps.toString(),
    };
  } catch {
    vwap = undefined;
  }
  return {
    symbol: 'USDT-IDR',
    source: s.source,
    bid: formatRate(s.bid),
    ask: formatRate(s.ask),
    last: formatRate(s.last),
    stale: r.stale,
    asOf: s.asOf.toISOString(),
    ageMs: r.ageMs,
    vwap,
  };
}

/**
 * Indicative quote for selling `amount` USDT: VWAP on the live bid book, minus the exchange
 * commission estimate (fee + tax) and Mopay's fee. Both fees rounded up, net rounded down.
 */
export async function indicativeQuote(
  feed: PriceFeed,
  amount: bigint,
  commissionBps: bigint,
  feeBps: bigint,
) {
  const r = await feed.readForExecution();
  const q = PriceFeed.quoteSell(r.snapshot, amount);
  const gross = tokenToIdr(amount, q.vwapScaled);
  const exchangeFee = feeIdr(gross, commissionBps);
  const fee = feeIdr(gross, feeBps);
  return {
    amount: formatDecimal(amount, 6),
    rate: formatRate(q.vwapScaled),
    grossIdr: gross.toString(),
    exchangeFeeIdr: exchangeFee.toString(),
    feeIdr: fee.toString(),
    netIdr: (gross - exchangeFee - fee).toString(),
    feeBps: feeBps.toString(),
    exchangeFeeBps: commissionBps.toString(),
    priceSource: r.snapshot.source,
    priceAsOf: r.snapshot.asOf.toISOString(),
    stale: r.stale,
    slippageBps: q.slippageBps.toString(),
    indicative: true as const,
  };
}

/**
 * Treasury: sweep IDR from the exchange to Mopay's own (KYC same-name) bank account. Payouts to
 * clients are paid from that float, so a client never waits for an exchange withdrawal.
 * Idempotent: the row id → deterministic clientRequestId; a lost response is re-submitted safely.
 */
export class Treasury {
  constructor(
    private readonly db: Db,
    private readonly indodax: IndodaxClient,
    private readonly bank: { bankCode: string; accountNumber: string },
    private readonly log: Logger,
  ) {}

  async sweep(amount: bigint) {
    if (amount <= 100_000n) throw new Error('Indodax requires an IDR withdrawal greater than Rp100.000');
    const [row] = await this.db
      .insert(treasurySweeps)
      .values({ clientRequestId: 'pending', amountIdr: amount })
      .returning();
    const crid = indodaxClientId(row!.id, 'sweep');
    await this.db.update(treasurySweeps).set({ clientRequestId: crid }).where(eq(treasurySweeps.id, row!.id));
    await this.submit(row!.id, crid, amount);
    return this.db.query.treasurySweeps.findFirst({ where: eq(treasurySweeps.id, row!.id) });
  }

  private async submit(id: string, crid: string, amount: bigint) {
    for (let i = 0; i < 4; i++) {
      try {
        const r = await this.indodax.fiatWithdraw({
          amount,
          accountNumber: this.bank.accountNumber,
          bankCode: this.bank.bankCode,
          clientRequestId: crid,
        });
        await this.db
          .update(treasurySweeps)
          .set({ exchangeOrderNo: r.data.orderId, status: 'submitted', updatedAt: new Date() })
          .where(eq(treasurySweeps.id, id));
        return;
      } catch (e) {
        if (!(e as { retryable?: boolean }).retryable) {
          await this.db
            .update(treasurySweeps)
            .set({ status: 'rejected', updatedAt: new Date() })
            .where(eq(treasurySweeps.id, id));
          throw e;
        }
        await new Promise((r) => setTimeout(r, 300 * 2 ** i));
      }
    }
    this.log.warn(
      { sweep: id },
      'sweep not confirmed yet; will be re-submitted with the same clientRequestId',
    );
  }

  /** Re-submit unconfirmed sweeps, pick up settlements, post the ledger journal exactly once. */
  async reconcile() {
    const open = await this.db.select().from(treasurySweeps).where(isNull(treasurySweeps.exchangeOrderNo));
    for (const s of open)
      if (s.status === 'requested') await this.submit(s.id, s.clientRequestId, s.amountIdr).catch(() => {});
    const orders = (await withRetry(() => this.indodax.fiatOrders('1'))).data;
    const pending = await this.db.select().from(treasurySweeps).where(eq(treasurySweeps.status, 'submitted'));
    for (const s of pending) {
      const o = orders.find((x) => x.orderNo === s.exchangeOrderNo);
      if (!o || o.status !== 'success') continue;
      const fee = BigInt(o.totalFee);
      await this.db.transaction(async (tx) => {
        await postJournal(tx, {
          id: `sweep:${s.id}`,
          kind: 'sweep',
          lines: [
            { account: 'mopay_bank_idr', currency: 'IDR', debit: s.amountIdr - fee },
            ...(fee > 0n ? [{ account: 'withdraw_fee_expense' as const, currency: 'IDR', debit: fee }] : []),
            { account: 'exchange_idr', currency: 'IDR', credit: s.amountIdr },
          ],
        });
        await tx
          .update(treasurySweeps)
          .set({ status: 'success', feeIdr: fee, updatedAt: new Date() })
          .where(eq(treasurySweeps.id, s.id));
      });
    }
    return this.db.select().from(treasurySweeps).orderBy(desc(treasurySweeps.createdAt)).limit(20);
  }
}
