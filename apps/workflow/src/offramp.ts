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
  BPS,
  feeIdr,
  formatDecimal,
  IndodaxClient,
  IndodaxError,
  indodaxClientId,
  parseDecimal,
  parseToken,
  payoutIdempotencyKey,
  PriceFeed,
  RATE_SCALE,
  UpstreamError,
  withCorrelation,
  type Logger,
} from '@mopay/shared';
import { step, terminal, terminalCode, type StepConfig, type StepCtx } from './steps';

export interface OfframpConfig extends StepConfig {
  /** minimum deposit in token base units */
  minAmountBaseUnits: bigint;
  feeBps: bigint;
  /** maximum accepted slippage of the actual sell vs the pre-trade VWAP (alert threshold) */
  maxSlippageBps: bigint;
  /** poll interval while waiting for fills to show up in myTrades */
  fillPollMs: number;
  /** poll interval while waiting for the exchange to credit the deposit */
  creditPollMs: number;
  creditPollMaxMs: number;
  /** wait for the BI-FAST callback this long before reconciling via GET */
  payoutCallbackTimeoutMs: number;
}

export interface OfframpDeps {
  db: Db;
  /** exchange (PAKD): INDODAX Trade API 2.0 */
  indodax: IndodaxClient;
  /** public Indodax order book, used for the pre-trade price check */
  priceFeed: PriceFeed;
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
  const { db, indodax, priceFeed, bifast, cfg } = deps;

  return restate.workflow({
    name: 'offramp',
    description: 'USDT deposit → MARKET sell on Indodax (PAKD) → BI-FAST payout',
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

          // 3. wait-exchange-credit: Indodax deposit history (durable sleep between polls) -----
          let pollDelay = cfg.creditPollMs;
          for (let i = 0; ; i++) {
            const credited = await step(
              s,
              'wait-exchange-credit',
              async () => {
                const hist = await indodax.depositHistory(d.tokenSymbol, { limit: 1000 });
                // hisrec has no log index: match by tx hash AND exact amount (base units)
                const mine = hist.find(
                  (x) => x.txId.toLowerCase() === d.txHash && parseToken(x.amount) === BigInt(d.amount),
                );
                if (mine?.status === 'failed')
                  throw terminal('DEPOSIT_FAILED_AT_EXCHANGE', `exchange marked ${d.txHash} failed`);
                return mine?.status === 'success';
              },
              `poll-exchange-credit-${i}`,
            );
            if (credited) break;
            await ctx.sleep(pollDelay, 'credit-poll-backoff');
            pollDelay = Math.min(cfg.creditPollMaxMs, Math.round(pollDelay * 1.5));
          }

          // 4. price-check: Indodax has no quote lock, so we price the sell on the live bid book
          //    (VWAP for this size) and set a slippage floor checked against the actual fills.
          const priced = await step(
            s,
            'lock-quote',
            async () => {
              const r = await priceFeed.readForExecution(); // stale > 60 s → PRICE_UNAVAILABLE (retried)
              const q = PriceFeed.quoteSell(r.snapshot, BigInt(d.amount)); // throws if the book is too thin (retried)
              const floor = (q.vwapScaled * (BPS - cfg.maxSlippageBps)) / BPS;
              await db
                .update(offrampRuns)
                .set({
                  rateScaled: q.vwapScaled,
                  priceAsOf: r.snapshot.asOf,
                  priceSource: r.snapshot.source,
                  quoteAttempts: 1,
                  updatedAt: new Date(),
                })
                .where(eq(offrampRuns.depositId, depositId));
              return {
                expectedScaled: q.vwapScaled.toString(),
                floorScaled: floor.toString(),
                priceAsOf: r.snapshot.asOf.toISOString(),
              };
            },
            'price-check',
          );

          // 5. sell: MARKET SELL with a deterministic newClientOrderId (≤ 36 chars). Indodax rejects
          //    a reused id with -2010 "duplicate" instead of replaying, so after a lost response the
          //    retry asks GET /order?origClientOrderId to prove the first attempt executed.
          const clientOrderId = indodaxClientId(d.workflowId, 'sell');
          const symbol = `${d.tokenSymbol}IDR`;
          const quantity = formatDecimal(BigInt(d.amount), 6);
          await step(
            s,
            'confirm-swap',
            async () => {
              try {
                await indodax.createOrder({
                  symbol,
                  side: 'SELL',
                  type: 'MARKET',
                  quantity,
                  newClientOrderId: clientOrderId,
                });
              } catch (e) {
                if (!(e instanceof IndodaxError)) throw e;
                if (e.isDuplicateClientId) {
                  // Already placed by a previous attempt. It must exist (it may not be visible yet → retry).
                  const o = await indodax.getOrder(symbol, { origClientOrderId: clientOrderId });
                  log.info({ clientOrderId, status: o.status }, 'sell already placed by an earlier attempt');
                } else if (e.indodaxCode === -2010 && /liquidity/i.test(e.message)) {
                  throw new Error(`order book too thin: ${e.message}`); // retryable
                } else if (e.indodaxCode === -2010) {
                  throw terminal('SELL_REJECTED', e.message); // e.g. insufficient balance
                } else throw e;
              }
              await db
                .update(offrampRuns)
                .set({ exchangeOrderId: clientOrderId, updatedAt: new Date() })
                .where(eq(offrampRuns.depositId, depositId));
            },
            'place-sell',
          );

          // 5b. fills: poll myTrades until the whole quantity is filled (durable sleep in between)
          let fills: { gross: string; commission: string; avgScaled: string } | null = null;
          for (let i = 0; !fills; i++) {
            fills = await step(
              s,
              'confirm-swap',
              async () => {
                const trades = (await indodax.myTrades(symbol.toLowerCase(), { clientOrderId })).data;
                const qty = trades.reduce((a, t) => a + parseDecimal(t.qty, 8), 0n);
                if (qty < parseDecimal(quantity, 8)) {
                  if (trades.length) {
                    const o = await indodax.getOrder(symbol, { origClientOrderId: clientOrderId });
                    if (o.status === 'CANCELLED' || o.status === 'REJECTED') {
                      throw terminal(
                        'PARTIAL_FILL',
                        `order ${o.status} after filling ${formatDecimal(qty, 8)} of ${quantity}`,
                      );
                    }
                  }
                  return null; // not (fully) visible yet
                }
                const gross = trades.reduce((a, t) => a + BigInt(t.quoteQty), 0n);
                const commission = trades.reduce((a, t) => a + BigInt(t.commission), 0n);
                return {
                  gross: gross.toString(),
                  commission: commission.toString(),
                  avgScaled: ((gross * RATE_SCALE * 1_000_000n) / BigInt(d.amount)).toString(),
                };
              },
              `fills-${i}`,
            );
            if (!fills) await ctx.sleep(cfg.fillPollMs, 'fill-poll');
          }
          if (BigInt(fills.avgScaled) < BigInt(priced.floorScaled)) {
            // Already executed — cannot be undone. Record it loudly; the client is paid the real proceeds.
            log.error(
              { expected: priced.expectedScaled, actual: fills.avgScaled },
              'ALERT: sell executed below the slippage floor',
            );
            await ctx.run('slippage-alert', () =>
              db
                .insert(auditLog)
                .values({
                  actor: 'workflow',
                  action: 'slippage_alert',
                  entity: 'deposit',
                  entityId: depositId,
                  data: { ...priced, actualScaled: fills!.avgScaled },
                })
                .then(() => undefined),
            );
          }

          // 6. record-swap: Mopay fee on gross (rounded up), exchange commission passed through.
          const done = fills;
          const money = await step(s, 'record-swap', async () => {
            const gross = BigInt(done.gross);
            const exchangeFee = BigInt(done.commission);
            const fee = feeIdr(gross, cfg.feeBps);
            const net = gross - exchangeFee - fee;
            if (net <= 0n) throw terminal('NET_NOT_POSITIVE', `gross ${gross}, fees ${exchangeFee + fee}`);
            await db.transaction(async (tx) => {
              await postJournal(tx, {
                id: `${depositId}:swap`,
                kind: 'swap',
                depositId,
                lines: [
                  { account: 'client_usdt_liability', currency: d.tokenSymbol, debit: BigInt(d.amount) },
                  { account: 'exchange_usdt', currency: d.tokenSymbol, credit: BigInt(d.amount) },
                  // IDR actually credited at the exchange = gross − commission
                  { account: 'exchange_idr', currency: 'IDR', debit: gross - exchangeFee },
                  { account: 'client_idr_payable', currency: 'IDR', credit: net },
                  ...(fee > 0n ? [{ account: 'fee_revenue' as const, currency: 'IDR', credit: fee }] : []),
                ],
              });
              await tx
                .update(offrampRuns)
                .set({
                  grossIdr: gross,
                  exchangeFeeIdr: exchangeFee,
                  feeIdr: fee,
                  idrAmount: net,
                  rateScaled: BigInt(done.avgScaled),
                  updatedAt: new Date(),
                })
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
                await tx.insert(auditLog).values({
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
  // The outbox dispatcher submits to Restate BEFORE it marks the deposit `dispatched` (so a crash in
  // between can never lose it). Restate may start us before that write lands: a `confirmed`
  // deposit is therefore valid here, and we take it over ourselves (idempotent, final already).
  if (d.status === 'confirmed') {
    await db
      .update(deposits)
      .set({ status: 'dispatched', dispatchedAt: new Date() })
      .where(and(eq(deposits.id, depositId), eq(deposits.status, 'confirmed')));
  } else if (d.status !== 'dispatched') {
    throw terminal('INVALID_STATUS', `deposit status is ${d.status}, expected confirmed|dispatched`);
  }
  if (!d.clientId) throw terminal('UNATTRIBUTED', 'deposit is not assigned to a client');
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
    await tx.insert(auditLog).values({
      actor: 'workflow',
      action: 'manual_review',
      entity: 'deposit',
      entityId: depositId,
      data: { reason },
    });
  });
}

export { UpstreamError };
