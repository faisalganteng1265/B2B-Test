import * as restate from '@restatedev/restate-sdk';
import { and, eq, sql } from 'drizzle-orm';
import {
  auditLog,
  clientBankAccounts,
  clients,
  deposits,
  offrampRuns,
  payouts,
  postJournal,
  type Db,
} from '@mopay/db';
import {
  BifastClient,
  feeIdr,
  MobeeClient,
  payoutIdempotencyKey,
  swapIdempotencyKey,
  UpstreamError,
  withCorrelation,
  type Logger,
} from '@mopay/shared';
import { step, terminal, terminalCode, type StepConfig, type StepCtx } from './steps';

export interface OfframpConfig extends StepConfig {
  /** minimum deposit in token base units */
  minAmountBaseUnits: bigint;
  feeBps: bigint;
  /** re-quote attempts after QUOTE_EXPIRED before manual_review */
  maxQuoteAttempts: number;
  /** poll interval while waiting for the exchange to credit the deposit */
  creditPollMs: number;
  creditPollMaxMs: number;
  /** wait for the BI-FAST callback this long before reconciling via GET */
  payoutCallbackTimeoutMs: number;
}

export interface OfframpDeps {
  db: Db;
  mobee: MobeeClient;
  bifast: BifastClient;
  cfg: OfframpConfig;
  log: Logger;
}

export interface OfframpInput {
  depositId: string;
}

export interface OfframpResult {
  status: 'completed' | 'manual_review';
  reason?: string;
  payoutId?: string;
  idrAmount?: string;
}

/** Payload the API forwards from a verified BI-FAST callback to the awakeable. */
export interface PayoutSignal {
  transferId: string;
  status: 'success' | 'failed';
  reason?: string;
}

interface LoadedDeposit {
  depositId: string;
  workflowId: string;
  clientId: string;
  subAccountId: string;
  txHash: string;
  logIndex: number;
  amount: string;
  tokenSymbol: string;
  bank: { id: string; bankCode: string; accountNumber: string; accountName: string };
}

const normName = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

export function createOfframpWorkflow(deps: OfframpDeps) {
  const { db, mobee, bifast, cfg } = deps;

  return restate.workflow({
    name: 'offramp',
    description: 'USDT deposit → swap to IDR on the exchange → BI-FAST payout',
    handlers: {
      run: async (ctx: restate.WorkflowContext, input: OfframpInput): Promise<OfframpResult> => {
        const depositId = input.depositId;
        const log = withCorrelation(deps.log, depositId, { workflowId: ctx.key });
        const s: StepCtx = { ctx, db, depositId, log, cfg };

        try {
          // 1. load-deposit ----------------------------------------------------------------
          const d = await step(s, 'load-deposit', () => loadDeposit(db, depositId, ctx.key, cfg));

          // 2. record-received (ledger: USDT now owed to the client, held at the exchange) ---
          await step(s, 'record-received', async () => {
            await db.transaction((tx) =>
              postJournal(tx, {
                id: `${depositId}:received`,
                kind: 'received',
                depositId,
                lines: [
                  { account: 'exchange_usdt', currency: d.tokenSymbol, debit: BigInt(d.amount) },
                  { account: 'client_usdt_liability', currency: d.tokenSymbol, credit: BigInt(d.amount) },
                ],
              }),
            );
          });

          // 3. wait-exchange-credit (durable sleep between polls, never a busy loop) --------
          let pollDelay = cfg.creditPollMs;
          for (let i = 0; ; i++) {
            const credited = await step(
              s,
              'wait-exchange-credit',
              async () => {
                const st = await mobee.depositStatus(d.txHash);
                if (st.status === 'failed')
                  throw terminal('DEPOSIT_TX_FAILED', 'exchange reports the tx as failed');
                const mine = st.deposits.find((x) => x.logIndex === d.logIndex);
                if (mine && mine.amount !== d.amount) {
                  throw terminal(
                    'AMOUNT_MISMATCH',
                    `exchange credited ${mine.amount}, indexer saw ${d.amount}`,
                  );
                }
                return mine?.status === 'credited';
              },
              `poll-exchange-credit-${i}`,
            );
            if (credited) break;
            await ctx.sleep(pollDelay, 'credit-poll-backoff');
            pollDelay = Math.min(cfg.creditPollMaxMs, Math.round(pollDelay * 1.5));
          }

          // 4+5. lock-quote → confirm-swap (re-quote on QUOTE_EXPIRED, bounded) -----------
          let order: { orderId: string; idrAmount: string; rateScaled: string } | null = null;
          for (let q = 0; q < cfg.maxQuoteAttempts && !order; q++) {
            const quote = await step(
              s,
              'lock-quote',
              async () => {
                const r = await mobee.lock(d.subAccountId, BigInt(d.amount));
                await db
                  .update(offrampRuns)
                  .set({
                    quoteId: r.quoteId,
                    rateScaled: BigInt(r.rateScaled),
                    priceAsOf: new Date(r.priceAsOf),
                    priceSource: r.priceSource,
                    quoteAttempts: q + 1,
                    updatedAt: new Date(),
                  })
                  .where(eq(offrampRuns.depositId, depositId));
                return {
                  quoteId: r.quoteId,
                  rateScaled: r.rateScaled,
                  priceAsOf: r.priceAsOf,
                  priceSource: r.priceSource,
                };
              },
              `lock-quote-${q}`,
            );
            // Key per quote: Mobee records QUOTE_EXPIRED against the key, so a re-quote needs a
            // fresh key. Safe: we only re-quote after a DEFINITIVE "not executed" answer.
            const key =
              q === 0 ? swapIdempotencyKey(d.workflowId) : `${swapIdempotencyKey(d.workflowId)}:${q}`;
            try {
              order = await step(
                s,
                'confirm-swap',
                async () => {
                  const o = await mobee.confirm(quote.quoteId, key);
                  await db
                    .update(offrampRuns)
                    .set({ exchangeOrderId: o.orderId, updatedAt: new Date() })
                    .where(eq(offrampRuns.depositId, depositId));
                  return { orderId: o.orderId, idrAmount: o.idrAmount, rateScaled: o.rateScaled };
                },
                `confirm-swap-${q}`,
              );
            } catch (e) {
              if (terminalCode(e) !== 'QUOTE_EXPIRED') throw e;
              log.warn({ attempt: q + 1 }, 'quote expired; re-quoting');
            }
          }
          if (!order) throw terminal('QUOTE_EXPIRED', `quote expired ${cfg.maxQuoteAttempts} times`);

          // 6. record-swap (ledger, integer math, fee rounded up) ---------------------------
          const money = await step(s, 'record-swap', async () => {
            const gross = BigInt(order.idrAmount);
            const fee = feeIdr(gross, cfg.feeBps);
            const net = gross - fee;
            await db.transaction(async (tx) => {
              await postJournal(tx, {
                id: `${depositId}:swap`,
                kind: 'swap',
                depositId,
                lines: [
                  { account: 'client_usdt_liability', currency: d.tokenSymbol, debit: BigInt(d.amount) },
                  { account: 'exchange_usdt', currency: d.tokenSymbol, credit: BigInt(d.amount) },
                  { account: 'exchange_idr', currency: 'IDR', debit: gross },
                  { account: 'client_idr_payable', currency: 'IDR', credit: net },
                  ...(fee > 0n ? [{ account: 'fee_revenue' as const, currency: 'IDR', credit: fee }] : []),
                ],
              });
              await tx
                .update(offrampRuns)
                .set({ grossIdr: gross, feeIdr: fee, idrAmount: net, updatedAt: new Date() })
                .where(eq(offrampRuns.depositId, depositId));
            });
            return { gross: gross.toString(), fee: fee.toString(), net: net.toString() };
          });

          // 7. account-inquiry ---------------------------------------------------------------
          await step(s, 'account-inquiry', async () => {
            const r = await bifast.accountInquiry(d.bank.bankCode, d.bank.accountNumber);
            if (normName(r.accountName) !== normName(d.bank.accountName)) {
              throw terminal(
                'ACCOUNT_NAME_MISMATCH',
                `bank says "${r.accountName}", we have "${d.bank.accountName}"`,
              );
            }
          });

          // 8. create-payout: row first (UNIQUE deposit_id + idempotency key), then awakeable,
          //    then the transfer — so a fast callback can always find the awakeable id.
          const payoutKey = payoutIdempotencyKey(d.workflowId);
          const payoutId = await step(
            s,
            'create-payout',
            async () => {
              await db
                .insert(payouts)
                .values({
                  depositId,
                  idempotencyKey: payoutKey,
                  bankAccountId: d.bank.id,
                  amountIdr: BigInt(money.net),
                })
                .onConflictDoNothing();
              const p = await db.query.payouts.findFirst({ where: eq(payouts.depositId, depositId) });
              if (!p) throw new Error('payout row missing after insert');
              if (p.amountIdr !== BigInt(money.net) || p.idempotencyKey !== payoutKey) {
                throw terminal('PAYOUT_MISMATCH', 'existing payout row does not match this run');
              }
              await db
                .update(offrampRuns)
                .set({ payoutId: p.id })
                .where(eq(offrampRuns.depositId, depositId));
              return p.id;
            },
            'create-payout-row',
          );
          const awake = ctx.awakeable<PayoutSignal>();
          await step(
            s,
            'create-payout',
            async () => {
              await db
                .update(payouts)
                .set({ awakeableId: awake.id, updatedAt: new Date() })
                .where(eq(payouts.id, payoutId));
            },
            'store-awakeable',
          );
          const transfer = await step(
            s,
            'create-payout',
            async () => {
              const t = await bifast.createTransfer(payoutKey, {
                bankCode: d.bank.bankCode,
                accountNumber: d.bank.accountNumber,
                accountName: d.bank.accountName,
                amount: BigInt(money.net),
                remark: `Mopay offramp ${d.txHash.slice(0, 10)}`,
              });
              await db
                .update(payouts)
                .set({ bifastRef: t.transferId, updatedAt: new Date() })
                .where(eq(payouts.id, payoutId));
              return { transferId: t.transferId };
            },
            'bifast-transfer',
          );

          // 9. await-payout-result: callback (awakeable) with timeout → reconcile via GET ----
          let result: PayoutSignal | null = null;
          for (let i = 0; !result; i++) {
            await step(s, 'await-payout-result', async () => undefined, `await-payout-${i}`);
            try {
              result = await awake.promise.orTimeout(cfg.payoutCallbackTimeoutMs);
              log.info({ result }, 'payout callback received');
            } catch (e) {
              if (!(e instanceof restate.TimeoutError)) throw e;
              const r = await step(
                s,
                'await-payout-result',
                async () => {
                  const t = await bifast.getTransfer(transfer.transferId);
                  return t.status === 'pending'
                    ? null
                    : { transferId: t.transferId, status: t.status, reason: t.reason ?? undefined };
                },
                `reconcile-payout-${i}`,
              );
              if (r) {
                result = r;
                log.warn({ result }, 'no callback in time; resolved by reconciliation');
              }
            }
          }
          if (result.transferId !== transfer.transferId) {
            throw terminal(
              'PAYOUT_SIGNAL_MISMATCH',
              `signal for ${result.transferId}, expected ${transfer.transferId}`,
            );
          }

          // 10. finalize ----------------------------------------------------------------------
          const final = result;
          return await step(s, 'finalize', async (): Promise<OfframpResult> => {
            if (final.status === 'success') {
              await db.transaction(async (tx) => {
                await tx
                  .update(payouts)
                  .set({ status: 'success', updatedAt: new Date() })
                  .where(eq(payouts.id, payoutId));
                await postJournal(tx, {
                  id: `${depositId}:payout`,
                  kind: 'payout',
                  depositId,
                  lines: [
                    { account: 'client_idr_payable', currency: 'IDR', debit: BigInt(money.net) },
                    { account: 'bank_out', currency: 'IDR', credit: BigInt(money.net) },
                  ],
                });
                await tx
                  .update(deposits)
                  .set({ status: 'completed', completedAt: new Date(), statusReason: null })
                  .where(and(eq(deposits.id, depositId), sql`status IN ('dispatched', 'manual_review')`));
                await tx
                  .update(offrampRuns)
                  .set({ step: 'completed', lastError: null, updatedAt: new Date() })
                  .where(eq(offrampRuns.depositId, depositId));
                await tx
                  .insert(auditLog)
                  .values({
                    actor: 'workflow',
                    action: 'payout_success',
                    entity: 'deposit',
                    entityId: depositId,
                    data: { payoutId, idr: money.net },
                  });
              });
              return { status: 'completed', payoutId, idrAmount: money.net };
            }
            // Final bank reject: do NOT retry to the same account. Funds stay in client_idr_payable.
            const reason = `BANK_REJECTED: ${final.reason ?? 'unknown'}`;
            await db
              .update(payouts)
              .set({ status: 'failed', failureReason: final.reason ?? 'unknown', updatedAt: new Date() })
              .where(eq(payouts.id, payoutId));
            await markManualReview(db, depositId, reason);
            return { status: 'manual_review', reason, payoutId };
          });
        } catch (e) {
          const code = terminalCode(e);
          if (!code) throw e; // not terminal: let Restate retry the invocation
          const reason = e instanceof Error ? e.message : String(e);
          log.error({ reason }, 'offramp moved to manual_review');
          await ctx.run('manual-review', () => markManualReview(db, depositId, reason));
          return { status: 'manual_review', reason };
        }
      },
    },
    options: {
      // Invocation-level retry (e.g. the service crashes mid-step): backoff, no attempt limit.
      retryPolicy: { initialInterval: 200, maxInterval: 10_000, exponentiationFactor: 2 },
    },
  });
}

async function loadDeposit(
  db: Db,
  depositId: string,
  restateKey: string,
  cfg: OfframpConfig,
): Promise<LoadedDeposit> {
  const d = await db.query.deposits.findFirst({ where: eq(deposits.id, depositId) });
  if (!d) throw terminal('DEPOSIT_NOT_FOUND', depositId);
  // The Restate key is the canonical workflow id, or "<canonical>#retry-N" for an admin re-drive.
  if (restateKey !== d.workflowId && !restateKey.startsWith(`${d.workflowId}#retry-`)) {
    throw terminal('WORKFLOW_KEY_MISMATCH', `${restateKey} is not a workflow for deposit ${d.workflowId}`);
  }
  if (d.status !== 'dispatched')
    throw terminal('INVALID_STATUS', `deposit status is ${d.status}, expected dispatched`);
  const c = await db.query.clients.findFirst({ where: eq(clients.id, d.clientId) });
  if (!c) throw terminal('CLIENT_NOT_FOUND', d.clientId);
  if (c.status !== 'active') throw terminal('CLIENT_SUSPENDED', c.id);
  if (d.amountBaseUnits < cfg.minAmountBaseUnits) {
    throw terminal('BELOW_MINIMUM', `${d.amountBaseUnits} < ${cfg.minAmountBaseUnits}`);
  }
  if (d.tokenSymbol !== 'USDT') throw terminal('UNSUPPORTED_TOKEN', `${d.tokenSymbol} offramp not enabled`);
  const bank = await db.query.clientBankAccounts.findFirst({ where: eq(clientBankAccounts.clientId, c.id) });
  if (!bank || !bank.verifiedAt) throw terminal('NO_VERIFIED_BANK_ACCOUNT', c.id);
  await db
    .insert(offrampRuns)
    .values({ depositId, workflowId: d.workflowId, step: 'load-deposit' })
    .onConflictDoNothing();
  return {
    depositId,
    workflowId: d.workflowId,
    clientId: c.id,
    subAccountId: c.exchangeSubaccount,
    txHash: d.txHash,
    logIndex: d.logIndex,
    amount: d.amountBaseUnits.toString(),
    tokenSymbol: d.tokenSymbol,
    bank: {
      id: bank.id,
      bankCode: bank.bankCode,
      accountNumber: bank.accountNumber,
      accountName: bank.accountName,
    },
  };
}

async function markManualReview(db: Db, depositId: string, reason: string) {
  await db.transaction(async (tx) => {
    await tx
      .update(deposits)
      .set({ status: 'manual_review', statusReason: reason.slice(0, 500) })
      .where(and(eq(deposits.id, depositId), sql`status IN ('dispatched', 'manual_review')`));
    await tx
      .update(offrampRuns)
      .set({ step: 'manual_review', lastError: reason.slice(0, 500), updatedAt: new Date() })
      .where(eq(offrampRuns.depositId, depositId));
    await tx
      .insert(auditLog)
      .values({
        actor: 'workflow',
        action: 'manual_review',
        entity: 'deposit',
        entityId: depositId,
        data: { reason },
      });
  });
}

export { UpstreamError };
