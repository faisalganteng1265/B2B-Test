import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  clientBankAccounts,
  deposits,
  ledgerEntries,
  offrampRuns,
  offrampStepEvents,
  payouts,
  webhookEvents,
} from '@mopay/db';
import { hmacHex } from '@mopay/shared';
import { handleBifastCallback } from '../src';
import { Harness, log, waitFor } from './harness';

const H = new Harness();
beforeAll(async () => H.start());
afterAll(async () => H.stop());
beforeEach(() => {
  H.exchangeChaos.update({ FAIL_RATE: 0, FAIL_AFTER_RATE: 0, TIMEOUT_RATE: 0 });
  H.bifastChaos.update({
    FAIL_RATE: 0,
    FAIL_AFTER_RATE: 0,
    DUPLICATE_CALLBACK_RATE: 0,
    DROP_CALLBACK_RATE: 0,
    FINAL_FAILURE_RATE: 0,
  });
  H.confirmDelayMs = 0;
  H.exchangeDeps.orderVisibilityDelayMs = 300;
});

const bankOf = async (depositId: string) => {
  const d = (await H.h.db.query.deposits.findFirst({ where: eq(deposits.id, depositId) }))!;
  return (await H.h.db.query.clientBankAccounts.findFirst({
    where: eq(clientBankAccounts.clientId, d.clientId!),
  }))!;
};
const exchangeOrders = () =>
  (H.exchangeStore.db.prepare('SELECT count(*) AS n FROM orders').get() as { n: number }).n;
const statusOf = async (id: string) =>
  (await H.h.db.query.deposits.findFirst({ where: eq(deposits.id, id) }))!;
const done = (id: string) =>
  waitFor(async () => {
    const d = await statusOf(id);
    return ['completed', 'manual_review', 'failed'].includes(d.status) ? d : undefined;
  }, 120_000);

describe('offramp workflow', () => {
  it('happy path: deposit → swap at the quoted rate → BI-FAST payout → completed, ledger balanced', async () => {
    const d = await H.createDeposit(0, 1_000_000_000n); // 1,000 USDT
    await H.submit(d.workflowId, d.id);
    const final = await done(d.id);
    expect(final.status).toBe('completed');

    const run = (await H.h.db.query.offrampRuns.findFirst({ where: eq(offrampRuns.depositId, d.id) }))!;
    expect(run.step).toBe('completed');
    expect(run.grossIdr).toBe(16_250_000n); // 1000 * 16250, filled at the top of the fixed bid book
    expect(run.exchangeFeeIdr).toBe(66_625n); // Indodax commission 0.41% (fee + tax), rounded up
    expect(run.feeIdr).toBe(56_875n); // Mopay 0.35% of gross, rounded up
    expect(run.idrAmount).toBe(16_126_500n); // gross − exchange commission − Mopay fee
    expect(run.exchangeOrderId).toMatch(/^mp[0-9a-f]{32}$/); // deterministic newClientOrderId
    expect(run.priceSource).toBe('fixed');

    const p = (await H.h.db.query.payouts.findFirst({ where: eq(payouts.depositId, d.id) }))!;
    expect(p).toMatchObject({
      status: 'success',
      amountIdr: 16_126_500n,
      idempotencyKey: `${d.workflowId}:payout`,
    });

    const ledger = await H.h.db.select().from(ledgerEntries).where(eq(ledgerEntries.depositId, d.id));
    const bal = (acct: string, cur: string) =>
      ledger
        .filter((l) => l.account === acct && l.currency === cur)
        .reduce((a, l) => a + l.debit - l.credit, 0n);
    expect(bal('client_usdt_liability', 'USDT')).toBe(0n);
    expect(bal('exchange_usdt', 'USDT')).toBe(0n);
    expect(bal('client_idr_payable', 'IDR')).toBe(0n);
    expect(bal('fee_revenue', 'IDR')).toBe(-56_875n);
    expect(bal('exchange_idr', 'IDR')).toBe(16_183_375n); // IDR credited at Indodax
    expect(bal('bank_out', 'IDR')).toBe(-16_126_500n);

    const events = await H.h.db.select().from(offrampStepEvents).where(eq(offrampStepEvents.depositId, d.id));
    const succeeded = new Set(events.filter((e) => e.kind === 'succeeded').map((e) => e.step));
    for (const s of [
      'load-deposit',
      'record-received',
      'wait-exchange-credit',
      'lock-quote',
      'confirm-swap',
      'record-swap',
      'account-inquiry',
      'create-payout',
      'finalize',
    ] as const) {
      expect(succeeded.has(s)).toBe(true);
    }
    expect((await H.invariants()).unbalancedJournals).toBe(0);
  });

  it('ACCEPTANCE: 100 deposits with FAIL_RATE=0.3 on both mocks (plus lost responses, timeouts, duplicate/dropped callbacks and duplicate dispatches) all complete exactly once', async () => {
    const before = await H.invariants();
    H.exchangeChaos.update({ FAIL_RATE: 0.3, FAIL_AFTER_RATE: 0.1, TIMEOUT_RATE: 0.03, TIMEOUT_MS: 2000 });
    H.bifastChaos.update({
      FAIL_RATE: 0.3,
      FAIL_AFTER_RATE: 0.1,
      DUPLICATE_CALLBACK_RATE: 0.3,
      DROP_CALLBACK_RATE: 0.1,
    });
    const ds = [];
    for (let i = 0; i < 100; i++) ds.push(await H.createDeposit(i, BigInt(1_000_000 * (10 + i))));
    await Promise.all(ds.map((d) => H.submit(d.workflowId, d.id)));
    // duplicate dispatch for 20 of them (indexer crash between submit and DB update)
    const dup = await Promise.all(ds.slice(0, 20).map((d) => H.submit(d.workflowId, d.id)));
    expect(dup.every((r) => r.status === 'PreviouslyAccepted')).toBe(true);

    const finals = await Promise.all(ds.map((d) => done(d.id)));
    expect(finals.filter((f) => f.status !== 'completed').map((f) => f.statusReason)).toEqual([]);

    const after = await H.invariants();
    log.info(
      { before, after, exchangeChaos: H.exchangeChaos.stats, bifastChaos: H.bifastChaos.stats },
      'acceptance',
    );
    expect(after.unbalancedJournals).toBe(0);
    expect(after.completed - before.completed).toBe(100);
    expect(after.payouts - before.payouts).toBe(100);
    expect(after.payoutsSuccess).toBe(after.completed); // count(payouts) = count(completed)
    expect(after.exchangeOrders - before.exchangeOrders).toBe(100); // exactly one sell per deposit
    expect(after.exchangeOrders).toBe(after.runsWithSell);
    expect(after.bifastTransfers).toBe(after.bifastDistinctKeys); // one transfer per idempotency key
    expect(after.bifastTransfers - before.bifastTransfers).toBe(100);
    // chaos actually happened
    expect(H.exchangeChaos.stats.failedBefore).toBeGreaterThan(10);
    expect(H.exchangeChaos.stats.failedAfter).toBeGreaterThan(0);
    expect(H.bifastChaos.stats.failedBefore).toBeGreaterThan(10);
    const retries = await H.h.db
      .select({ n: sql<number>`count(*)::int` })
      .from(offrampStepEvents)
      .where(eq(offrampStepEvents.kind, 'retrying'));
    expect(Number(retries[0]!.n)).toBeGreaterThan(30);
  });

  it('REGRESSION: a workflow that starts before the outbox marks the deposit dispatched still completes', async () => {
    const d = await H.createDeposit(0, 5_000_000n);
    // simulate the race: Restate runs the workflow while the deposit is still `confirmed`
    await H.h.db.execute(sql`ALTER TABLE deposits DISABLE TRIGGER deposits_transition_guard_trg`);
    await H.h.db.update(deposits).set({ status: 'confirmed' }).where(eq(deposits.id, d.id));
    await H.h.db.execute(sql`ALTER TABLE deposits ENABLE TRIGGER deposits_transition_guard_trg`);
    await H.submit(d.workflowId, d.id);
    const final = await done(d.id);
    expect(final.status).toBe('completed');
  });

  it('refuses to process a deposit that is not final (seen) or was reorged (orphaned)', async () => {
    for (const status of ['seen', 'orphaned'] as const) {
      const d = await H.createDeposit(0, 5_000_000n);
      await H.h.db.execute(sql`ALTER TABLE deposits DISABLE TRIGGER deposits_transition_guard_trg`);
      await H.h.db.update(deposits).set({ status }).where(eq(deposits.id, d.id));
      await H.h.db.execute(sql`ALTER TABLE deposits ENABLE TRIGGER deposits_transition_guard_trg`);
      await H.submit(d.workflowId, d.id);
      await waitFor(async () => {
        const r = await H.h.db.query.offrampStepEvents.findFirst({
          where: and(eq(offrampStepEvents.depositId, d.id), eq(offrampStepEvents.kind, 'failed')),
        });
        return r;
      });
      expect((await statusOf(d.id)).status).toBe(status); // untouched
      expect(await H.h.db.query.payouts.findFirst({ where: eq(payouts.depositId, d.id) })).toBeUndefined();
    }
  });

  it('killing the workflow service in the middle of confirm-swap resumes from the journal without a second swap', async () => {
    const ordersBefore = exchangeOrders();
    H.confirmDelayMs = 1500;
    const d = await H.createDeposit(1, 50_000_000n);
    await H.submit(d.workflowId, d.id);
    await waitFor(
      async () => {
        const r = await H.h.db.query.offrampRuns.findFirst({ where: eq(offrampRuns.depositId, d.id) });
        return r?.step === 'confirm-swap';
      },
      60_000,
      20,
    );
    await H.killWorkflow(); // crash while the exchange is executing the sell
    await new Promise((r) => setTimeout(r, 2500));
    H.confirmDelayMs = 0;
    H.startWorkflow(); // restart: Restate re-invokes and replays the journal
    const final = await done(d.id);
    expect(final.status).toBe('completed');
    expect(exchangeOrders() - ordersBefore).toBe(1);
    const locks = await H.h.db
      .select({ n: sql<number>`count(*)::int` })
      .from(offrampStepEvents)
      .where(
        and(
          eq(offrampStepEvents.depositId, d.id),
          eq(offrampStepEvents.step, 'lock-quote'),
          eq(offrampStepEvents.kind, 'succeeded'),
        ),
      );
    expect(Number(locks[0]!.n)).toBe(1); // journaled: the quote was not re-locked after the crash
  });

  it('orders that are not yet visible and lost order responses are reconciled by clientOrderId: one sell, completed', async () => {
    const ordersBefore = exchangeOrders();
    H.exchangeDeps.orderVisibilityDelayMs = 2500; // docs: an order may not be immediately available
    H.exchangeChaos.update({ FAIL_AFTER_RATE: 0.5 }); // half of all responses are lost after processing
    const d = await H.createDeposit(0, 20_000_000n);
    await H.submit(d.workflowId, d.id);
    const final = await done(d.id);
    expect(final.status).toBe('completed');
    expect(exchangeOrders() - ordersBefore).toBe(1);
  });

  it('a final bank reject (ACCOUNT_CLOSED) is not retried; funds stay in client_idr_payable; manual_review', async () => {
    const d = await H.createDeposit(0, 10_000_000n);
    const acct = await bankOf(d.id);
    const original = { ...acct };
    await H.h.db
      .update(clientBankAccounts)
      .set({ bankCode: '002', accountNumber: '9990000001', accountName: 'PT TUTUP BUKU SELAMANYA' })
      .where(eq(clientBankAccounts.id, acct.id));
    try {
      await H.submit(d.workflowId, d.id);
      const final = await done(d.id);
      expect(final.status).toBe('manual_review');
      expect(final.statusReason).toMatch(/BANK_REJECTED: ACCOUNT_CLOSED/);
      const p = (await H.h.db.query.payouts.findFirst({ where: eq(payouts.depositId, d.id) }))!;
      expect(p.status).toBe('failed');
      const n = H.bifastDb
        .prepare('SELECT count(*) AS n FROM transfers WHERE idempotency_key = ?')
        .get(p.idempotencyKey) as { n: number };
      expect(n.n).toBe(1);
      const payable = await H.h.db
        .select({ v: sql<string>`(sum(credit) - sum(debit))::text` })
        .from(ledgerEntries)
        .where(and(eq(ledgerEntries.depositId, d.id), eq(ledgerEntries.account, 'client_idr_payable')));
      expect(BigInt(payable[0]!.v)).toBe(p.amountIdr);
    } finally {
      await H.h.db
        .update(clientBankAccounts)
        .set({
          bankCode: original.bankCode,
          accountNumber: original.accountNumber,
          accountName: original.accountName,
        })
        .where(eq(clientBankAccounts.id, acct.id));
    }
  });

  it('account name mismatch stops before any payout', async () => {
    const d = await H.createDeposit(1, 10_000_000n);
    const acct = await bankOf(d.id);
    await H.h.db
      .update(clientBankAccounts)
      .set({ accountName: 'SOMEONE ELSE' })
      .where(eq(clientBankAccounts.id, acct.id));
    try {
      await H.submit(d.workflowId, d.id);
      const final = await done(d.id);
      expect(final.status).toBe('manual_review');
      expect(final.statusReason).toMatch(/ACCOUNT_NAME_MISMATCH/);
      expect(await H.h.db.query.payouts.findFirst({ where: eq(payouts.depositId, d.id) })).toBeUndefined();
    } finally {
      await H.h.db
        .update(clientBankAccounts)
        .set({ accountName: acct.accountName })
        .where(eq(clientBankAccounts.id, acct.id));
    }
  });
});

describe('BI-FAST webhook handling', () => {
  const deps = () => ({
    db: H.h.db,
    webhookSecret: 'test-webhook-secret',
    resolveAwakeable: async () => {
      resolved++;
    },
    log,
  });
  let resolved = 0;

  it('rejects an invalid signature without changing state', async () => {
    const before = await H.h.db.select().from(payouts);
    const body = JSON.stringify({ transferId: 'bf_x', idempotencyKey: 'k', status: 'success' });
    const r = await handleBifastCallback(deps(), body, hmacHex('wrong-secret', body));
    expect(r.http).toBe(401);
    expect(await H.h.db.select().from(payouts)).toEqual(before);
    const ev = await H.h.db.select().from(webhookEvents).where(eq(webhookEvents.signatureValid, false));
    expect(ev.length).toBeGreaterThan(0);
  });

  it('dedups duplicate callbacks (transferId + status)', async () => {
    const p = (await H.h.db.select().from(payouts).where(eq(payouts.status, 'success')).limit(1))[0]!;
    const body = JSON.stringify({
      transferId: p.bifastRef,
      idempotencyKey: p.idempotencyKey,
      status: 'success',
    });
    resolved = 0;
    const r1 = await handleBifastCallback(deps(), body, hmacHex('test-webhook-secret', body));
    const r2 = await handleBifastCallback(deps(), body, hmacHex('test-webhook-secret', body));
    expect(r1.http).toBe(200);
    expect(r2).toEqual({ http: 200, body: { ok: true, duplicate: true } });
    expect(resolved).toBeLessThanOrEqual(1);
  });

  it('rejects a callback whose transferId does not match the payout', async () => {
    const p = (await H.h.db.select().from(payouts).where(eq(payouts.status, 'success')).limit(1))[0]!;
    const body = JSON.stringify({
      transferId: 'bf_forged',
      idempotencyKey: p.idempotencyKey,
      status: 'failed',
    });
    const r = await handleBifastCallback(deps(), body, hmacHex('test-webhook-secret', body));
    expect(r.http).toBe(400);
  });
});
