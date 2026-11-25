import { z } from 'zod';
import { envFields, loadEnv } from '@mopay/config';

export function loadApiEnv(source: NodeJS.ProcessEnv = process.env) {
  return loadEnv(
    {
      CHAIN: envFields.CHAIN,
      RPC_URLS: envFields.RPC_URLS,
      DATABASE_URL: envFields.DATABASE_URL,
      RESTATE_INGRESS_URL: envFields.RESTATE_INGRESS_URL,
      INDODAX_URL: envFields.INDODAX_URL,
      INDODAX_API_KEY: envFields.INDODAX_API_KEY,
      INDODAX_API_SECRET: envFields.INDODAX_API_SECRET,
      MOPAY_BANK_CODE: envFields.MOPAY_BANK_CODE,
      MOPAY_BANK_ACCOUNT: envFields.MOPAY_BANK_ACCOUNT,
      PRICE_SOURCE: z.enum(['indodax', 'fixed']).default('indodax'),
      PRICE_FIXED_RATE: z.string().default('16500'),
      /** estimate of the exchange's commission (fee + tax) used for indicative quotes */
      INDODAX_COMMISSION_BPS: z.coerce.bigint().default(41n),
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
