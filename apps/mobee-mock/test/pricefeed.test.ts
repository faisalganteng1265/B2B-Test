import { describe, expect, it } from 'vitest';
import { PriceFeed, PriceUnavailableError, parseRate, parseToken } from '@mopay/shared';

function fakeIndodax() {
  let up = true;
  let calls = 0;
  const impl = (async (url: string) => {
    calls++;
    if (!up) throw new TypeError('fetch failed');
    if (url.endsWith('/api/ticker/usdtidr'))
      return new Response(
        JSON.stringify({ ticker: { buy: '18312', sell: '18313', last: '18313', server_time: 1795513821 } }),
      );
    return new Response(
      JSON.stringify({
        buy: [
          ['18306', '100.5'],
          ['18312', '50.12345678'],
          ['18300', '1000'],
        ],
        sell: [
          ['18313', '10'],
          ['18320', '10'],
        ],
      }),
    );
  }) as unknown as typeof fetch;
  return { impl, setUp: (v: boolean) => (up = v), calls: () => calls };
}

describe('PriceFeed (indodax shape)', () => {
  it('parses ticker/depth, sorts bids and computes VWAP from the bid side', async () => {
    const t = 0;
    const f = fakeIndodax();
    const feed = new PriceFeed({ source: 'indodax', fetchImpl: f.impl, now: () => t, retries: 0 });
    const r = await feed.read();
    expect(r.stale).toBe(false);
    expect(r.snapshot.bid).toBe(parseRate('18312'));
    expect(r.snapshot.ask).toBe(parseRate('18313'));
    expect(r.snapshot.asOf.toISOString()).toBe(new Date(1795513821 * 1000).toISOString());
    expect(r.snapshot.bids[0]!.amount).toBe(50_123_456n); // 8dp truncated to 6dp
    const q = PriceFeed.quoteSell(r.snapshot, parseToken('100'));
    expect(q.levelsUsed).toBe(2);
    expect(q.vwapScaled).toBeLessThan(parseRate('18312'));
    expect(q.vwapScaled).toBeGreaterThan(parseRate('18306'));
  });

  it('caches for cacheMs (rate-limit friendly) and coalesces concurrent reads', async () => {
    let t = 0;
    const f = fakeIndodax();
    const feed = new PriceFeed({
      source: 'indodax',
      fetchImpl: f.impl,
      now: () => t,
      cacheMs: 4000,
      retries: 0,
    });
    await Promise.all([feed.read(), feed.read(), feed.read()]);
    expect(f.calls()).toBe(2); // ticker + depth once
    t = 3000;
    await feed.read();
    expect(f.calls()).toBe(2);
    t = 4000;
    await feed.read();
    expect(f.calls()).toBe(4);
  });

  it('serves stale cache when indodax is down, and refuses execution after 60s', async () => {
    let t = 0;
    const f = fakeIndodax();
    const feed = new PriceFeed({ source: 'indodax', fetchImpl: f.impl, now: () => t, retries: 0 });
    await feed.read();
    f.setUp(false);
    t = 10_000;
    const r = await feed.read();
    expect(r.stale).toBe(true);
    expect(r.snapshot.bid).toBe(parseRate('18312'));
    await expect(feed.readForExecution()).resolves.toBeTruthy();
    t = 61_000;
    await expect(feed.readForExecution()).rejects.toBeInstanceOf(PriceUnavailableError);
    f.setUp(true);
    t = 70_000;
    expect((await feed.readForExecution()).stale).toBe(false);
  });

  it('throws PRICE_UNAVAILABLE when there was never any data', async () => {
    const f = fakeIndodax();
    f.setUp(false);
    const feed = new PriceFeed({ source: 'indodax', fetchImpl: f.impl, retries: 0 });
    await expect(feed.read()).rejects.toMatchObject({ code: 'PRICE_UNAVAILABLE' });
  });
});
