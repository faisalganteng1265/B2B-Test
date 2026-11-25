import * as restate from '@restatedev/restate-sdk';
import { createDb } from '@mopay/db';
import { BifastClient, createLogger, IndodaxClient, PriceFeed } from '@mopay/shared';
import { loadWorkflowEnv, offrampConfigFromEnv } from './config';
import { createOfframpWorkflow } from './offramp';

const env = loadWorkflowEnv();
const log = createLogger('workflow', env.LOG_LEVEL);
// Stateless service: all durable state lives in Restate (journal) and Postgres. Run N replicas.
const db = createDb(env.DATABASE_URL, { max: 20, appName: 'workflow' });
const offramp = createOfframpWorkflow({
  db: db.db,
  indodax: new IndodaxClient({
    baseUrl: env.INDODAX_URL,
    apiKey: env.INDODAX_API_KEY,
    apiSecret: env.INDODAX_API_SECRET,
    timeoutMs: env.UPSTREAM_TIMEOUT_MS,
  }),
  priceFeed: new PriceFeed({ source: env.PRICE_SOURCE, fixedRate: env.PRICE_FIXED_RATE }),
  bifast: new BifastClient({
    baseUrl: env.BIFAST_URL,
    apiKey: env.BIFAST_API_KEY,
    timeoutMs: env.UPSTREAM_TIMEOUT_MS,
  }),
  cfg: offrampConfigFromEnv(env),
  log,
});

const port = await restate.serve({ services: [offramp], port: env.WORKFLOW_PORT });
log.info(
  { port },
  'offramp workflow endpoint listening (register with: pnpm --filter @mopay/workflow register)',
);
