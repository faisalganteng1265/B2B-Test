import { describe, expect, it } from 'vitest';
import { BifastClient, Chaos, createLogger, verifyHmacHex, bifastCallbackSchema } from '@mopay/shared';
import { createBifast } from '../src/app';

const SECRET = 'webhook-secret-123';

function setup(chaos: Partial<Chaos['config']> = {}, receiverUp = true) {
  let clock = 1_000_000;
  const received: { body: string; sig: string | null }[] = [];
  let up = receiverUp;
  const callbackFetch = (async (_url: string, init: RequestInit) => {
    if (!up) return new Response('down', { status: 503 });
    received.push({ body: String(init.body), sig: new Headers(init.headers).get('x-signature') });
    return new Response('ok');
  }) as unknown as typeof fetch;
  const b = createBifast({
    dbPath: ':memory:',
    chaos: new Chaos(chaos),
    apiKey: 'pjp',
    adminToken: 'admin-token',
    webhookSecret: SECRET,
    callbackUrl: 'http://mopay/webhooks/bifast',
    settleMs: [1000, 1000],
    log: createLogger('t', 'silent'),
    now: () => clock,
    fetchImpl: callbackFetch,
  });
  const client = new BifastClient({
    baseUrl: 'http://bifast.test',
    apiKey: 'pjp',
    fetchImpl: ((u: string, i?: RequestInit) => b.app.request(u, i)) as typeof fetch,
  });
  return { ...b, client, received, advance: (ms: number) => (clock += ms), setUp: (v: boolean) => (up = v) };
}

const acct = { bankCode: '014', accountNumber: '8830112233', accountName: 'PT NUSANTARA DIGITAL NIAGA' };

describe('bifast-mock', () => {
  it('account inquiry returns the owner name or 404', async () => {
    const s = setup();
    expect((await s.client.accountInquiry('014', '8830112233')).accountName).toBe(
      'PT NUSANTARA DIGITAL NIAGA',
    );
    await expect(s.client.accountInquiry('014', '1111111111')).rejects.toMatchObject({
      code: 'ACCOUNT_NOT_FOUND',
      cls: 'terminal',
    });
  });

  it('is idempotent on Idempotency-Key and rejects key reuse with a different body', async () => {
    const s = setup();
    const t1 = await s.client.createTransfer('wf:payout', { ...acct, amount: 1_000_000n });
    const t2 = await s.client.createTransfer('wf:payout', { ...acct, amount: 1_000_000n });
    expect(t1.status).toBe('pending');
    expect(t2.transferId).toBe(t1.transferId);
    await expect(s.client.createTransfer('wf:payout', { ...acct, amount: 2_000_000n })).rejects.toMatchObject(
      { code: 'IDEMPOTENCY_KEY_REUSED' },
    );
    expect(s.db.prepare('SELECT count(*) AS n FROM transfers').get()).toEqual({ n: 1 });
  });

  it('settles asynchronously and sends a signed callback', async () => {
    const s = setup();
    const t = await s.client.createTransfer('k1', { ...acct, amount: 5n });
    await s.tick();
    expect(s.received).toHaveLength(0);
    s.advance(1000);
    await s.tick();
    expect(s.received).toHaveLength(1);
    const cb = s.received[0]!;
    expect(verifyHmacHex(SECRET, cb.body, cb.sig ?? undefined)).toBe(true);
    expect(bifastCallbackSchema.parse(JSON.parse(cb.body))).toEqual({
      transferId: t.transferId,
      idempotencyKey: 'k1',
      status: 'success',
    });
    await s.tick();
    expect(s.received).toHaveLength(1);
  });

  it('can send duplicate callbacks (chaos) with identical payloads', async () => {
    const s = setup({ DUPLICATE_CALLBACK_RATE: 1 });
    await s.client.createTransfer('k2', { ...acct, amount: 5n });
    s.advance(1000);
    await s.tick();
    expect(s.received).toHaveLength(2);
    expect(s.received[0]!.body).toBe(s.received[1]!.body);
  });

  it('retries callback delivery while the receiver is down', async () => {
    const s = setup({}, false);
    await s.client.createTransfer('k3', { ...acct, amount: 5n });
    s.advance(1000);
    await s.tick();
    expect(s.received).toHaveLength(0);
    s.setUp(true);
    s.advance(60_000);
    await s.tick();
    expect(s.received).toHaveLength(1);
  });

  it('dropped callbacks can be reconciled via GET /v1/transfers/:id', async () => {
    const s = setup({ DROP_CALLBACK_RATE: 1 });
    const t = await s.client.createTransfer('k4', { ...acct, amount: 5n });
    s.advance(5000);
    await s.tick();
    expect(s.received).toHaveLength(0);
    expect((await s.client.getTransfer(t.transferId)).status).toBe('success');
  });

  it('fails transfers to a closed account with ACCOUNT_CLOSED', async () => {
    const s = setup();
    const t = await s.client.createTransfer('k5', {
      bankCode: '002',
      accountNumber: '9990000001',
      accountName: 'PT TUTUP BUKU SELAMANYA',
      amount: 5n,
    });
    s.advance(1000);
    const after = await s.client.getTransfer(t.transferId);
    expect(after).toMatchObject({ status: 'failed', reason: 'ACCOUNT_CLOSED' });
  });

  it('late callbacks are delayed by LATE_CALLBACK_MS', async () => {
    const s = setup({ LATE_CALLBACK_MS: 10_000 });
    await s.client.createTransfer('k6', { ...acct, amount: 5n });
    s.advance(1000);
    await s.tick();
    expect(s.received).toHaveLength(0);
    s.advance(10_000);
    await s.tick();
    expect(s.received).toHaveLength(1);
  });
});
