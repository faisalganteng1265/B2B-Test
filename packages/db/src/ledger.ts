import { sql } from 'drizzle-orm';
import { ledgerEntries, ledgerJournals } from './schema';
import type { DbOrTx } from './client';

export type LedgerAccount = (typeof ledgerEntries.$inferInsert)['account'];

export interface JournalLine {
  account: LedgerAccount;
  currency: string;
  debit?: bigint;
  credit?: bigint;
  memo?: string;
}

export interface Journal {
  /** Deterministic id, e.g. `${depositId}:received`. Posting the same id twice is a no-op. */
  id: string;
  kind: string;
  depositId?: string;
  lines: JournalLine[];
}

export function assertBalanced(lines: JournalLine[]): void {
  const sums = new Map<string, bigint>();
  for (const l of lines) {
    const d = l.debit ?? 0n;
    const c = l.credit ?? 0n;
    if (d < 0n || c < 0n || (d === 0n) === (c === 0n)) throw new Error(`invalid ledger line ${l.account}`);
    sums.set(l.currency, (sums.get(l.currency) ?? 0n) + d - c);
  }
  for (const [cur, s] of sums) if (s !== 0n) throw new Error(`journal unbalanced in ${cur}: ${s}`);
}

/**
 * Post a balanced journal exactly once. Must run inside a transaction so the journal header and
 * lines commit together (the deferred DB trigger re-checks balance at commit).
 * Returns true if posted now, false if it had already been posted.
 */
export async function postJournal(tx: DbOrTx, j: Journal): Promise<boolean> {
  assertBalanced(j.lines);
  const inserted = await tx
    .insert(ledgerJournals)
    .values({ id: j.id, kind: j.kind, depositId: j.depositId })
    .onConflictDoNothing()
    .returning({ id: ledgerJournals.id });
  if (inserted.length === 0) return false;
  await tx.insert(ledgerEntries).values(
    j.lines.map((l) => ({
      journalId: j.id,
      account: l.account,
      currency: l.currency,
      debit: l.debit ?? 0n,
      credit: l.credit ?? 0n,
      depositId: j.depositId,
      memo: l.memo,
    })),
  );
  return true;
}

/** Per-journal, per-currency imbalance (should always be empty). */
export async function findUnbalancedJournals(db: DbOrTx) {
  return db.execute<{ journal_id: string; currency: string; diff: string }>(sql`
    SELECT journal_id, currency, (sum(debit) - sum(credit))::text AS diff
    FROM ledger_entries GROUP BY journal_id, currency HAVING sum(debit) <> sum(credit)`);
}
