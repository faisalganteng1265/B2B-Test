import * as restate from '@restatedev/restate-sdk';
import { createDb } from '@mopay/db';
import { BifastClient, createLogger, MobeeClient } from '@mopay/shared';
import { loadWorkflowEnv, offrampConfigFromEnv } from './config';
import { createOfframpWorkflow } from './offramp';

const env = loadWorkflowEnv();
const log = createLogger('workflow', env.LOG_LEVEL);
// Stateless service: all durable state lives in Restate (journal) and Postgres. Run N replicas.
const db = createDb(env.DATABASE_URL, { max: 20, appName: 'workflow' });
const offramp = createOfframpWorkflow({
  db: db.db,
  mobee: new MobeeClient({
    baseUrl: env.MOBEE_URL,
    apiKey: env.MOBEE_API_KEY,
    apiSecret: env.MOBEE_API_SECRET,
    timeoutMs: env.UPSTREAM_TIMEOUT_MS,
  }),
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
