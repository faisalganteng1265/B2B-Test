import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, erc20Abi, type Hex } from 'viem';
import {
  Chaos,
  createLogger,
  MobeeClient,
  PriceFeed,
  signMobee,
  UpstreamError,
  parseToken,
} from '@mopay/shared';
import { createMobeeApp, type ReceiptLike } from '../src/app';
import { MobeeStore } from '../src/store';

const TOKEN = '0x00000000000000000000000000000000000000aa';
const SECRET = 'unit-test-secret';
const log = createLogger('test', 'silent');

function setup(opts: { chaos?: Partial<Chaos['config']>; quoteTtlMs?: number } = {}) {
  let clock = 1_800_000_000_000;
  const receipts = new Map<string, ReceiptLike>();
  let head = 100n;
  const chaos = new Chaos(opts.chaos ?? {});
  const app = createMobeeApp({
    store: new MobeeStore(':memory:'),
    priceFeed: new PriceFeed({ source: 'fixed', fixedRate: '16000', now: () => clock }),
    chain: { getReceipt: async (h) => receipts.get(h) ?? null, getBlockNumber: async () => head },
    chaos,
    apiKey: 'k',
    apiSecret: SECRET,
    adminToken: 'admin-token',
    tokens: { [TOKEN]: 'USDT' },
    chainId: 84532,
    minConfirmations: 3,
    creditDelayMs: [0, 0],
    quoteTtlMs: opts.quoteTtlMs ?? 30_000,
    log,
    now: () => clock,
  });
  const fetchImpl = ((url: string, init?: RequestInit) => app.request(url, init)) as typeof fetch;
  const client = new MobeeClient({
    baseUrl: 'http://mobee.test',
    apiKey: 'k',
    apiSecret: SECRET,
    fetchImpl,
    now: () => clock,
  });
  return {
    app,
    client,
    chaos,
    fetchImpl,
    advance: (ms: number) => (clock += ms),
    setHead: (h: bigint) => (head = h),
    addTransfer(txHash: Hex, to: string, value: bigint, block = 100n) {
      const topics = encodeEventTopics({
        abi: erc20Abi,
        eventName: 'Transfer',
        args: { from: '0x0000000000000000000000000000000000000001', to: to as Hex },
      }) as Hex[];
      receipts.set(txHash, {
        status: 'success',
        blockNumber: block,
        logs: [
          { address: TOKEN, topics, data: encodeAbiParameters([{ type: 'uint256' }], [value]), logIndex: 7 },
        ],
      });
    },
  };
}

const tx = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;

async function fundedSub(s: ReturnType<typeof setup>, sub = 'sub-a', amount = parseToken('1000')) {
  const addr = await s.client.createWalletAddress(sub, 84532);
  s.addTransfer(tx(1), addr.address, amount);
  s.setHead(110n);
  const st = await s.client.depositStatus(tx(1));
  expect(st.deposits[0]!.status).toBe('credited');
  return addr;
}

describe('mobee-mock auth (HMAC)', () => {
  it('accepts a correctly signed request', async () => {
    const s = setup();
    const b = await s.client.balances('sub-a');
    expect(b.balances.USDT).toBe('0');
  });
  it('rejects a bad signature, wrong key and stale timestamp', async () => {
    const s = setup();
    const ts = String(Math.floor(1_800_000_000_000 / 1000));
    const call = (headers: Record<string, string>) =>
      s.app.request('http://x/v1/balances?subAccountId=a', { headers });
    const good = signMobee(SECRET, 'GET', '/v1/balances?subAccountId=a', ts);
    expect(
      (await call({ 'x-api-key': 'k', 'x-request-timestamp': ts, 'x-request-signature': good })).status,
    ).toBe(200);
    const bad = await call({
      'x-api-key': 'k',
      'x-request-timestamp': ts,
      'x-request-signature': signMobee('wrong', 'GET', '/v1/balances?subAccountId=a', ts),
    });
    expect(bad.status).toBe(401);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('INVALID_SIGNATURE');
    expect(
      (await call({ 'x-api-key': 'nope', 'x-request-timestamp': ts, 'x-request-signature': good })).status,
    ).toBe(401);
    const oldTs = String(Number(ts) - 31);
    const stale = await call({
      'x-api-key': 'k',
      'x-request-timestamp': oldTs,
      'x-request-signature': signMobee(SECRET, 'GET', '/v1/balances?subAccountId=a', oldTs),
    });
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe(
      'TIMESTAMP_OUT_OF_TOLERANCE',
    );
  });
  it('rejects a tampered POST body', async () => {
    const s = setup();
    const ts = String(Math.floor(1_800_000_000_000 / 1000));
    const body = JSON.stringify({ subAccountId: 'a', symbol: 'USDT-IDR', amount: '1000000' });
    const sig = signMobee(SECRET, 'POST', '/v1/quick-swap/lock', ts, body);
    const res = await s.app.request('http://x/v1/quick-swap/lock', {
      method: 'POST',
      body: body.replace('1000000', '9000000'),
      headers: { 'x-api-key': 'k', 'x-request-timestamp': ts, 'x-request-signature': sig },
    });
    expect(res.status).toBe(401);
  });
});

describe('mobee-mock deposits', () => {
  it('issues one address per sub-account and credits only after confirmations', async () => {
    const s = setup();
    const a1 = await s.client.createWalletAddress('sub-a', 84532);
    const a2 = await s.client.createWalletAddress('sub-a', 84532);
    expect(a1.address).toBe(a2.address);
    expect((await s.client.depositStatus(tx(9))).status).toBe('not_found');
    s.addTransfer(tx(1), a1.address, 5_000_000n, 100n);
    s.setHead(101n); // 2 confirmations < 3
    expect((await s.client.depositStatus(tx(1))).deposits[0]!.status).toBe('pending');
    s.setHead(102n);
    const st = await s.client.depositStatus(tx(1));
    expect(st.deposits[0]).toMatchObject({
      status: 'credited',
      amount: '5000000',
      logIndex: 7,
      subAccountId: 'sub-a',
    });
    await s.client.depositStatus(tx(1)); // polling again never double-credits
    expect((await s.client.balances('sub-a')).balances.USDT).toBe('5000000');
  });
});

describe('mobee-mock quick swap', () => {
  it('locks at the order-book VWAP and confirms idempotently', async () => {
    const s = setup();
    await fundedSub(s);
    const q = await s.client.lock('sub-a', parseToken('100'));
    expect(q.rate).toBe('16000');
    expect(q.idrAmount).toBe('1600000');
    expect(q.priceSource).toBe('fixed');
    const o1 = await s.client.confirm(q.quoteId, 'wf-1:swap');
    const o2 = await s.client.confirm(q.quoteId, 'wf-1:swap');
    expect(o2).toEqual(o1);
    const bal = (await s.client.balances('sub-a')).balances;
    expect(bal.USDT).toBe(parseToken('900').toString());
    expect(bal.IDR).toBe('1600000');
  });

  it('never swaps twice even if the response is lost (FAIL_AFTER chaos)', async () => {
    const s = setup({ chaos: { FAIL_AFTER_RATE: 1 } });
    s.chaos.update({ FAIL_AFTER_RATE: 0 });
    await fundedSub(s);
    const q = await s.client.lock('sub-a', parseToken('100'));
    s.chaos.update({ FAIL_AFTER_RATE: 1 });
    await expect(s.client.confirm(q.quoteId, 'wf-2:swap')).rejects.toMatchObject({
      cls: 'retryable',
      status: 500,
    });
    s.chaos.update({ FAIL_AFTER_RATE: 0 });
    const o = await s.client.confirm(q.quoteId, 'wf-2:swap');
    expect(o.status).toBe('filled');
    const st = await (
      await s.app.request('http://x/__state', { headers: { 'x-admin-token': 'admin-token' } })
    ).json();
    expect(st).toEqual({ orders: 1, duplicateOrdersPerQuote: 0 });
    expect((await s.client.balances('sub-a')).balances.IDR).toBe('1600000');
  });

  it('rejects an expired quote with non-retryable QUOTE_EXPIRED', async () => {
    const s = setup();
    await fundedSub(s);
    const q = await s.client.lock('sub-a', parseToken('10'));
    s.advance(30_001);
    const err = await s.client.confirm(q.quoteId, 'wf-3:swap').catch((e: UpstreamError) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).code).toBe('QUOTE_EXPIRED');
    expect((err as UpstreamError).retryable).toBe(false);
  });

  it('does not let a quote be executed under two idempotency keys', async () => {
    const s = setup();
    await fundedSub(s);
    const q = await s.client.lock('sub-a', parseToken('10'));
    await s.client.confirm(q.quoteId, 'k1');
    await expect(s.client.confirm(q.quoteId, 'k2')).rejects.toMatchObject({ code: 'QUOTE_ALREADY_USED' });
  });

  it('chaos FAIL_RATE=1 yields retryable 500s', async () => {
    const s = setup({ chaos: { FAIL_RATE: 1 } });
    await expect(s.client.balances('x')).rejects.toMatchObject({ cls: 'retryable', code: 'CHAOS_INJECTED' });
  });
});
