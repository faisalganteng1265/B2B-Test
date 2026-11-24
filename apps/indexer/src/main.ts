import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { z } from 'zod';
import { CHAINS, envFields, loadDeployment, loadEnv } from '@mopay/config';
import { createDb } from '@mopay/db';
import { createChainClient, createLogger } from '@mopay/shared';
import { RestateDispatcher } from './dispatcher';
import { Indexer } from './indexer';
import { LeaderLock } from './leader';
import { ViemChainSource } from './viem-source';

const env = loadEnv({
  CHAIN: envFields.CHAIN,
  RPC_URLS: envFields.RPC_URLS,
  DATABASE_URL: envFields.DATABASE_URL,
  RESTATE_INGRESS_URL: envFields.RESTATE_INGRESS_URL,
  LOG_LEVEL: envFields.LOG_LEVEL,
  PORT: z.coerce.number().default(4300),
  FINALITY_MODE: z.enum(['tag', 'distance']).optional(),
  FINALITY_TAG: z.enum(['safe', 'finalized']).optional(),
  LIVE_BATCH: z.coerce.number().int().min(1).max(200).default(25),
  REORG_SAFE_DISTANCE: z.coerce.number().int().min(1).optional(),
  START_BLOCK: z.coerce.number().int().optional(),
  POLL_MS: z.coerce.number().int().optional(),
  JUMP_THRESHOLD: z.coerce.number().int().default(3000),
  BACKFILL_CHUNK_SIZE: z.coerce.number().int().default(2000),
  BACKFILL_CONCURRENCY: z.coerce.number().int().default(4),
  READY_MAX_LAG: z.coerce.number().int().default(100),
});

const log = createLogger('indexer', env.LOG_LEVEL);
const chain = CHAINS[env.CHAIN];
const deployment = loadDeployment(chain.chainId);
const db = createDb(env.DATABASE_URL, { max: env.BACKFILL_CONCURRENCY + 6, appName: 'indexer' });
const src = new ViemChainSource(createChainClient(chain.chainId, env.RPC_URLS));

const indexer = new Indexer(
  src,
  db.db,
  new RestateDispatcher(env.RESTATE_INGRESS_URL),
  {
    chainId: chain.chainId,
    tokens: Object.fromEntries(Object.entries(deployment.tokens).map(([sym, a]) => [a.toLowerCase(), sym])),
    finality: {
      mode: env.FINALITY_MODE ?? chain.finality,
      tag: env.FINALITY_TAG ?? chain.finalityTag,
      reorgSafeDistance: env.REORG_SAFE_DISTANCE ?? chain.reorgSafeDistance,
    },
    startBlock: env.START_BLOCK ?? deployment.deployBlock,
    pollMs: env.POLL_MS ?? Math.max(250, Math.floor(chain.blockTimeMs / 2)),
    jumpThreshold: env.JUMP_THRESHOLD,
    liveBatch: env.LIVE_BATCH,
    chunkSize: env.BACKFILL_CHUNK_SIZE,
    concurrency: env.BACKFILL_CONCURRENCY,
  },
  log,
);
const leader = new LeaderLock(db.sql, `mopay-indexer-live:${chain.chainId}`, log);
indexer.isLeader = leader.isLeader;

const app = new Hono();
app.get('/healthz', (c) => c.json({ ok: true }));
app.get('/readyz', async (c) => {
  const cp = await indexer.store.getCheckpoint();
  const lag = cp?.chainHead ? cp.chainHead - cp.liveHeadNumber : null;
  const stale = cp ? Date.now() - cp.updatedAt.getTime() > 60_000 : true;
  const ready = !!cp && lag !== null && lag <= env.READY_MAX_LAG && !stale;
  return c.json({ ready, leader: leader.isLeader(), lag, updatedAt: cp?.updatedAt }, ready ? 200 : 503);
});
app.get('/metrics', async (c) =>
  c.text(await indexer.metrics.registry.metrics(), 200, {
    'content-type': indexer.metrics.registry.contentType,
  }),
);
app.get('/status', async (c) =>
  c.json({ leader: leader.isLeader(), chain: chain.name, ...(await indexer.status()) }),
);

await indexer.init();
await leader.start();
indexer.start();
const server = serve({ fetch: app.fetch, port: env.PORT }, (i) =>
  log.info(
    { port: i.port, chain: chain.name, startBlock: indexer.o.startBlock, finality: indexer.o.finality },
    'indexer running',
  ),
);

let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ sig }, 'graceful shutdown: finishing in-flight batches, releasing leases');
    server.close();
    await indexer.stop();
    await leader.stop();
    await db.close();
    process.exit(0);
  });
