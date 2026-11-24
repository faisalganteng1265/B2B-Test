/**
 * Reorg demo on a SIMULATED chain (Base Sepolia cannot reorg on demand). Uses an isolated DB
 * (mopay_sim). Shows: a deposit in a block that gets reorged away becomes `orphaned` and is NEVER
 * dispatched; a tx re-included on the new branch is processed exactly once after finality.
 */
import { SimChain } from '@mopay/indexer';
import { c } from './lib/common';
import { ADDR, byTx, LoggingDispatcher, simDb, simIndexer, sleep, until, USDT, WALLET } from './lib/sim';

const step = (n: number, s: string) => console.log(`\n${c.bold(`${n}.`)} ${c.bold(s)}`);
const h = await simDb();
const sim = new SimChain();
sim.mine(20);
const disp = new LoggingDispatcher();
const idx = simIndexer(sim, h, disp);
await idx.init();
idx.start();
const head = async () => (await idx.store.getCheckpoint())!;

step(1, `Indexer follows the chain (reorg safe distance = 12 blocks)`);
await until(async () => (await head()).liveHeadNumber === sim.head);
console.log(`   live head = ${sim.head}`);

step(2, 'Client A deposits 500 USDT and client B 750 USDT — both mined in the next block');
const txA = sim.transfer(USDT, WALLET, ADDR.A, 500_000_000n);
const txB = sim.transfer(USDT, WALLET, ADDR.B, 750_000_000n);
const blk = sim.mine(1);
await until(async () => (await byTx(h, txA))?.status === 'seen');
console.log(
  `   block ${blk.number} ${c.dim(blk.hash.slice(0, 18))}…  →  both deposits ${c.yellow('seen')} (not final yet)`,
);
sim.mine(3);
await until(async () => (await head()).liveHeadNumber === sim.head);

step(3, 'REORG: the last 4 blocks are replaced by a longer competing branch that does not contain either tx');
const { dropped } = sim.reorg(4, { extra: 1 });
console.log(`   replaced ${dropped.length} blocks: ${dropped.map((x) => x.slice(0, 10)).join(', ')}`);
await until(async () => (await byTx(h, txA))?.status === 'orphaned');
const cp = await head();
console.log(
  `   indexer: parent-hash mismatch → walked back to common ancestor → rolled back ${c.yellow(String(cp.lastReorgDepth))} blocks in one DB transaction`,
);
await until(async () => (await byTx(h, txB))?.status === 'orphaned');
console.log(`   deposit A: ${c.red('orphaned')}   deposit B: ${c.red('orphaned')}`);

step(4, 'Mine 30 more blocks — well past finality');
sim.mine(30);
await until(async () => (await head()).liveHeadNumber === sim.head);
await sleep(1500);
const a = (await byTx(h, txA))!;
console.log(`   deposit A status: ${c.red(a.status)}  reason: ${c.dim(a.statusReason ?? '')}`);
const b = (await byTx(h, txB))!;
console.log(`   deposit B status: ${c.red(b.status)}`);
console.log(
  `   workflows dispatched for A and B: ${(disp.calls.get(a.workflowId) ?? 0) + (disp.calls.get(b.workflowId) ?? 0)}  ${c.green('✔ never processed, never paid')}`,
);

step(5, 'Re-inclusion: a tx dropped by a reorg but re-mined on the new branch');
const txC = sim.transfer(USDT, WALLET, ADDR.A, 1_000_000_000n);
sim.mine(2);
await until(async () => (await byTx(h, txC))?.status === 'seen');
const before = (await byTx(h, txC))!.blockHash;
sim.reorg(2, { reinclude: true });
await until(async () => {
  const d = await byTx(h, txC);
  return d?.status === 'seen' && d.blockHash !== before;
});
console.log(
  `   deposit C moved to the new block ${c.dim((await byTx(h, txC))!.blockHash.slice(0, 18))}…, still ${c.yellow('seen')}: must become final again`,
);
sim.mine(14);
await until(async () => (await byTx(h, txC))?.status === 'dispatched');
const cWf = (await byTx(h, txC))!.workflowId;
console.log(
  `   deposit C: ${c.green('confirmed → dispatched')} exactly ${disp.calls.get(cWf)}× (same deterministic workflow id)`,
);

const s = await idx.status();
console.log(
  `\n${c.bold('Result')}: reorgs detected = ${s.checkpoint!.reorgsDetected}, deposits = ${JSON.stringify(s.deposits)}`,
);
await idx.stop();
await h.close();
process.exit(0);
