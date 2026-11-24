import { serve } from '@hono/node-server';
import * as clients from '@restatedev/restate-sdk-clients';
import { CHAINS, loadDeployment } from '@mopay/config';
import { createDb } from '@mopay/db';
import { createLogger, MobeeClient } from '@mopay/shared';
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
  mobee: new MobeeClient({
    baseUrl: env.MOBEE_URL,
    apiKey: env.MOBEE_API_KEY,
    apiSecret: env.MOBEE_API_SECRET,
    timeoutMs: 8000,
  }),
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
