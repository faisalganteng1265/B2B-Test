/**
 * Catch-up demo on a SIMULATED chain, exactly as the spec describes: indexer down → 50 deposits →
 * 5,000 blocks mined → restart. Live jumps to the finalized boundary and keeps detecting new deposits
 * within ~1 s while parallel backfill workers (SKIP LOCKED) chew through the gap with a range-limited,
 * slow RPC. Everything processed exactly once.
 */
import { SimChain } from '@mopay/indexer';
import { c } from './lib/common';
import { ADDR, byTx, LoggingDispatcher, simDb, simIndexer, sleep, until, USDT, WALLET } from './lib/sim';

const h = await simDb();
const sim = new SimChain({ maxRange: 500, rangeLatencyMs: 300 });
sim.mine(10);
const disp = new LoggingDispatcher();
disp.dispatch = async (wf: string) => {
  disp.calls.set(wf, (disp.calls.get(wf) ?? 0) + 1);
  return 'accepted';
};
let idx = simIndexer(sim, h, disp, { chunkSize: 1000 });
await idx.init();
idx.start();
await until(async () => (await idx.store.getCheckpoint())!.liveHeadNumber === sim.head);
console.log(
  c.bold('indexer is live at block ' + sim.head + ' — now stopping it (simulating 1 hour of downtime)'),
);
await idx.stop();

const missed: string[] = [];
for (let i = 0; i < 50; i++) {
  missed.push(sim.transfer(USDT, WALLET, i % 2 ? ADDR.A : ADDR.B, BigInt(1_000_000 * (10 + i))));
  sim.mine(80);
}
sim.mine(1000);
console.log(
  `while down: ${c.yellow('50 deposits')} sent, chain advanced ${c.yellow('5,000 blocks')} to ${sim.head}`,
);

idx = simIndexer(sim, h, disp, { chunkSize: 1000, concurrency: 4 });
await idx.init();
const t0 = Date.now();
idx.start();
await until(async () => (await idx.store.getCheckpoint())!.liveHeadNumber >= sim.head - 12);
console.log(
  `\n${c.bold('restart')}: live jumped to the finalized boundary in ${Date.now() - t0} ms; gap queued as backfill chunks`,
);

const liveTx = sim.transfer(USDT, WALLET, ADDR.A, 999_000_000n);
const tLive = Date.now();
sim.mine(1);
await until(() => byTx(h, liveTx), 5000);
const p0 = await idx.store.backfillProgress();
console.log(
  `new deposit during catch-up detected by ${c.green('live')} in ${c.green(`${Date.now() - tLive} ms`)} — backfill at ${p0.done}/${p0.total} chunks`,
);
sim.mine(13);

for (;;) {
  const p = await idx.store.backfillProgress();
  const ds = await h.db.query.deposits.findMany();
  const disp_ = ds.filter((d) => d.status === 'dispatched').length;
  const bar = '█'.repeat(Math.round((p.done / Math.max(1, p.total)) * 30)).padEnd(30, '░');
  process.stdout.write(
    `\r  backfill ${bar} ${p.done}/${p.total} chunks · ${ds.length} deposits found · ${disp_} dispatched · rpc range splits ${sim.calls.rangeRejected}   `,
  );
  if (p.done === p.total && disp_ === 51) break;
  await sleep(250);
}
const dupes = [...disp.calls.values()].filter((n) => n > 1).length;
console.log(
  `\n\n${c.green('✔')} all ${missed.length} missed + 1 live deposit processed in ${((Date.now() - t0) / 1000).toFixed(1)} s; duplicate dispatches: ${dupes}`,
);
await idx.stop();
await h.close();
process.exit(0);
