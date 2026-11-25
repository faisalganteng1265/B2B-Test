import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  clients,
  deposits,
  payouts,
  resetTestDb,
  seedIndodax,
  ledgerEntries,
  webhookEvents,
  type DbHandle,
  clientBankAccounts,
} from '@mopay/db';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { Chaos, createLogger, generateApiKey, hmacHex, IndodaxClient, PriceFeed } from '@mopay/shared';
import { createIndodaxMock, IndodaxStore } from '@mopay/indodax-mock';
import { createApp, walletRegistrationMessage } from '../src/app';
import { loadApiEnv } from '../src/env';
import { Notifier } from '../src/notifier';

const log = createLogger('api-test', 'silent');
let h: DbHandle;
let app: ReturnType<typeof createApp>;
let keyA: string;
let keyB: string;
let clientA: string;
let clientB: string;
const submitted: string[] = [];
const resolved: { id: string; payload: unknown }[] = [];
const ADMIN = 'test-admin-token-123';
const WEBHOOK = 'test-webhook-secret';

let exchange: ReturnType<typeof createIndodaxMock>;
let exchangeStore: IndodaxStore;
const WALLET_A = privateKeyToAccount(generatePrivateKey());
const WALLET_B = privateKeyToAccount(generatePrivateKey());

beforeAll(async () => {
  h = await resetTestDb();
  exchangeStore = new IndodaxStore(':memory:');
  exchange = createIndodaxMock({
    store: exchangeStore,
    priceFeed: new PriceFeed({ source: 'fixed', fixedRate: '16000' }),
    chaos: new Chaos(),
    apiKey: 'K',
    apiSecret: 'indodax-test-secret-0123',
    adminToken: ADMIN,
    tokens: {},
    tokenDecimals: 6,
    network: 'base',
    scanner: { head: async () => 1, logs: async () => [] },
    scanStartBlock: 1,
    minConfirm: 1,
    creditDelayMs: [0, 0],
    commissionBps: 41n,
    orderVisibilityDelayMs: 0,
    kycBank: { bankCode: '014', accountNumber: '5270011223', accountName: 'PT MOPAY' },
    fiatWithdrawFeeIdr: 10_000n,
    fiatSettleMs: 0,
    log,
  });
  const exFetch = ((u: string, i?: RequestInit) =>
    exchange.app.request(u.replace(/^https?:\/\/[^/]+/, 'http://indodax'), i)) as typeof fetch;
  const indodax = new IndodaxClient({
    baseUrl: 'http://indodax',
    apiKey: 'K',
    apiSecret: 'indodax-test-secret-0123',
    fetchImpl: exFetch,
  });
  const [addr] = await indodax.depositAddresses('USDT', 'base');
  const created = await seedIndodax(h.db, 84532, addr!.address, [WALLET_A.address]);
  keyA = created[0]!.apiKey;
  keyB = created[1]!.apiKey;
  clientA = created[0]!.clientId;
  clientB = created[1]!.clientId;
  const env = loadApiEnv({
    ...process.env,
    ADMIN_TOKEN: ADMIN,
    BIFAST_WEBHOOK_SECRET: WEBHOOK,
    RATE_LIMIT_PER_MIN: '1000',
    DEMO_TX_ENABLED: 'false',
    MOPAY_BANK_CODE: '014',
    MOPAY_BANK_ACCOUNT: '5270011223',
  });
  const notifier = new Notifier(h.sql, log);
  await notifier.start();
  app = createApp({
    db: h.db,
    env,
    log,
    chainId: 84532,
    chainName: 'base-sepolia',
    explorerTxUrl: (x) => `https://sepolia.basescan.org/tx/${x}`,
    tokens: { USDT: '0xd3dd2744a70188e5fdd17f302d1003e37e2df7c0' },
    indodax,
    priceFeed: new PriceFeed({ source: 'fixed', fixedRate: '16000' }),
    notifier,
    resolveAwakeable: async (id, payload) => void resolved.push({ id, payload }),
    submitWorkflow: async (key) => (submitted.push(key), 'Accepted'),
    fetchImpl: exFetch,
  });
});
afterAll(async () => h?.close());

const auth = (k: string) => ({ authorization: `Bearer ${k}` });
const admin = { 'x-admin-token': ADMIN };

async function insertDeposit(
  clientId: string,
  n: number,
  status: 'seen' | 'manual_review' = 'seen',
  reason?: string,
) {
  const [d] = await h.db
    .insert(deposits)
    .values({
      chainId: 84532,
      tokenAddress: '0xt',
      tokenSymbol: 'USDT',
      txHash: `0x${n.toString(16).padStart(64, '0')}`,
      logIndex: 0,
      blockNumber: n,
      blockHash: '0xb',
      fromAddress: '0xf',
      toAddress: '0xa',
      amountBaseUnits: 1_500_000n,
      clientId,
      source: 'live',
      workflowId: `84532:${n}:0`,
    })
    .returning();
  if (status === 'manual_review') {
    await h.db
      .update(deposits)
      .set({ status: 'manual_review', statusReason: reason ?? 'QUOTE_EXPIRED' })
      .where(eq(deposits.id, d!.id));
  }
  return d!;
}

describe('client auth', () => {
  it('rejects missing/invalid keys and accepts valid ones', async () => {
    expect((await app.request('/v1/deposits')).status).toBe(401);
    expect((await app.request('/v1/deposits', { headers: auth('mpk_deadbeef_nope') })).status).toBe(401);
    expect((await app.request('/v1/deposits', { headers: auth(keyA.slice(0, -2) + 'xx') })).status).toBe(401);
    expect((await app.request('/v1/deposits', { headers: auth(keyA) })).status).toBe(200);
  });

  it('blocks suspended clients', async () => {
    const k = generateApiKey();
    await h.db.insert(clients).values({
      name: 'Suspended',
      apiKeyHash: k.hash,
      apiKeySalt: k.salt,
      apiKeyPrefix: k.prefix,
      exchangeSubaccount: 'sub-x',
      status: 'suspended',
    });
    expect((await app.request('/v1/deposits', { headers: auth(k.key) })).status).toBe(403);
  });
});

describe('B2B endpoints', () => {
  it("deposit instructions: the shared exchange address plus the client's registered wallets", async () => {
    const r = (await (
      await app.request('/v1/deposit-addresses', { method: 'POST', headers: auth(keyA) })
    ).json()) as {
      address: string;
      kind: string;
      registeredWallets: string[];
    };
    const rB = (await (
      await app.request('/v1/deposit-addresses', { method: 'POST', headers: auth(keyB) })
    ).json()) as { address: string; registeredWallets: string[] };
    expect(r.address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(rB.address).toBe(r.address); // ONE address per exchange account
    expect(r.kind).toBe('shared');
    expect(r.registeredWallets).toEqual([WALLET_A.address.toLowerCase()]);
    expect(rB.registeredWallets).toEqual([]);
  });

  it('registers a sender wallet only with a valid ownership signature; one client per wallet', async () => {
    const msgB = walletRegistrationMessage(clientB, WALLET_B.address);
    const post = (key: string, body: unknown) =>
      app.request('/v1/wallets', {
        method: 'POST',
        headers: { ...auth(key), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    // signature for a different client id → rejected
    const wrong = await WALLET_B.signMessage({
      message: walletRegistrationMessage(clientA, WALLET_B.address),
    });
    expect((await post(keyB, { address: WALLET_B.address, signature: wrong })).status).toBe(400);
    const sig = await WALLET_B.signMessage({ message: msgB });
    const ok = await post(keyB, { address: WALLET_B.address, signature: sig });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ address: WALLET_B.address.toLowerCase(), verified: true });
    // client A cannot take B's wallet even with a valid signature for A
    const sigA = await WALLET_B.signMessage({
      message: walletRegistrationMessage(clientA, WALLET_B.address),
    });
    expect((await post(keyA, { address: WALLET_B.address, signature: sigA })).status).toBe(409);
  });

  it('only shows a client its own deposits', async () => {
    const dA = await insertDeposit(clientA, 1);
    const dB = await insertDeposit(clientB, 2);
    const listA = (await (await app.request('/v1/deposits', { headers: auth(keyA) })).json()) as {
      data: { id: string; amount: string }[];
    };
    expect(listA.data.map((x) => x.id)).toContain(dA.id);
    expect(listA.data.map((x) => x.id)).not.toContain(dB.id);
    expect(listA.data.find((x) => x.id === dA.id)!.amount).toBe('1.5');
    expect((await app.request(`/v1/deposits/${dB.id}`, { headers: auth(keyA) })).status).toBe(404);
    const det = (await (await app.request(`/v1/deposits/${dA.id}`, { headers: auth(keyA) })).json()) as {
      timeline: unknown[];
      ledger?: unknown;
    };
    expect(det.timeline).toHaveLength(10);
    expect(det.ledger).toBeUndefined(); // internal detail not exposed to clients
  });

  it('indicative quote: VWAP on the bid book, exchange commission and Mopay fee rounded up', async () => {
    const r = await app.request('/v1/quotes/indicative?amount=1000', { headers: auth(keyA) });
    expect(r.status).toBe(200);
    const q = (await r.json()) as Record<string, string>;
    expect(q).toMatchObject({
      amount: '1000',
      rate: '16000',
      grossIdr: '16000000',
      exchangeFeeIdr: '65600', // 0.41%
      feeIdr: '56000', // 0.35%
      netIdr: '15878400',
      indicative: true,
    });
    expect((await app.request('/v1/quotes/indicative?amount=abc', { headers: auth(keyA) })).status).toBe(400);
  });

  it('serves the OpenAPI document', async () => {
    const doc = (await (await app.request('/openapi.json')).json()) as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/v1/deposit-addresses',
        '/v1/deposits',
        '/v1/deposits/{id}',
        '/v1/quotes/indicative',
        '/v1/wallets',
      ]),
    );
    expect((await app.request('/docs')).status).toBe(200);
  });
});

describe('BI-FAST webhook', () => {
  it('invalid signature → 401 and no state change; valid → awakeable resolved once even if duplicated', async () => {
    const d = await insertDeposit(clientA, 3);
    const [bank] = await h.db
      .select()
      .from(clientBankAccounts)
      .where(eq(clientBankAccounts.clientId, clientA));
    await h.db.insert(payouts).values({
      depositId: d.id,
      idempotencyKey: `${d.workflowId}:payout`,
      bankAccountId: bank!.id,
      amountIdr: 100n,
      awakeableId: 'awk_1',
      bifastRef: 'bf_1',
    });
    const body = JSON.stringify({
      transferId: 'bf_1',
      idempotencyKey: `${d.workflowId}:payout`,
      status: 'success',
    });
    const bad = await app.request('/webhooks/bifast', {
      method: 'POST',
      body,
      headers: { 'x-signature': hmacHex('nope', body) },
    });
    expect(bad.status).toBe(401);
    expect(resolved).toHaveLength(0);
    const ok1 = await app.request('/webhooks/bifast', {
      method: 'POST',
      body,
      headers: { 'x-signature': hmacHex(WEBHOOK, body) },
    });
    const ok2 = await app.request('/webhooks/bifast', {
      method: 'POST',
      body,
      headers: { 'x-signature': hmacHex(WEBHOOK, body) },
    });
    expect(ok1.status).toBe(200);
    expect(await ok2.json()).toEqual({ ok: true, duplicate: true });
    expect(resolved).toEqual([{ id: 'awk_1', payload: { transferId: 'bf_1', status: 'success' } }]);
    expect(
      (await h.db.select().from(webhookEvents).where(eq(webhookEvents.externalId, 'bf_1:success'))).length,
    ).toBe(1);
    // the payout row itself is only changed by the workflow, never by the webhook
    expect((await h.db.query.payouts.findFirst({ where: eq(payouts.depositId, d.id) }))!.status).toBe(
      'pending',
    );
  });
});

describe('admin', () => {
  it('requires the admin token', async () => {
    expect((await app.request('/admin/overview')).status).toBe(401);
    expect((await app.request('/admin/overview', { headers: { 'x-admin-token': 'wrong' } })).status).toBe(
      401,
    );
    const r = await app.request('/admin/overview', { headers: admin });
    expect(r.status).toBe(200);
    const o = (await r.json()) as { deposits: Record<string, number>; price: { bid: string } };
    expect(o.price.bid).toBe('16000');
    expect(o.deposits.seen).toBeGreaterThan(0);
  });

  it('re-drives a manual_review deposit with a new Restate key but refuses reorg incidents', async () => {
    const d = await insertDeposit(clientA, 4, 'manual_review');
    const r = await app.request(`/admin/deposits/${d.id}/retry`, { method: 'POST', headers: admin });
    expect(r.status).toBe(200);
    expect(submitted).toContain(`${d.workflowId}#retry-1`);
    expect((await h.db.query.deposits.findFirst({ where: eq(deposits.id, d.id) }))!.status).toBe(
      'dispatched',
    );
    expect(
      (await app.request(`/admin/deposits/${d.id}/retry`, { method: 'POST', headers: admin })).status,
    ).toBe(409);

    const inc = await insertDeposit(clientA, 5, 'manual_review', 'INCIDENT: reorg after confirmation');
    expect(
      (await app.request(`/admin/deposits/${inc.id}/retry`, { method: 'POST', headers: admin })).status,
    ).toBe(409);
  });

  it('proxies chaos settings to the mocks', async () => {
    const r = await app.request('/admin/chaos/exchange', {
      method: 'POST',
      headers: { ...admin, 'content-type': 'application/json' },
      body: JSON.stringify({ FAIL_RATE: 0.5 }),
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { config: { FAIL_RATE: number } }).config.FAIL_RATE).toBe(0.5);
    expect(
      (await app.request('/admin/chaos/nope', { method: 'POST', headers: admin, body: '{}' })).status,
    ).toBe(400);
  });

  it('streams deposit changes over SSE (Postgres LISTEN/NOTIFY)', async () => {
    const res = await app.request('/v1/stream', { headers: admin });
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const t = setTimeout(() => void insertDeposit(clientB, 6), 300);
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !(buf.includes('event: deposit') && buf.includes('event: metrics'))) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
    }
    clearTimeout(t);
    await reader.cancel();
    expect(buf).toContain('event: hello');
    expect(buf).toContain('event: deposit');
    expect(buf).toContain('event: metrics');
  });
});

describe('admin: exchange operations', () => {
  it('assigns an unattributed deposit (unknown sender) to a client and re-drives it', async () => {
    const [d] = await h.db
      .insert(deposits)
      .values({
        chainId: 84532,
        tokenAddress: '0xt',
        tokenSymbol: 'USDT',
        txHash: `0x${'77'.repeat(32)}`,
        logIndex: 0,
        blockNumber: 7,
        blockHash: '0xb',
        fromAddress: '0x00000000000000000000000000000000000000ee',
        toAddress: '0xa',
        amountBaseUnits: 9_000_000n,
        clientId: null,
        source: 'live',
        workflowId: '84532:unattributed:0',
        status: 'seen',
      })
      .returning();
    await h.db
      .update(deposits)
      .set({ status: 'manual_review', statusReason: 'UNATTRIBUTED: sender ...' })
      .where(eq(deposits.id, d!.id));
    const post = (body: unknown) =>
      app.request(`/admin/deposits/${d!.id}/assign`, {
        method: 'POST',
        headers: { ...admin, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const r = await post({ clientId: clientB, registerWallet: true });
    expect(r.status).toBe(200);
    const after = (await h.db.query.deposits.findFirst({ where: eq(deposits.id, d!.id) }))!;
    expect(after).toMatchObject({ clientId: clientB, status: 'dispatched' });
    expect(submitted).toContain('84532:unattributed:0#retry-1');
    expect((await post({ clientId: clientA })).status).toBe(409); // already assigned
  });

  it("treasury sweep: IDR from the exchange to Mopay's KYC bank, idempotent, journal posted once", async () => {
    await app.request('/admin/chaos/exchange', {
      method: 'POST',
      headers: { ...admin, 'content-type': 'application/json' },
      body: JSON.stringify({ FAIL_RATE: 0 }),
    });
    exchangeStore.addBalance('IDR', 2_000_000n);
    const r = await app.request('/admin/treasury/sweep', {
      method: 'POST',
      headers: { ...admin, 'content-type': 'application/json' },
      body: JSON.stringify({ amount: '1500000' }),
    });
    expect(r.status).toBe(200);
    const view = (await (await app.request('/admin/exchange', { headers: admin })).json()) as {
      sweeps: { status: string; feeIdr: string }[];
      account: { balances: { asset: string; free: string }[] };
    };
    expect(view.sweeps[0]).toMatchObject({ status: 'success', feeIdr: '10000' });
    expect(view.account.balances.find((b) => b.asset === 'IDR')!.free).toBe('500000');
    await app.request('/admin/exchange', { headers: admin }); // reconcile again: no double journal
    const lines = await h.db.select().from(ledgerEntries);
    const sweep = lines.filter((l) => l.journalId.startsWith('sweep:'));
    expect(sweep).toHaveLength(3);
    expect(sweep.find((l) => l.account === 'mopay_bank_idr')!.debit).toBe(1_490_000n);
    const tooSmall = await app.request('/admin/treasury/sweep', {
      method: 'POST',
      headers: { ...admin, 'content-type': 'application/json' },
      body: JSON.stringify({ amount: '100000' }),
    });
    expect(tooSmall.status).toBe(400);
  });
});

describe('rate limit', () => {
  it('returns 429 after the per-key budget is exhausted', async () => {
    const env = loadApiEnv({ ...process.env, RATE_LIMIT_PER_MIN: '3' });
    const { clientAuth } = await import('../src/auth');
    const { Hono } = await import('hono');
    const small = new Hono();
    small.use('*', clientAuth(h.db, env.RATE_LIMIT_PER_MIN));
    small.get('/x', (c) => c.text('ok'));
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await small.request('/x', { headers: auth(keyB) })).status);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
  });
});
