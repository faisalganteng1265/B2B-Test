import { z } from 'zod';
import { envFields, loadEnv } from '@mopay/config';
import type { OfframpConfig } from './offramp';

export function loadWorkflowEnv() {
  return loadEnv({
    DATABASE_URL: envFields.DATABASE_URL,
    MOBEE_URL: envFields.MOBEE_URL,
    MOBEE_API_KEY: envFields.MOBEE_API_KEY,
    MOBEE_API_SECRET: envFields.MOBEE_API_SECRET,
    BIFAST_URL: envFields.BIFAST_URL,
    BIFAST_API_KEY: envFields.BIFAST_API_KEY,
    RESTATE_ADMIN_URL: envFields.RESTATE_ADMIN_URL,
    LOG_LEVEL: envFields.LOG_LEVEL,
    WORKFLOW_PORT: z.coerce.number().default(9080),
    WORKFLOW_PUBLIC_URL: z.url().optional(),
    UPSTREAM_TIMEOUT_MS: z.coerce.number().int().default(8000),
    MIN_DEPOSIT_USDT_BASE_UNITS: z.coerce.bigint().default(1_000_000n),
    FEE_BPS: z.coerce.bigint().default(35n),
    MAX_QUOTE_ATTEMPTS: z.coerce.number().int().default(5),
    CREDIT_POLL_MS: z.coerce.number().int().default(2000),
    CREDIT_POLL_MAX_MS: z.coerce.number().int().default(15_000),
    PAYOUT_CALLBACK_TIMEOUT_MS: z.coerce.number().int().default(120_000),
    STEP_RETRY_INITIAL_MS: z.coerce.number().int().default(300),
    STEP_RETRY_MAX_MS: z.coerce.number().int().default(10_000),
    STEP_ALERT_AFTER_ATTEMPTS: z.coerce.number().int().default(10),
  });
}

export function offrampConfigFromEnv(env: ReturnType<typeof loadWorkflowEnv>): OfframpConfig {
  return {
    minAmountBaseUnits: env.MIN_DEPOSIT_USDT_BASE_UNITS,
    feeBps: env.FEE_BPS,
    maxQuoteAttempts: env.MAX_QUOTE_ATTEMPTS,
    creditPollMs: env.CREDIT_POLL_MS,
    creditPollMaxMs: env.CREDIT_POLL_MAX_MS,
    payoutCallbackTimeoutMs: env.PAYOUT_CALLBACK_TIMEOUT_MS,
    initialRetryIntervalMs: env.STEP_RETRY_INITIAL_MS,
    maxRetryIntervalMs: env.STEP_RETRY_MAX_MS,
    alertAfterAttempts: env.STEP_ALERT_AFTER_ATTEMPTS,
  };
}
