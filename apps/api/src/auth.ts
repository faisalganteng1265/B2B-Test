import type { MiddlewareHandler } from 'hono';
import { and, eq } from 'drizzle-orm';
import { clients, type Db } from '@mopay/db';
import { apiKeyPrefix, safeEqual, verifyApiKey } from '@mopay/shared';

export type Client = typeof clients.$inferSelect;
export type AuthEnv = { Variables: { client: Client } };

const unauthorized = { error: { code: 'UNAUTHORIZED', message: 'invalid or missing API key' } };

/** `Authorization: Bearer mpk_<prefix>_<secret>` → prefix lookup → salted sha256 compare. */
export function clientAuth(db: Db, rateLimitPerMin: number): MiddlewareHandler<AuthEnv> {
  const limiter = new TokenBucket(rateLimitPerMin);
  return async (c, next) => {
    const key = /^Bearer\s+(.+)$/.exec(c.req.header('authorization') ?? '')?.[1]?.trim();
    const prefix = key ? apiKeyPrefix(key) : null;
    if (!key || !prefix) return c.json(unauthorized, 401);
    const row = await db.query.clients.findFirst({ where: and(eq(clients.apiKeyPrefix, prefix)) });
    if (!row || !verifyApiKey(key, row.apiKeySalt, row.apiKeyHash)) return c.json(unauthorized, 401);
    if (row.status !== 'active')
      return c.json({ error: { code: 'CLIENT_SUSPENDED', message: 'client suspended' } }, 403);
    const rl = limiter.take(row.id);
    c.header('x-ratelimit-remaining', String(rl.remaining));
    if (!rl.ok) {
      c.header('retry-after', String(rl.retryAfterS));
      return c.json({ error: { code: 'RATE_LIMITED', message: 'too many requests' } }, 429);
    }
    c.set('client', row);
    await next();
  };
}

/** Admin endpoints: `X-Admin-Token` (or Bearer) equal to ADMIN_TOKEN (constant-time compare). */
export function adminAuth(token: string): MiddlewareHandler {
  return async (c, next) => {
    const given =
      c.req.header('x-admin-token') ?? /^Bearer\s+(.+)$/.exec(c.req.header('authorization') ?? '')?.[1];
    if (!given || !safeEqual(given, token))
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'admin only' } }, 401);
    await next();
  };
}

/** Simple in-memory token bucket per key (per API replica; production: Redis / gateway). */
export class TokenBucket {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(
    private readonly perMin: number,
    private readonly now: () => number = Date.now,
  ) {}
  take(key: string) {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.perMin, at: t };
    b.tokens = Math.min(this.perMin, b.tokens + ((t - b.at) / 60_000) * this.perMin);
    b.at = t;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    this.buckets.set(key, b);
    return {
      ok,
      remaining: Math.floor(b.tokens),
      retryAfterS: ok ? 0 : Math.ceil(((1 - b.tokens) / this.perMin) * 60),
    };
  }
}
