import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { z } from 'zod';
import { envFields, loadEnv, repoRoot } from '@mopay/config';
import { Chaos, createLogger } from '@mopay/shared';
import { createBifast } from './app';

const env = loadEnv({
  BIFAST_API_KEY: envFields.BIFAST_API_KEY,
  BIFAST_WEBHOOK_SECRET: envFields.BIFAST_WEBHOOK_SECRET,
  ADMIN_TOKEN: envFields.ADMIN_TOKEN,
  API_URL: envFields.API_URL,
  LOG_LEVEL: envFields.LOG_LEVEL,
  PORT: z.coerce.number().default(4200),
  BIFAST_DB_PATH: z.string().default(join(repoRoot(), 'data', 'bifast.sqlite')),
  BIFAST_CALLBACK_URL: z.url().optional(),
  BIFAST_SETTLE_MS_MIN: z.coerce.number().int().default(1500),
  BIFAST_SETTLE_MS_MAX: z.coerce.number().int().default(6000),
});

const log = createLogger('bifast-mock', env.LOG_LEVEL);
const chaos = Chaos.fromEnv();
const { app, tick } = createBifast({
  dbPath: env.BIFAST_DB_PATH,
  chaos,
  apiKey: env.BIFAST_API_KEY,
  adminToken: env.ADMIN_TOKEN,
  webhookSecret: env.BIFAST_WEBHOOK_SECRET,
  callbackUrl: env.BIFAST_CALLBACK_URL ?? `${env.API_URL}/webhooks/bifast`,
  settleMs: [env.BIFAST_SETTLE_MS_MIN, env.BIFAST_SETTLE_MS_MAX],
  log,
});

// The scheduler state lives in SQLite, so pending callbacks resume after a restart.
const timer = setInterval(() => void tick().catch((err) => log.error({ err }, 'tick failed')), 250);
const server = serve({ fetch: app.fetch, port: env.PORT }, (i) =>
  log.info({ port: i.port, chaos: chaos.config }, 'bifast-mock listening'),
);
for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, () => {
    clearInterval(timer);
    server.close(() => process.exit(0));
  });
