import { z } from 'zod';
import { envFields, loadEnv } from '@mopay/config';

export function loadApiEnv(source: NodeJS.ProcessEnv = process.env) {
  return loadEnv(
    {
      CHAIN: envFields.CHAIN,
      RPC_URLS: envFields.RPC_URLS,
      DATABASE_URL: envFields.DATABASE_URL,
      RESTATE_INGRESS_URL: envFields.RESTATE_INGRESS_URL,
      MOBEE_URL: envFields.MOBEE_URL,
      MOBEE_API_KEY: envFields.MOBEE_API_KEY,
      MOBEE_API_SECRET: envFields.MOBEE_API_SECRET,
      BIFAST_URL: envFields.BIFAST_URL,
      BIFAST_WEBHOOK_SECRET: envFields.BIFAST_WEBHOOK_SECRET,
      ADMIN_TOKEN: envFields.ADMIN_TOKEN,
      LOG_LEVEL: envFields.LOG_LEVEL,
      INDEXER_URL: z.url().default('http://localhost:4300'),
      PORT: z.coerce.number().default(4000),
      RATE_LIMIT_PER_MIN: z.coerce.number().int().default(120),
      FEE_BPS: z.coerce.bigint().default(35n),
      DEMO_TX_ENABLED: z
        .enum(['true', 'false'])
        .default('true')
        .transform((v) => v === 'true'),
      CLIENT_A_PRIVATE_KEY: z.string().optional(),
      CLIENT_B_PRIVATE_KEY: z.string().optional(),
    },
    source,
  );
}
export type ApiEnv = ReturnType<typeof loadApiEnv>;
