/** System invariants — must ALWAYS hold, whatever crashed or was retried.  tsx scripts/invariants.ts */
import { sql } from 'drizzle-orm';
import { createDb, findUnbalancedJournals } from '@mopay/db';
import { c, env } from './lib/common';

const h = createDb(env.DATABASE_URL, { max: 2, appName: 'invariants' });
const q = async <T extends Record<string, unknown>>(s: ReturnType<typeof sql>) =>
  (await h.db.execute<T>(s)) as unknown as T[];
const one = async (s: ReturnType<typeof sql>) => Number(Object.values((await q(s))[0] ?? { n: 0 })[0]);
const getJson = async (url: string) => {
  try {
    const r = await fetch(url, {
      headers: { 'x-admin-token': env.ADMIN_TOKEN },
      signal: AbortSignal.timeout(5000),
    });
    return (await r.json()) as Record<string, number>;
  } catch {
    return null;
  }
};

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: string) => results.push({ name, ok, detail });

const unbalanced = await findUnbalancedJournals(h.db);
check(
  'Ledger: every journal balances per currency',
  unbalanced.length === 0,
  `${unbalanced.length} unbalanced`,
);

const dupPayouts = await one(
  sql`SELECT count(*) FROM (SELECT deposit_id FROM payouts GROUP BY deposit_id HAVING count(*) > 1) x`,
);
check('At most one payout per deposit', dupPayouts === 0, `${dupPayouts} deposits with >1 payout`);

const completed = await one(sql`SELECT count(*) FROM deposits WHERE status = 'completed'`);
const paid = await one(sql`SELECT count(*) FROM payouts WHERE status = 'success'`);
check(
  'count(successful payouts) = count(completed deposits)',
  completed === paid,
  `${paid} payouts, ${completed} completed`,
);

const orphanTouched = await one(
  sql`SELECT count(*) FROM deposits d WHERE d.status = 'orphaned' AND (EXISTS (SELECT 1 FROM payouts p WHERE p.deposit_id = d.id) OR EXISTS (SELECT 1 FROM offramp_runs r WHERE r.deposit_id = d.id))`,
);
check(
  'Reorged (orphaned) deposits never started a workflow or payout',
  orphanTouched === 0,
  `${orphanTouched} violations`,
);

const noWorkflow = await one(
  sql`SELECT count(*) FROM deposits d WHERE d.status IN ('dispatched','completed') AND d.dispatched_at < now() - interval '2 minutes' AND NOT EXISTS (SELECT 1 FROM offramp_runs r WHERE r.deposit_id = d.id)`,
);
check(
  'Every dispatched deposit has a workflow run',
  noWorkflow === 0,
  `${noWorkflow} dispatched >2 min ago without a run`,
);

const stuckOutbox = await one(
  sql`SELECT count(*) FROM deposits WHERE status = 'confirmed' AND confirmed_at < now() - interval '5 minutes'`,
);
check('Outbox drains (no confirmed deposit stuck > 5 min)', stuckOutbox === 0, `${stuckOutbox} stuck`);

const swapsInDb = await one(sql`SELECT count(*) FROM offramp_runs WHERE exchange_order_id IS NOT NULL`);
const dupSellIds = await one(
  sql`SELECT count(*) FROM (SELECT exchange_order_id FROM offramp_runs WHERE exchange_order_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1) x`,
);
check(
  'Exchange: one sell order id per deposit (deterministic newClientOrderId)',
  dupSellIds === 0,
  `${dupSellIds} shared ids`,
);
const exchange = await getJson(`${env.INDODAX_URL}/__state`);
if (exchange) {
  // the exchange enforces UNIQUE(newClientOrderId), so equal counts = exactly one sell per swapped deposit
  check(
    'Exchange: exactly one sell per swapped deposit',
    exchange.orders === swapsInDb,
    `${exchange.orders} orders at Indodax, ${swapsInDb} deposits sold`,
  );
} else check('Exchange state reachable', false, 'indodax-mock /__state unreachable');

const unattributedTouched = await one(
  sql`SELECT count(*) FROM deposits d WHERE d.client_id IS NULL AND (d.status NOT IN ('seen','orphaned','manual_review') OR EXISTS (SELECT 1 FROM offramp_runs r WHERE r.deposit_id = d.id))`,
);
check(
  'Deposits from unregistered wallets are never processed',
  unattributedTouched === 0,
  `${unattributedTouched} violations`,
);

const payouts = await one(sql`SELECT count(*) FROM payouts WHERE bifast_ref IS NOT NULL`);
const bifast = await getJson(`${env.BIFAST_URL}/__state`);
if (bifast) {
  check(
    'BI-FAST: one transfer per idempotency key',
    bifast.transfers === bifast.keys,
    `${bifast.transfers} transfers, ${bifast.keys} keys`,
  );
  check(
    'BI-FAST: transfers = payouts sent',
    bifast.transfers === payouts,
    `${bifast.transfers} transfers, ${payouts} payouts`,
  );
} else check('BI-FAST state reachable', false, 'bifast-mock /__state unreachable');

const incidents = await one(sql`SELECT count(*) FROM deposits WHERE status_reason LIKE 'INCIDENT%'`);
check('No reorg incidents (reorg after confirmation)', incidents === 0, `${incidents} incidents`);

await h.close();
console.log(c.bold('\nMopay invariants\n'));
for (const r of results)
  console.log(`  ${r.ok ? c.green('✔') : c.red('✘')} ${r.name.padEnd(62)} ${c.dim(r.detail)}`);
const failed = results.filter((r) => !r.ok).length;
console.log(
  failed
    ? c.red(`\n${failed} invariant(s) violated\n`)
    : c.green(`\nall ${results.length} invariants hold\n`),
);
process.exit(failed ? 1 : 0);
