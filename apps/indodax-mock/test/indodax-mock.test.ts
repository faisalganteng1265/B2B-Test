import { describe, expect, it } from 'vitest';
import { Chaos, createLogger, IndodaxClient, IndodaxError, indodaxSign, PriceFeed } from '@mopay/shared';
import { createIndodaxMock, type TransferLog } from '../src/app';
import { IndodaxStore } from '../src/store';

const USDT = '0x00000000000000000000000000000000000000aa';
const KEY = 'TEST-KEY';
const SECRET = 'test-secret-0123456789abcdef';

function setup(o: { visibilityMs?: number; chaos?: Partial<Chaos['config']> } = {}) {
  let clock = 1_800_000_000_000;
  let head = 100;
  const pending: TransferLog[] = [];
  const chaos = new Chaos(o.chaos ?? {});
  const mock = createIndodaxMock({
    store: new IndodaxStore(':memory:'),
    priceFeed: new PriceFeed({ source: 'fixed', fixedRate: '16000', now: () => clock }),
    chaos,
    apiKey: KEY,
    apiSecret: SECRET,
    adminToken: 'admin',
    tokens: { [USDT]: 'USDT' },
    tokenDecimals: 6,
    network: 'base',
    scanner: {
      head: async () => head,
      logs: async (f, t, a) => pending.filter((l) => l.blockNumber >= f && l.blockNumber <= t && l.to === a),
    },
    scanStartBlock: 1,
    minConfirm: 3,
    creditDelayMs: [0, 0],
    commissionBps: 41n,
    orderVisibilityDelayMs: o.visibilityMs ?? 0,
    kycBank: { bankCode: '014', accountNumber: '5270011223', accountName: 'PT MOPAY' },
    fiatWithdrawFeeIdr: 10_000n,
    fiatSettleMs: 5000,
    log: createLogger('t', 'silent'),
    now: () => clock,
  });
  const fetchImpl = ((u: string, i?: RequestInit) => mock.app.request(u, i)) as typeof fetch;
  const client = new IndodaxClient({
    baseUrl: 'http://indodax.test',
    apiKey: KEY,
    apiSecret: SECRET,
    fetchImpl,
    now: () => clock,
  });
  return {
    ...mock,
    client,
    chaos,
    fetchImpl,
    advance: (ms: number) => (clock += ms),
    setHead: (h: number) => (head = h),
    async fund(usdt: bigint) {
      const addr = (await client.depositAddresses('USDT', 'base'))[0]!.address;
      pending.push({
        txHash: `0x${'ab'.repeat(32)}`,
        logIndex: 0,
        blockNumber: 90,
        from: '0xc1',
        to: addr,
        token: USDT,
        value: usdt,
      });
      await mock.scanOnce();
      return addr;
    },
    pending,
  };
}

const errOf = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: IndodaxError) => e,
  );

describe('auth (TAPIv2)', () => {
  it('accepts a correctly signed request', async () => {
    const s = setup();
    const a = await s.client.account();
    expect(a.canTrade).toBe(true);
    expect(a.balances.map((b) => b.asset)).toEqual(['IDR', 'USDT', 'USDC']);
  });
  it('rejects missing key, unknown key, bad signature and stale timestamp with Indodax codes', async () => {
    const s = setup();
    const ts = 1_800_000_000_000;
    const qs = `timestamp=${ts}&recvWindow=5000`;
    const call = (h: Record<string, string>, q = qs) =>
      Promise.resolve(s.app.request(`http://x/api/v2/account?${q}`, { headers: h })).then(
        (r: Response) => r.json() as Promise<{ code: number }>,
      );
    expect((await call({})).code).toBe(-2014);
    expect((await call({ 'X-APIKEY': 'nope', Sign: indodaxSign(SECRET, qs) })).code).toBe(-1002);
    expect((await call({ 'X-APIKEY': KEY, Sign: indodaxSign('wrong', qs) })).code).toBe(-1022);
    const old = `timestamp=${ts - 6000}&recvWindow=5000`;
    expect((await call({ 'X-APIKEY': KEY, Sign: indodaxSign(SECRET, old) }, old)).code).toBe(-1021);
    const future = `timestamp=${ts + 1500}&recvWindow=5000`;
    expect((await call({ 'X-APIKEY': KEY, Sign: indodaxSign(SECRET, future) }, future)).code).toBe(-1021);
  });
});

describe('deposits', () => {
  it('one stable deposit address per account; credited only after minConfirm', async () => {
    const s = setup();
    const a1 = (await s.client.depositAddresses('USDT', 'base'))[0]!;
    const a2 = (await s.client.depositAddresses('USDT', 'base'))[0]!;
    expect(a1.address).toBe(a2.address);
    expect(a1).toMatchObject({ coin: 'USDT', tag: '', network: 'base' });
    s.pending.push({
      txHash: '0x01',
      logIndex: 3,
      blockNumber: 99,
      from: '0xc1',
      to: a1.address,
      token: USDT,
      value: 25_000_000n,
    });
    await s.scanOnce();
    expect((await s.client.depositHistory('USDT'))[0]).toMatchObject({
      txId: '0x01',
      amount: '25',
      status: 'pending',
      address: a1.address,
    });
    s.setHead(101);
    await s.scanOnce();
    const d = (await s.client.depositHistory('USDT'))[0]!;
    expect(d.status).toBe('success');
    expect(d.completeTime).toBeTypeOf('number');
    expect((await s.client.account()).balances.find((b) => b.asset === 'USDT')!.free).toBe('25');
    expect(await s.client.depositHistory('BTC')).toEqual([]); // docs: coin defaults to BTC
  });
});

describe('orders', () => {
  it('MARKET SELL fills against the book, charges commission (rounded up), exposes fills in myTrades', async () => {
    const s = setup();
    await s.fund(100_000_000n); // 100 USDT
    s.setHead(110);
    await s.scanOnce();
    const ack = await s.client.createOrder({
      symbol: 'USDTIDR',
      side: 'SELL',
      type: 'MARKET',
      quantity: '25',
      newClientOrderId: 'mp-sell-1',
    });
    expect(ack).toMatchObject({
      symbol: 'USDTIDR',
      clientOrderId: 'mp-sell-1',
      side: 'SELL',
      type: 'MARKET',
      origQty: '25',
      executedQty: '25',
    });
    expect(ack.fullOrderId).toBe(`usdtidr-market-${ack.orderId}`);
    const o = await s.client.getOrder('USDTIDR', { origClientOrderId: 'mp-sell-1' });
    expect(o.status).toBe('FILLED');
    const t = (await s.client.myTrades('usdtidr', { clientOrderId: 'mp-sell-1' })).data;
    const quote = t.reduce((a, x) => a + BigInt(x.quoteQty), 0n);
    const comm = t.reduce((a, x) => a + BigInt(x.commission), 0n);
    expect(quote).toBe(400_000n); // 25 * 16000
    expect(comm).toBe(1_640n); // 0.41% of 400,000
    const bal = (await s.client.account()).balances;
    expect(bal.find((b) => b.asset === 'IDR')!.free).toBe('398360');
    expect(bal.find((b) => b.asset === 'USDT')!.free).toBe('75');
  });

  it('distinguishes duplicate client order id from insufficient balance (both -2010)', async () => {
    const s = setup();
    await s.fund(10_000_000n);
    s.setHead(110);
    await s.scanOnce();
    await s.client.createOrder({
      symbol: 'USDTIDR',
      side: 'SELL',
      type: 'MARKET',
      quantity: '5',
      newClientOrderId: 'dup1',
    });
    const dup = await errOf(
      s.client.createOrder({
        symbol: 'USDTIDR',
        side: 'SELL',
        type: 'MARKET',
        quantity: '5',
        newClientOrderId: 'dup1',
      }),
    );
    expect(dup).toBeInstanceOf(IndodaxError);
    expect(dup!.indodaxCode).toBe(-2010);
    expect(dup!.isDuplicateClientId).toBe(true);
    expect(dup!.retryable).toBe(false);
    const poor = await errOf(
      s.client.createOrder({
        symbol: 'USDTIDR',
        side: 'SELL',
        type: 'MARKET',
        quantity: '500',
        newClientOrderId: 'poor1',
      }),
    );
    expect(poor!.indodaxCode).toBe(-2010);
    expect(poor!.isDuplicateClientId).toBe(false);
  });

  it('orders are not immediately visible (-2013, retryable) as documented', async () => {
    const s = setup({ visibilityMs: 3000 });
    await s.fund(10_000_000n);
    s.setHead(110);
    await s.scanOnce();
    await s.client.createOrder({
      symbol: 'USDTIDR',
      side: 'SELL',
      type: 'MARKET',
      quantity: '5',
      newClientOrderId: 'late1',
    });
    const e = await errOf(s.client.getOrder('USDTIDR', { origClientOrderId: 'late1' }));
    if (e) {
      expect(e.indodaxCode).toBe(-2013);
      expect(e.retryable).toBe(true);
      expect((await s.client.myTrades('usdtidr', { clientOrderId: 'late1' })).data).toEqual([]);
    }
    s.advance(3001);
    expect((await s.client.getOrder('USDTIDR', { origClientOrderId: 'late1' })).status).toBe('FILLED');
  });

  it('a lost response is reconciled by clientOrderId: retry → duplicate → order exists → no second sell', async () => {
    const s = setup();
    await s.fund(10_000_000n);
    s.setHead(110);
    await s.scanOnce();
    s.chaos.update({ FAIL_AFTER_RATE: 1 });
    const lost = await errOf(
      s.client.createOrder({
        symbol: 'USDTIDR',
        side: 'SELL',
        type: 'MARKET',
        quantity: '5',
        newClientOrderId: 'lost1',
      }),
    );
    expect(lost!.retryable).toBe(true);
    s.chaos.update({ FAIL_AFTER_RATE: 0 });
    const retry = await errOf(
      s.client.createOrder({
        symbol: 'USDTIDR',
        side: 'SELL',
        type: 'MARKET',
        quantity: '5',
        newClientOrderId: 'lost1',
      }),
    );
    expect(retry!.isDuplicateClientId).toBe(true);
    expect((await s.client.getOrder('USDTIDR', { origClientOrderId: 'lost1' })).status).toBe('FILLED');
    expect((await s.client.account()).balances.find((b) => b.asset === 'USDT')!.free).toBe('5');
  });

  it('rejects below-minimum orders and bad symbols', async () => {
    const s = setup();
    await s.fund(10_000_000n);
    s.setHead(110);
    await s.scanOnce();
    expect(
      (await errOf(
        s.client.createOrder({
          symbol: 'USDTIDR',
          side: 'SELL',
          type: 'MARKET',
          quantity: '0.5',
          newClientOrderId: 'small',
        }),
      ))!.indodaxCode,
    ).toBe(-1130);
    expect(
      (await errOf(
        s.client.createOrder({
          symbol: 'DOGEIDR',
          side: 'SELL',
          type: 'MARKET',
          quantity: '1',
          newClientOrderId: 'x',
        }),
      ))!.indodaxCode,
    ).toBe(-1121);
  });
});

describe('IDR withdrawal', () => {
  it('only to the KYC same-name bank, > Rp100.000, idempotent on clientRequestId, settles later', async () => {
    const s = setup();
    await s.fund(50_000_000n);
    s.setHead(110);
    await s.scanOnce();
    await s.client.createOrder({
      symbol: 'USDTIDR',
      side: 'SELL',
      type: 'MARKET',
      quantity: '50',
      newClientOrderId: 's',
    });
    const w = (p: { amount: bigint; accountNumber?: string; clientRequestId?: string }) =>
      s.client.fiatWithdraw({
        amount: p.amount,
        accountNumber: p.accountNumber ?? '5270011223',
        bankCode: '014',
        clientRequestId: p.clientRequestId ?? 'w1',
      });
    expect((await errOf(w({ amount: 100_000n })))!.indodaxCode).toBe(-1130);
    expect((await errOf(w({ amount: 200_000n, accountNumber: '999' })))!.indodaxCode).toBe(-4019);
    expect((await errOf(w({ amount: 900_000_000n, clientRequestId: 'big' })))!.indodaxCode).toBe(-4026);
    const r1 = await w({ amount: 500_000n });
    const r2 = await w({ amount: 500_000n });
    expect(r2.data.orderId).toBe(r1.data.orderId);
    expect((await s.client.fiatOrders('1')).data[0]).toMatchObject({
      status: 'pending',
      amount: '500000',
      totalFee: '10000',
    });
    s.advance(5001);
    expect((await s.client.fiatOrders('1')).data[0]!.status).toBe('success');
    expect((await s.client.account()).balances.find((b) => b.asset === 'IDR')!.free).toBe(
      String(800_000n - 3_280n - 500_000n),
    );
  });
});
