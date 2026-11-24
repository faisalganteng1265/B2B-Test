import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { z } from 'zod';
import type { Hex } from 'viem';
import { CHAINS, envFields, loadDeployment, loadEnv, repoRoot } from '@mopay/config';
import { Chaos, createChainClient, createLogger, PriceFeed } from '@mopay/shared';
import { createMobeeApp } from './app';
import { MobeeStore } from './store';

const env = loadEnv({
  CHAIN: envFields.CHAIN,
  RPC_URLS: envFields.RPC_URLS,
  MOBEE_API_KEY: envFields.MOBEE_API_KEY,
  MOBEE_API_SECRET: envFields.MOBEE_API_SECRET,
  ADMIN_TOKEN: envFields.ADMIN_TOKEN,
  LOG_LEVEL: envFields.LOG_LEVEL,
  PORT: z.coerce.number().default(4100),
  MOBEE_DB_PATH: z.string().default(join(repoRoot(), 'data', 'mobee.sqlite')),
  PRICE_SOURCE: z.enum(['indodax', 'fixed']).default('indodax'),
  PRICE_FIXED_RATE: z.string().default('16500'),
  PRICE_CACHE_MS: z.coerce.number().int().min(3000).max(5000).default(4000),
  PRICE_MAX_STALE_MS: z.coerce.number().int().default(60_000),
  MOBEE_MIN_CONFIRMATIONS: z.coerce.number().int().default(3),
  MOBEE_CREDIT_DELAY_MS_MIN: z.coerce.number().int().default(1000),
  MOBEE_CREDIT_DELAY_MS_MAX: z.coerce.number().int().default(5000),
  QUOTE_TTL_MS: z.coerce.number().int().default(30_000),
});

const log = createLogger('mobee-mock', env.LOG_LEVEL);
const chain = CHAINS[env.CHAIN];
const deployment = loadDeployment(chain.chainId);
const client = createChainClient(chain.chainId, env.RPC_URLS);
const chaos = Chaos.fromEnv();

const app = createMobeeApp({
  store: new MobeeStore(env.MOBEE_DB_PATH),
  priceFeed: new PriceFeed({
    source: env.PRICE_SOURCE,
    fixedRate: env.PRICE_FIXED_RATE,
    cacheMs: env.PRICE_CACHE_MS,
    maxStaleMs: env.PRICE_MAX_STALE_MS,
  }),
  chain: {
    getReceipt: async (hash: Hex) => {
      try {
        const r = await client.getTransactionReceipt({ hash });
        return {
          status: r.status,
          blockNumber: r.blockNumber,
          logs: r.logs.map((l) => ({
            address: l.address,
            topics: l.topics,
            data: l.data,
            logIndex: l.logIndex,
          })),
        };
      } catch (e) {
        if (e instanceof Error && e.name === 'TransactionReceiptNotFoundError') return null;
        throw e;
      }
    },
    getBlockNumber: () => client.getBlockNumber({ cacheTime: 1000 }),
  },
  chaos,
  apiKey: env.MOBEE_API_KEY,
  apiSecret: env.MOBEE_API_SECRET,
  adminToken: env.ADMIN_TOKEN,
  tokens: Object.fromEntries(
    Object.entries(deployment.tokens).map(([sym, addr]) => [addr.toLowerCase(), sym]),
  ),
  chainId: chain.chainId,
  minConfirmations: env.MOBEE_MIN_CONFIRMATIONS,
  creditDelayMs: [env.MOBEE_CREDIT_DELAY_MS_MIN, env.MOBEE_CREDIT_DELAY_MS_MAX],
  quoteTtlMs: env.QUOTE_TTL_MS,
  log,
});

const server = serve({ fetch: app.fetch, port: env.PORT }, (i) =>
  log.info({ port: i.port, priceSource: env.PRICE_SOURCE, chaos: chaos.config }, 'mobee-mock listening'),
);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => server.close(() => process.exit(0)));
