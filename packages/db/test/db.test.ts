import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { resetTestDb, type DbHandle, deposits, ledgerEntries, postJournal, findUnbalancedJournals } from '../src';
import { seed } from '../src/seed';

let h: DbHandle;
let clientId: string;

beforeAll(async () => {
  h = await resetTestDb();
  const created = await seed(h.db, 84532, async (s) => `0x${Buffer.from(s.padEnd(20, 'x')).toString('hex').slice(0, 40)}`);
  expect(created).toHaveLength(2);
  clientId = created[0]!.clientId;
});
afterAll(async () => h?.close());

async function insertDeposit(n: number) {
  const [d] = await h.db
    .insert(deposits)
    .values({
      chainId: 84532, tokenAddress: '0xt', tokenSymbol: 'USDT', txHash: `0x${n}`, logIndex: 0, blockNumber: n,
      blockHash: `0xb${n}`, fromAddress: '0xf', toAddress: '0xa', amountBaseUnits: 1_000_000n, clientId,
      source: 'live', workflowId: `84532:0x${n}:0`,
    })
    .returning();
  return d!;
}

describe('schema invariants', () => {
  it('seed is idempotent', async () => {
    const again = await seed(h.db, 84532, async () => '0x0');
    expect(again).toHaveLength(0);
  });

  it('dedups deposits on (chain, tx, logIndex)', async () => {
    await insertDeposit(1);
    const res = await h.db
      .insert(deposits)
      .values({ chainId: 84532, tokenAddress: '0xt', tokenSymbol: 'USDT', txHash: '0x1', logIndex: 0, blockNumber: 1, blockHash: '0xb1', fromAddress: '0xf', toAddress: '0xa', amountBaseUnits: 1n, clientId, source: 'backfill', workflowId: '84532:0x1:0' })
      .onConflictDoNothing()
      .returning();
    expect(res).toHaveLength(0);
  });

  it('forbids an orphaned deposit from ever being confirmed or dispatched', async () => {
    const d = await insertDeposit(2);
    await h.db.update(deposits).set({ status: 'orphaned' }).where(eq(deposits.id, d.id));
    await expect(h.db.update(deposits).set({ status: 'confirmed' }).where(eq(deposits.id, d.id))).rejects.toThrow();
    await expect(h.db.update(deposits).set({ status: 'dispatched' }).where(eq(deposits.id, d.id))).rejects.toThrow();
  });

  it('forbids skipping confirmation (seen -> dispatched)', async () => {
    const d = await insertDeposit(3);
    await expect(h.db.update(deposits).set({ status: 'dispatched' }).where(eq(deposits.id, d.id))).rejects.toThrow();
  });
});

describe('ledger', () => {
  it('posts a balanced journal exactly once', async () => {
    const d = await insertDeposit(10);
    const j = { id: `${d.id}:received`, kind: 'received', depositId: d.id, lines: [
      { account: 'exchange_usdt' as const, currency: 'USDT', debit: 5n },
      { account: 'client_usdt_liability' as const, currency: 'USDT', credit: 5n },
    ] };
    expect(await h.db.transaction((tx) => postJournal(tx, j))).toBe(true);
    expect(await h.db.transaction((tx) => postJournal(tx, j))).toBe(false);
    const rows = await h.db.select().from(ledgerEntries).where(eq(ledgerEntries.journalId, j.id));
    expect(rows).toHaveLength(2);
    expect((await findUnbalancedJournals(h.db)).length).toBe(0);
  });

  it('rejects unbalanced journals in the app layer', async () => {
    await expect(postJournal(h.db, { id: 'x', kind: 'x', lines: [{ account: 'exchange_usdt', currency: 'USDT', debit: 1n }] })).rejects.toThrow('unbalanced');
  });

  it('rejects unbalanced journals at the database layer (deferred trigger)', async () => {
    await expect(
      h.db.transaction(async (tx) => {
        await tx.execute(sql`INSERT INTO ledger_entries (journal_id, account, currency, debit, credit) VALUES ('raw', 'exchange_usdt', 'USDT', 7, 0)`);
      }),
    ).rejects.toThrow(/unbalanced journal/);
  });

  it('is append-only', async () => {
    const pgMessage = (p: Promise<unknown>) => p.then(() => 'ok', (e: Error) => String((e.cause as Error | undefined)?.message ?? e.message));
    expect(await pgMessage(h.db.execute(sql`UPDATE ledger_entries SET debit = 999 WHERE debit > 0`))).toMatch(/append-only/);
    expect(await pgMessage(h.db.execute(sql`DELETE FROM ledger_entries`))).toMatch(/append-only/);
  });
});
