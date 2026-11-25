import { serve } from '@hono/node-server';
import * as clients from '@restatedev/restate-sdk-clients';
import { CHAINS, loadDeployment } from '@mopay/config';
import { createDb } from '@mopay/db';
import { createLogger, IndodaxClient, PriceFeed } from '@mopay/shared';
import { restateAwakeableResolver } from '@mopay/workflow';
import { createApp } from './app';
import { loadApiEnv } from './env';
import { Notifier } from './notifier';

const env = loadApiEnv();
const log = createLogger('api', env.LOG_LEVEL);
const chain = CHAINS[env.CHAIN];
const deployment = loadDeployment(chain.chainId);
const db = createDb(env.DATABASE_URL, { max: 20, appName: 'api' });
const notifier = new Notifier(db.sql, log);
const ingress = clients.connect({ url: env.RESTATE_INGRESS_URL });
type OfframpDef = { run: (ctx: unknown, input: { depositId: string }) => Promise<unknown> };

const app = createApp({
  db: db.db,
  env,
  log,
  chainId: chain.chainId,
  chainName: chain.name,
  explorerTxUrl: chain.explorerTxUrl,
  tokens: deployment.tokens,
  indodax: new IndodaxClient({
    baseUrl: env.INDODAX_URL,
    apiKey: env.INDODAX_API_KEY,
    apiSecret: env.INDODAX_API_SECRET,
    timeoutMs: 8000,
  }),
  priceFeed: new PriceFeed({ source: env.PRICE_SOURCE, fixedRate: env.PRICE_FIXED_RATE }),
  notifier,
  resolveAwakeable: restateAwakeableResolver(env.RESTATE_INGRESS_URL),
  submitWorkflow: async (key, depositId) =>
    (
      await ingress
        .workflowClient<OfframpDef>({ name: 'offramp' } as clients.WorkflowDefinitionFrom<OfframpDef>, key)
        .workflowSubmit({ depositId })
    ).status,
});

await notifier.start();
const server = serve({ fetch: app.fetch, port: env.PORT }, (i) =>
  log.info({ port: i.port, chain: chain.name }, 'api listening (docs at /docs)'),
);
for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, () => {
    server.close();
    void db.close().finally(() => process.exit(0));
  });
