import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  clients,
  deposits,
  payouts,
  resetTestDb,
  seed,
  webhookEvents,
  type DbHandle,
  clientBankAccounts,
} from '@mopay/db';
import { Chaos, createLogger, generateApiKey, hmacHex, MobeeClient, PriceFeed } from '@mopay/shared';
import { createMobeeApp, MobeeStore } from '@mopay/mobee-mock';
import { createApp } from '../src/app';
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

beforeAll(async () => {
  h = await resetTestDb();
  const mobeeApp = createMobeeApp({
    store: new MobeeStore(':memory:'),
    priceFeed: new PriceFeed({ source: 'fixed', fixedRate: '16000' }),
    chain: { getReceipt: async () => null, getBlockNumber: async () => 1n },
    chaos: new Chaos(),
    apiKey: 'k',
    apiSecret: 'mobee-test-secret',
    adminToken: ADMIN,
    tokens: {},
    chainId: 84532,
    minConfirmations: 1,
    creditDelayMs: [0, 0],
    quoteTtlMs: 30_000,
    log,
  });
  const mobee = new MobeeClient({
    baseUrl: 'http://mobee',
    apiKey: 'k',
    apiSecret: 'mobee-test-secret',
    fetchImpl: ((u: string, i?: RequestInit) => mobeeApp.request(u, i)) as typeof fetch,
  });
  const created = await seed(
    h.db,
    84532,
    async (sub) => (await mobee.createWalletAddress(sub, 84532)).address,
  );
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
    mobee,
    notifier,
    resolveAwakeable: async (id, payload) => void resolved.push({ id, payload }),
    submitWorkflow: async (key) => (submitted.push(key), 'Accepted'),
    fetchImpl: ((u: string, i?: RequestInit) =>
      mobeeApp.request(u.replace(/^https?:\/\/[^/]+/, 'http://mobee'), i)) as typeof fetch,
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
    await h.db
      .insert(clients)
      .values({
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
  it('deposit address is idempotent per client and chain', async () => {
    const r1 = (await (
      await app.request('/v1/deposit-addresses', { method: 'POST', headers: auth(keyA) })
    ).json()) as { address: string };
    const r2 = (await (
      await app.request('/v1/deposit-addresses', { method: 'POST', headers: auth(keyA) })
    ).json()) as { address: string };
    expect(r1.address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(r2.address).toBe(r1.address);
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

  it('indicative quote: VWAP rate, fee rounded up, net = gross - fee', async () => {
    const r = await app.request('/v1/quotes/indicative?amount=1000', { headers: auth(keyA) });
    expect(r.status).toBe(200);
    const q = (await r.json()) as Record<string, string>;
    expect(q).toMatchObject({
      amount: '1000',
      rate: '16000',
      grossIdr: '16000000',
      feeIdr: '56000',
      netIdr: '15944000',
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
    await h.db
      .insert(payouts)
      .values({
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
    const r = await app.request('/admin/chaos/mobee', {
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
