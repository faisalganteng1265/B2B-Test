import { z } from 'zod';
import { parseDecimal, parseRate, TOKEN_DECIMALS, vwapSell, type BookLevel, type VwapResult } from './money';
import { sleep } from './chaos';

/**
 * USDT/IDR price feed. Source of truth: Indodax PUBLIC API (no key), per
 * github.com/btcid/indodax-official-api-docs Public-RestAPI.md:
 *   GET /api/ticker/usdtidr -> { ticker: { buy, sell, last, high, low, vol_usdt, vol_idr, server_time } }
 *   GET /api/depth/usdtidr  -> { buy: [[price, amount], ...], sell: [[price, amount], ...] }
 * Prices and amounts are decimal strings. Public API is rate limited to 180 req/min.
 *
 * Only the PRICE is real. Nothing here ever touches a private exchange API.
 */

const tickerSchema = z.object({
  ticker: z.object({
    buy: z.string(),
    sell: z.string(),
    last: z.string(),
    server_time: z.coerce.number().optional(),
  }),
});
const level = z.tuple([z.union([z.string(), z.number()]), z.union([z.string(), z.number()])]);
const depthSchema = z.object({ buy: z.array(level), sell: z.array(level) });

export interface PriceSnapshot {
  source: 'indodax' | 'fixed';
  /** best bid / best ask / last, IDR per USDT scaled 1e6 */
  bid: bigint;
  ask: bigint;
  last: bigint;
  bids: BookLevel[];
  asks: BookLevel[];
  /** when the upstream data was observed */
  asOf: Date;
}

export interface PriceReading {
  snapshot: PriceSnapshot;
  /** true if the last refresh failed and we are serving cached data */
  stale: boolean;
  ageMs: number;
}

export class PriceUnavailableError extends Error {
  readonly code = 'PRICE_UNAVAILABLE';
  constructor(message: string) {
    super(message);
    this.name = 'PriceUnavailableError';
  }
}

export interface PriceFeedOptions {
  source: 'indodax' | 'fixed';
  baseUrl?: string;
  pair?: string;
  /** cache TTL; also the minimum interval between upstream fetches (rate-limit friendly) */
  cacheMs?: number;
  /** a reading older than this is unusable for execution */
  maxStaleMs?: number;
  fixedRate?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  retries?: number;
  requestTimeoutMs?: number;
}

export class PriceFeed {
  private cached: PriceSnapshot | null = null;
  private cachedAt = 0;
  private lastAttemptAt = 0;
  private lastError: string | null = null;
  private inflight: Promise<void> | null = null;
  private readonly o: Required<Omit<PriceFeedOptions, 'fixedRate'>> & { fixedRate?: string };

  constructor(opts: PriceFeedOptions) {
    this.o = {
      baseUrl: 'https://indodax.com',
      pair: 'usdtidr',
      cacheMs: 4_000,
      maxStaleMs: 60_000,
      fetchImpl: fetch,
      now: Date.now,
      retries: 2,
      requestTimeoutMs: 4_000,
      ...opts,
    };
  }

  get status() {
    return { lastError: this.lastError, cachedAt: this.cachedAt ? new Date(this.cachedAt) : null };
  }

  /** Latest reading (refreshing if the cache expired). Throws PriceUnavailableError if no data at all. */
  async read(): Promise<PriceReading> {
    const now = this.o.now();
    if (this.o.source === 'fixed') return { snapshot: this.fixedSnapshot(now), stale: false, ageMs: 0 };
    if (!this.cached || now - this.lastAttemptAt >= this.o.cacheMs) {
      this.inflight ??= this.refresh().finally(() => (this.inflight = null));
      await this.inflight;
    }
    if (!this.cached)
      throw new PriceUnavailableError(`no price data from indodax: ${this.lastError ?? 'unknown'}`);
    const ageMs = this.o.now() - this.cachedAt;
    return { snapshot: this.cached, stale: this.lastError !== null || ageMs > this.o.cacheMs * 2, ageMs };
  }

  /** Reading that is safe to EXECUTE on: rejects if older than maxStaleMs. */
  async readForExecution(): Promise<PriceReading> {
    const r = await this.read();
    if (r.ageMs > this.o.maxStaleMs) {
      throw new PriceUnavailableError(
        `price is stale (${Math.round(r.ageMs / 1000)}s old, max ${this.o.maxStaleMs / 1000}s)`,
      );
    }
    return r;
  }

  /** VWAP for selling `amount` token base units into the bid book. */
  static quoteSell(snapshot: PriceSnapshot, amount: bigint): VwapResult {
    return vwapSell(snapshot.bids, amount);
  }

  private async refresh(): Promise<void> {
    this.lastAttemptAt = this.o.now();
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.o.retries; attempt++) {
      if (attempt > 0) await sleep(200 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100));
      try {
        const [t, d] = await Promise.all([
          this.get(`/api/ticker/${this.o.pair}`),
          this.get(`/api/depth/${this.o.pair}`),
        ]);
        const ticker = tickerSchema.parse(t).ticker;
        const depth = depthSchema.parse(d);
        const toLevels = (rows: z.infer<typeof level>[]) =>
          rows
            .map(([p, a]) => ({
              priceScaled: parseRate(String(p)),
              amount: parseDecimal(String(a), TOKEN_DECIMALS),
            }))
            .filter((l) => l.priceScaled > 0n && l.amount > 0n);
        const bids = toLevels(depth.buy).sort((a, b) => (a.priceScaled > b.priceScaled ? -1 : 1));
        const asks = toLevels(depth.sell).sort((a, b) => (a.priceScaled < b.priceScaled ? -1 : 1));
        if (!bids.length || !asks.length) throw new Error('empty order book');
        const fetchedAt = this.o.now();
        this.cached = {
          source: 'indodax',
          bid: bids[0]!.priceScaled,
          ask: asks[0]!.priceScaled,
          last: parseRate(ticker.last),
          bids,
          asks,
          asOf: new Date(ticker.server_time ? ticker.server_time * 1000 : fetchedAt),
        };
        this.cachedAt = fetchedAt;
        this.lastError = null;
        return;
      } catch (e) {
        lastErr = e;
      }
    }
    this.lastError = lastErr instanceof Error ? lastErr.message : String(lastErr);
  }

  private async get(path: string): Promise<unknown> {
    const res = await this.o.fetchImpl(`${this.o.baseUrl}${path}`, {
      signal: AbortSignal.timeout(this.o.requestTimeoutMs),
      headers: { accept: 'application/json', 'user-agent': 'mopay-prototype/0.1' },
    });
    if (res.status === 429) throw new Error('indodax rate limited (429)');
    if (!res.ok) throw new Error(`indodax ${path} -> HTTP ${res.status}`);
    return res.json();
  }

  private fixedSnapshot(now: number): PriceSnapshot {
    const rate = parseRate(this.o.fixedRate ?? '16500');
    const tick = parseRate('1');
    const deep = parseDecimal('1000000', TOKEN_DECIMALS);
    const bids = Array.from({ length: 5 }, (_, i) => ({
      priceScaled: rate - BigInt(i) * tick,
      amount: deep,
    }));
    const asks = Array.from({ length: 5 }, (_, i) => ({
      priceScaled: rate + BigInt(i + 1) * tick,
      amount: deep,
    }));
    return { source: 'fixed', bid: rate, ask: rate + tick, last: rate, bids, asks, asOf: new Date(now) };
  }
}
