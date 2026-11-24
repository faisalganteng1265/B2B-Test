import type { Context, MiddlewareHandler, Hono } from 'hono';
import { z } from 'zod';

/**
 * Failure injection for the mock upstreams. Values can come from env at boot and be changed
 * live via POST /__chaos (proxied by the Mopay admin API / dashboard).
 */
export const chaosConfigSchema = z.object({
  /** Reply 500 BEFORE processing the request. */
  FAIL_RATE: z.coerce.number().min(0).max(1).default(0),
  /** Process the request, THEN reply 500 (response lost: the nasty case for idempotency). */
  FAIL_AFTER_RATE: z.coerce.number().min(0).max(1).default(0),
  /** Process the request, then hold the response longer than the client timeout. */
  TIMEOUT_RATE: z.coerce.number().min(0).max(1).default(0),
  TIMEOUT_MS: z.coerce.number().int().min(0).default(15_000),
  LATENCY_MS_MIN: z.coerce.number().int().min(0).default(0),
  LATENCY_MS_MAX: z.coerce.number().int().min(0).default(0),
  /** BI-FAST: send the callback twice. */
  DUPLICATE_CALLBACK_RATE: z.coerce.number().min(0).max(1).default(0),
  /** BI-FAST: extra delay before the callback. */
  LATE_CALLBACK_MS: z.coerce.number().int().min(0).default(0),
  /** BI-FAST: never send the callback (forces reconciliation via GET /v1/transfers/:id). */
  DROP_CALLBACK_RATE: z.coerce.number().min(0).max(1).default(0),
  /** BI-FAST: probability a transfer fails finally at the bank (ACCOUNT_CLOSED / BANK_UNAVAILABLE). */
  FINAL_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0),
});
export type ChaosConfig = z.infer<typeof chaosConfigSchema>;

export interface ChaosStats {
  requests: number;
  failedBefore: number;
  failedAfter: number;
  timeouts: number;
}

export class Chaos {
  config: ChaosConfig;
  stats: ChaosStats = { requests: 0, failedBefore: 0, failedAfter: 0, timeouts: 0 };
  constructor(
    initial: Partial<ChaosConfig> = {},
    private readonly rand: () => number = Math.random,
  ) {
    this.config = chaosConfigSchema.parse(initial);
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env, rand?: () => number): Chaos {
    const picked = Object.fromEntries(
      Object.keys(chaosConfigSchema.shape)
        .filter((k) => env[k] !== undefined && env[k] !== '')
        .map((k) => [k, env[k]]),
    );
    return new Chaos(picked as Partial<ChaosConfig>, rand);
  }

  update(patch: Partial<ChaosConfig>) {
    this.config = chaosConfigSchema.parse({ ...this.config, ...patch });
  }

  roll(p: number): boolean {
    return p > 0 && this.rand() < p;
  }

  latency(): number {
    const { LATENCY_MS_MIN: a, LATENCY_MS_MAX: b } = this.config;
    if (b <= 0) return 0;
    return Math.floor(a + this.rand() * Math.max(0, b - a));
  }

  /** Middleware for API routes. */
  middleware(): MiddlewareHandler {
    return async (c, next) => {
      this.stats.requests++;
      const lat = this.latency();
      if (lat) await sleep(lat);
      if (this.roll(this.config.FAIL_RATE)) {
        this.stats.failedBefore++;
        return c.json(
          { error: { code: 'CHAOS_INJECTED', message: 'injected failure (before processing)' } },
          500,
        );
      }
      await next();
      // Only inject post-processing faults on successful mutating responses.
      if (c.res.status >= 400) return;
      if (this.roll(this.config.FAIL_AFTER_RATE)) {
        this.stats.failedAfter++;
        c.res = c.json(
          { error: { code: 'CHAOS_INJECTED', message: 'injected failure (after processing)' } },
          500,
        );
        return;
      }
      if (this.roll(this.config.TIMEOUT_RATE)) {
        this.stats.timeouts++;
        await sleep(this.config.TIMEOUT_MS);
      }
    };
  }

  /** Mount GET/POST /__chaos guarded by an admin token header. */
  mount(app: Hono, adminToken: string) {
    const guard = (c: Context) => c.req.header('x-admin-token') === adminToken;
    app.get('/__chaos', (c) => {
      if (!guard(c)) return c.json({ error: { code: 'UNAUTHORIZED' } }, 401);
      return c.json({ config: this.config, stats: this.stats });
    });
    app.post('/__chaos', async (c) => {
      if (!guard(c)) return c.json({ error: { code: 'UNAUTHORIZED' } }, 401);
      const body = chaosConfigSchema.partial().safeParse(await c.req.json().catch(() => ({})));
      if (!body.success) return c.json({ error: { code: 'VALIDATION', message: body.error.message } }, 400);
      this.update(body.data);
      return c.json({ config: this.config, stats: this.stats });
    });
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
