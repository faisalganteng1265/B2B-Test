import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { swaggerUI } from '@hono/swagger-ui';
import { and, asc, eq, sql } from 'drizzle-orm';
import { auditLog, clients, clientWallets, deposits, type Db } from '@mopay/db';
import { verifyMessage, type Hex } from 'viem';
import {
  errMsg,
  IndodaxClient,
  PriceFeed,
  parseToken,
  sendTokenTransfers,
  UpstreamError,
  type Logger,
} from '@mopay/shared';
import { handleBifastCallback, type PayoutSignal } from '@mopay/workflow';
import { adminAuth, clientAuth, type AuthEnv } from './auth';
import type { ApiEnv } from './env';
import type { Notifier } from './notifier';
import { indicativeQuote, priceView, sharedDepositAddress, Treasury } from './exchange';
import {
  alerts,
  depositCounts,
  depositDetail,
  indexerStatus,
  ledgerOverview,
  listClients,
  listDeposits,
  payoutsToday,
} from './queries';

export interface ApiDeps {
  db: Db;
  env: ApiEnv;
  log: Logger;
  chainId: number;
  chainName: string;
  explorerTxUrl: (h: string) => string | null;
  tokens: Record<string, string>; // symbol -> address
  /** exchange (PAKD): INDODAX Trade API 2.0 */
  indodax: IndodaxClient;
  /** real public Indodax order book */
  priceFeed: PriceFeed;
  notifier: Notifier;
  resolveAwakeable: (id: string, payload: PayoutSignal) => Promise<void>;
  submitWorkflow: (workflowId: string, depositId: string) => Promise<string>;
  fetchImpl?: typeof fetch;
}

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) }).openapi('Error');
const OfframpSchema = z
  .object({
    step: z.string(),
    rate: z.string().nullable(),
    priceAsOf: z.string().nullable(),
    priceSource: z.string().nullable(),
    grossIdr: z.string().nullable(),
    feeIdr: z.string().nullable(),
    idrAmount: z.string().nullable(),
    lastError: z.string().nullable(),
  })
  .partial()
  .nullable();
const DepositSchema = z
  .object({
    id: z.string().uuid(),
    chainId: z.number(),
    token: z.string(),
    txHash: z.string(),
    logIndex: z.number(),
    blockNumber: z.number(),
    amount: z.string().nullable().openapi({ example: '1000.5' }),
    amountBaseUnits: z.string().nullable(),
    status: z.enum(['seen', 'confirmed', 'dispatched', 'orphaned', 'completed', 'failed', 'manual_review']),
    statusReason: z.string().nullable(),
    confirmations: z.number(),
    firstSeenAt: z.string(),
    completedAt: z.string().nullable(),
    offramp: OfframpSchema,
  })
  .passthrough()
  .openapi('Deposit');
const TimelineSchema = z.object({
  step: z.string(),
  state: z.enum(['pending', 'running', 'done', 'failed']),
  attempts: z.number(),
  retries: z.number(),
  lastError: z.string().nullable(),
});
const DepositDetailSchema = DepositSchema.extend({ timeline: z.array(TimelineSchema) })
  .passthrough()
  .openapi('DepositDetail');
const DepositAddressSchema = z
  .object({
    chainId: z.number(),
    address: z.string(),
    source: z.string(),
    kind: z.literal('shared'),
    createdAt: z.string(),
    registeredWallets: z.array(z.string()),
    instructions: z.string(),
  })
  .openapi('DepositInstructions');
const QuoteSchema = z
  .object({
    amount: z.string(),
    rate: z.string(),
    grossIdr: z.string(),
    exchangeFeeIdr: z.string(),
    exchangeFeeBps: z.string(),
    feeIdr: z.string(),
    netIdr: z.string(),
    feeBps: z.string(),
    priceSource: z.string(),
    priceAsOf: z.string(),
    stale: z.boolean(),
    slippageBps: z.string(),
    indicative: z.literal(true),
  })
  .openapi('IndicativeQuote');

const json = <T>(v: T) =>
  JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))) as T;

export const walletRegistrationMessage = (clientId: string, address: string) =>
  `Mopay wallet registration\nclient:${clientId}\nwallet:${address.toLowerCase()}`;

export function createApp(d: ApiDeps) {
  const app = new OpenAPIHono<AuthEnv>({
    defaultHook: (r, c) => {
      if (!r.success) return c.json({ error: { code: 'VALIDATION', message: r.error.message } }, 400);
    },
  });
  app.onError((err, c) => {
    if (err instanceof UpstreamError) {
      d.log.warn({ err: err.message, code: err.code }, 'upstream error');
      return c.json({ error: { code: err.code, message: err.message } }, err.retryable ? 503 : 502);
    }
    d.log.error({ err }, 'unhandled');
    return c.json({ error: { code: 'INTERNAL', message: 'internal error' } }, 500);
  });

  app.get('/healthz', (c) => c.json({ ok: true }));
  app.get('/readyz', async (c) => {
    try {
      await d.db.execute(sql`select 1`);
      return c.json({ ready: true });
    } catch (e) {
      return c.json({ ready: false, error: errMsg(e) }, 503);
    }
  });

  // ---------------------------------------------------------------- B2B API (client API key)
  app.openAPIRegistry.registerComponent('securitySchemes', 'ApiKey', {
    type: 'http',
    scheme: 'bearer',
    description: 'mpk_… client API key',
  });
  app.use('/v1/deposit-addresses', clientAuth(d.db, d.env.RATE_LIMIT_PER_MIN));
  app.use('/v1/wallets', clientAuth(d.db, d.env.RATE_LIMIT_PER_MIN));
  app.use('/v1/deposits', clientAuth(d.db, d.env.RATE_LIMIT_PER_MIN));
  app.use('/v1/deposits/*', clientAuth(d.db, d.env.RATE_LIMIT_PER_MIN));
  app.use('/v1/quotes/*', clientAuth(d.db, d.env.RATE_LIMIT_PER_MIN));

  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/deposit-addresses',
      summary: 'Where to send USDT',
      description:
        "Returns Mopay's deposit address at the exchange (Indodax gives ONE address per account). Deposits are " +
        'attributed to you by the SENDER: only transfers from your registered wallets (POST /v1/wallets) are ' +
        'processed. Transfers from any other wallet are held for manual review.',
      security: [{ ApiKey: [] }],
      request: {
        body: {
          required: false,
          content: { 'application/json': { schema: z.object({ chainId: z.number().int().optional() }) } },
        },
      },
      responses: {
        200: {
          description: 'Deposit instructions',
          content: { 'application/json': { schema: DepositAddressSchema } },
        },
        401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const client = c.get('client');
      const chainId = (c.req.valid('json') ?? {}).chainId ?? d.chainId;
      if (chainId !== d.chainId)
        return c.json(
          { error: { code: 'UNSUPPORTED_CHAIN', message: `only chain ${d.chainId}` } },
          400,
        ) as never;
      const shared = await sharedDepositAddress(d.db, chainId);
      if (!shared)
        return c.json(
          { error: { code: 'NOT_READY', message: 'exchange deposit address not provisioned' } },
          503,
        ) as never;
      const wallets = await d.db
        .select()
        .from(clientWallets)
        .where(and(eq(clientWallets.clientId, client.id), eq(clientWallets.chainId, chainId)));
      return c.json(
        {
          chainId,
          address: shared.address,
          source: shared.source,
          kind: 'shared' as const,
          createdAt: shared.createdAt.toISOString(),
          registeredWallets: wallets.map((w) => w.address),
          instructions: 'Send USDT only from a registered wallet. Register wallets with POST /v1/wallets.',
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/wallets',
      summary: 'Register a sender wallet (proof of ownership)',
      description:
        'Sign the message returned in the 400 response (or: "Mopay wallet registration\\nclient:<clientId>\\nwallet:<lowercase address>") ' +
        'with the wallet (EIP-191 personal_sign). Deposits from this wallet are then attributed to you.',
      security: [{ ApiKey: [] }],
      request: {
        body: {
          required: true,
          content: {
            'application/json': {
              schema: z.object({
                address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
                signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
                label: z.string().max(80).optional(),
              }),
            },
          },
        },
      },
      responses: {
        200: {
          description: 'Registered',
          content: {
            'application/json': { schema: z.object({ address: z.string(), verified: z.boolean() }) },
          },
        },
        400: { description: 'Bad signature', content: { 'application/json': { schema: ErrorSchema } } },
        409: {
          description: 'Wallet belongs to another client',
          content: { 'application/json': { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      const client = c.get('client');
      const b = c.req.valid('json');
      const address = b.address.toLowerCase();
      const message = walletRegistrationMessage(client.id, address);
      const ok = await verifyMessage({
        address: b.address as Hex,
        message,
        signature: b.signature as Hex,
      }).catch(() => false);
      if (!ok)
        return c.json(
          { error: { code: 'INVALID_SIGNATURE', message: `sign exactly: ${JSON.stringify(message)}` } },
          400,
        );
      const existing = await d.db.query.clientWallets.findFirst({
        where: and(eq(clientWallets.chainId, d.chainId), eq(clientWallets.address, address)),
      });
      if (existing && existing.clientId !== client.id)
        return c.json(
          { error: { code: 'WALLET_TAKEN', message: 'wallet registered to another client' } },
          409,
        );
      if (!existing) {
        await d.db.insert(clientWallets).values({
          clientId: client.id,
          chainId: d.chainId,
          address,
          label: b.label,
          verifiedAt: new Date(),
        });
        await d.db.insert(auditLog).values({
          actor: `client:${client.id}`,
          action: 'wallet_registered',
          entity: 'client',
          entityId: client.id,
          data: { address },
        });
      }
      return c.json({ address, verified: true }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/deposits',
      summary: 'List your deposits',
      security: [{ ApiKey: [] }],
      request: {
        query: z.object({
          status: DepositSchema.shape.status.optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        }),
      },
      responses: {
        200: {
          description: 'Deposits',
          content: { 'application/json': { schema: z.object({ data: z.array(DepositSchema) }) } },
        },
      },
    }),
    async (c) => {
      const q = c.req.valid('query');
      const data = await listDeposits(d.db, {
        clientId: c.get('client').id,
        status: q.status,
        limit: q.limit,
      });
      return c.json(json({ data }) as never, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/deposits/{id}',
      summary: 'Deposit status with the workflow timeline',
      security: [{ ApiKey: [] }],
      request: { params: z.object({ id: z.string().uuid() }) },
      responses: {
        200: { description: 'Deposit', content: { 'application/json': { schema: DepositDetailSchema } } },
        404: { description: 'Not found', content: { 'application/json': { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const det = await depositDetail(d.db, c.req.valid('param').id, c.get('client').id);
      if (!det) return c.json({ error: { code: 'NOT_FOUND', message: 'deposit not found' } }, 404);
      const { ledger: _l, audit: _a, events: _e, ...pub } = det;
      return c.json(json(pub) as never, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/quotes/indicative',
      summary: 'Indicative IDR for an amount of USDT (read-only, not locked)',
      description:
        'Rate = VWAP of the live Indodax USDT/IDR bid book for this size. Fee rounded up, net rounded down.',
      security: [{ ApiKey: [] }],
      request: {
        query: z.object({
          amount: z
            .string()
            .regex(/^\d+(\.\d{1,6})?$/)
            .openapi({ example: '1000' }),
        }),
      },
      responses: {
        200: { description: 'Quote', content: { 'application/json': { schema: QuoteSchema } } },
        503: { description: 'Price unavailable', content: { 'application/json': { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const amount = parseToken(c.req.valid('query').amount);
      if (amount <= 0n)
        return c.json({ error: { code: 'VALIDATION', message: 'amount must be > 0' } }, 400) as never;
      return c.json(
        await indicativeQuote(d.priceFeed, amount, d.env.INDODAX_COMMISSION_BPS, d.env.FEE_BPS),
        200,
      );
    },
  );

  // ---------------------------------------------------------------- BI-FAST webhook
  app.post('/webhooks/bifast', async (c) => {
    const raw = await c.req.text(); // RAW body: the HMAC is over the exact bytes
    const r = await handleBifastCallback(
      {
        db: d.db,
        webhookSecret: d.env.BIFAST_WEBHOOK_SECRET,
        resolveAwakeable: d.resolveAwakeable,
        log: d.log,
      },
      raw,
      c.req.header('x-signature'),
    );
    return c.json(r.body, r.http);
  });

  // ---------------------------------------------------------------- OpenAPI docs
  app.doc31('/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'Mopay B2B Offramp API (prototype)',
      version: '0.1.0',
      description: 'USDT → IDR offramp. Crypto held by a licensed PAKD, IDR paid via BI-FAST by a PJP.',
    },
  });
  app.get('/docs', swaggerUI({ url: '/openapi.json' }));

  // ---------------------------------------------------------------- SSE + admin
  app.route('/', adminRoutes(d));
  return app;
}

function adminRoutes(d: ApiDeps) {
  const a = new Hono();
  const fetchImpl = d.fetchImpl ?? fetch;
  a.use('/v1/stream', adminAuth(d.env.ADMIN_TOKEN));
  a.use('/admin/*', adminAuth(d.env.ADMIN_TOKEN));

  async function price() {
    try {
      return await priceView(d.priceFeed);
    } catch {
      return null;
    }
  }
  const treasury = new Treasury(
    d.db,
    d.indodax,
    { bankCode: d.env.MOPAY_BANK_CODE, accountNumber: d.env.MOPAY_BANK_ACCOUNT },
    d.log,
  );

  async function overview() {
    const [idx, counts, today, al, p] = await Promise.all([
      indexerStatus(d.db, d.chainId),
      depositCounts(d.db),
      payoutsToday(d.db),
      alerts(d.db),
      price(),
    ]);
    return {
      chain: { id: d.chainId, name: d.chainName },
      indexer: idx,
      deposits: counts,
      payoutsToday: today,
      alerts: al,
      price: p,
      at: new Date(),
    };
  }

  a.get('/v1/stream', (c) =>
    streamSSE(c, async (stream) => {
      let closed = false;
      const queue: string[] = [];
      const unsub = d.notifier.subscribe((payload) => queue.push(payload));
      stream.onAbort(() => {
        closed = true;
        unsub();
      });
      await stream.writeSSE({ event: 'hello', data: JSON.stringify({ at: new Date() }) });
      let lastMetrics = 0;
      while (!closed) {
        // coalesce bursts: send queued change events, then a metrics snapshot every 2s
        while (queue.length) {
          const p = queue.shift()!;
          let type = 'change';
          try {
            type = (JSON.parse(p) as { type?: string }).type ?? 'change';
          } catch {
            /* keep generic */
          }
          await stream.writeSSE({ event: type, data: p });
        }
        if (Date.now() - lastMetrics > 2000) {
          lastMetrics = Date.now();
          try {
            await stream.writeSSE({ event: 'metrics', data: JSON.stringify(json(await overview())) });
          } catch (e) {
            d.log.warn({ err: errMsg(e) }, 'sse metrics failed');
          }
        }
        await stream.sleep(250);
      }
    }),
  );

  a.get('/admin/overview', async (c) => c.json(json(await overview())));
  a.get('/admin/metrics', async (c) => c.json(json(await overview())));
  a.get('/admin/price', async (c) => {
    const p = await price();
    return p ? c.json(p) : c.json({ error: { code: 'PRICE_UNAVAILABLE', message: 'no price' } }, 503);
  });
  a.get('/admin/deposits', async (c) => {
    const status = c.req.query('status') as Parameters<typeof listDeposits>[1]['status'];
    const data = await listDeposits(d.db, { status, limit: Number(c.req.query('limit') ?? 200) });
    return c.json(json({ data: data.map((x) => ({ ...x, explorerUrl: d.explorerTxUrl(x.txHash) })) }));
  });
  a.get('/admin/deposits/:id', async (c) => {
    const det = await depositDetail(d.db, c.req.param('id'));
    if (!det) return c.json({ error: { code: 'NOT_FOUND', message: 'deposit not found' } }, 404);
    return c.json(json({ ...det, explorerUrl: d.explorerTxUrl(det.txHash) }));
  });
  a.get('/admin/clients', async (c) => c.json(json({ data: await listClients(d.db, d.chainId) })));
  a.get('/admin/ledger', async (c) =>
    c.json(json(await ledgerOverview(d.db, c.req.query('depositId') || undefined))),
  );

  // Re-drive a manual_review deposit. Reuses the canonical idempotency keys → cannot double pay.
  a.post('/admin/deposits/:id/retry', async (c) => {
    const id = c.req.param('id');
    const dep = await d.db.query.deposits.findFirst({ where: eq(deposits.id, id) });
    if (!dep) return c.json({ error: { code: 'NOT_FOUND', message: 'deposit not found' } }, 404);
    if (dep.status !== 'manual_review')
      return c.json({ error: { code: 'INVALID_STATUS', message: `status is ${dep.status}` } }, 409);
    if ((dep.statusReason ?? '').startsWith('INCIDENT')) {
      return c.json(
        {
          error: {
            code: 'REORG_INCIDENT',
            message: 'reorg incidents must be resolved manually, not re-driven',
          },
        },
        409,
      );
    }
    const [r] = await d.db
      .select({ n: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(
        and(eq(auditLog.entity, 'deposit'), eq(auditLog.entityId, id), eq(auditLog.action, 'admin_retry')),
      );
    const key = `${dep.workflowId}#retry-${Number(r?.n ?? 0) + 1}`;
    await d.db.transaction(async (tx) => {
      await tx
        .update(deposits)
        .set({ status: 'dispatched', statusReason: `admin retry (${key})` })
        .where(eq(deposits.id, id));
      await tx.insert(auditLog).values({
        actor: 'admin',
        action: 'admin_retry',
        entity: 'deposit',
        entityId: id,
        data: { key, previousReason: dep.statusReason },
      });
    });
    const status = await d.submitWorkflow(key, id);
    return c.json({ ok: true, workflowKey: key, restate: status });
  });

  // Chaos control (proxied to the mocks' /__chaos).
  const chaosTarget = (t: string) =>
    t === 'exchange' ? `${d.env.INDODAX_URL}/__chaos` : t === 'bifast' ? `${d.env.BIFAST_URL}/__chaos` : null;
  a.get('/admin/chaos', async (c) => {
    const out: Record<string, unknown> = {};
    for (const t of ['exchange', 'bifast']) {
      try {
        const r = await fetchImpl(chaosTarget(t)!, {
          headers: { 'x-admin-token': d.env.ADMIN_TOKEN },
          signal: AbortSignal.timeout(3000),
        });
        out[t] = await r.json();
      } catch (e) {
        out[t] = { error: errMsg(e) };
      }
    }
    return c.json(out);
  });
  a.post('/admin/chaos/:target', async (c) => {
    const url = chaosTarget(c.req.param('target'));
    if (!url)
      return c.json({ error: { code: 'VALIDATION', message: 'target must be exchange|bifast' } }, 400);
    const body = await c.req.text();
    const r = await fetchImpl(url, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', 'x-admin-token': d.env.ADMIN_TOKEN },
      signal: AbortSignal.timeout(5000),
    });
    await d.db.insert(auditLog).values({
      actor: 'admin',
      action: 'chaos_update',
      entity: 'mock',
      entityId: c.req.param('target'),
      data: JSON.parse(body || '{}'),
    });
    return c.json(await r.json(), r.status as 200);
  });

  // Demo: send real mUSDT on Base Sepolia from a client test wallet to its deposit address.
  const demoBody = z.object({
    clientId: z.string().uuid().optional(),
    amount: z
      .string()
      .regex(/^\d+(\.\d{1,6})?$/)
      .default('100'),
    count: z.number().int().min(1).max(50).default(1),
    randomize: z.boolean().default(false),
  });
  a.post('/admin/demo/deposits', async (c) => {
    if (!d.env.DEMO_TX_ENABLED)
      return c.json({ error: { code: 'DISABLED', message: 'DEMO_TX_ENABLED=false' } }, 403);
    const b = demoBody.safeParse(await c.req.json().catch(() => ({})));
    if (!b.success) return c.json({ error: { code: 'VALIDATION', message: b.error.message } }, 400);
    const all = await d.db.select().from(clients).orderBy(asc(clients.createdAt));
    const keys = [d.env.CLIENT_A_PRIVATE_KEY, d.env.CLIENT_B_PRIVATE_KEY];
    const targets = b.data.clientId ? all.filter((x) => x.id === b.data.clientId) : all.slice(0, 2);
    if (!targets.length) return c.json({ error: { code: 'NOT_FOUND', message: 'client not found' } }, 404);
    const results = [];
    const perClient = Math.ceil(b.data.count / targets.length);
    let remaining = b.data.count;
    for (const t of targets) {
      const idx = all.findIndex((x) => x.id === t.id);
      const pk = keys[idx];
      if (!pk)
        return c.json(
          { error: { code: 'NO_WALLET', message: `no demo wallet configured for client #${idx}` } },
          400,
        );
      const addr = await sharedDepositAddress(d.db, d.chainId);
      if (!addr)
        return c.json(
          { error: { code: 'NO_ADDRESS', message: 'exchange deposit address not provisioned' } },
          400,
        );
      const n = Math.min(perClient, remaining);
      remaining -= n;
      if (n <= 0) continue;
      const base = parseToken(b.data.amount);
      const amounts = Array.from({ length: n }, () =>
        b.data.randomize ? base + BigInt(Math.floor(Math.random() * 1_000_000_000)) : base,
      );
      const r = await sendTokenTransfers({
        chainId: d.chainId,
        rpcUrls: d.env.RPC_URLS,
        token: d.tokens.USDT!,
        privateKey: pk,
        to: addr.address,
        amounts,
      });
      results.push({
        client: t.name,
        from: r.from,
        to: addr.address,
        txs: r.hashes.map((h) => ({ hash: h, explorerUrl: d.explorerTxUrl(h) })),
      });
      await d.db.insert(auditLog).values({
        actor: 'admin',
        action: 'demo_deposit_sent',
        entity: 'client',
        entityId: t.id,
        data: { count: n, amount: b.data.amount, hashes: r.hashes },
      });
    }
    return c.json({ ok: true, results });
  });

  // Assign an unattributed deposit (unknown sender) to a client, optionally registering the
  // sender wallet, then re-drive it. Only possible after it was parked as UNATTRIBUTED (final).
  a.post('/admin/deposits/:id/assign', async (c) => {
    const id = c.req.param('id');
    const b = z
      .object({ clientId: z.string().uuid(), registerWallet: z.boolean().default(false) })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!b.success) return c.json({ error: { code: 'VALIDATION', message: b.error.message } }, 400);
    const dep = await d.db.query.deposits.findFirst({ where: eq(deposits.id, id) });
    if (!dep) return c.json({ error: { code: 'NOT_FOUND', message: 'deposit not found' } }, 404);
    if (dep.clientId || dep.status !== 'manual_review')
      return c.json(
        {
          error: {
            code: 'INVALID_STATUS',
            message: 'only unattributed deposits in manual_review can be assigned',
          },
        },
        409,
      );
    const client = await d.db.query.clients.findFirst({ where: eq(clients.id, b.data.clientId) });
    if (!client) return c.json({ error: { code: 'NOT_FOUND', message: 'client not found' } }, 404);
    const key = `${dep.workflowId}#retry-1`;
    await d.db.transaction(async (tx) => {
      await tx.update(deposits).set({ clientId: client.id }).where(eq(deposits.id, id));
      if (b.data.registerWallet)
        await tx
          .insert(clientWallets)
          .values({
            clientId: client.id,
            chainId: dep.chainId,
            address: dep.fromAddress,
            label: 'assigned by operator',
            verifiedAt: new Date(),
          })
          .onConflictDoNothing();
      await tx
        .update(deposits)
        .set({ status: 'dispatched', statusReason: `assigned to ${client.name} by admin` })
        .where(eq(deposits.id, id));
      await tx.insert(auditLog).values({
        actor: 'admin',
        action: 'admin_retry',
        entity: 'deposit',
        entityId: id,
        data: { key, assignedTo: client.id, registerWallet: b.data.registerWallet },
      });
    });
    const status = await d.submitWorkflow(key, id);
    return c.json({ ok: true, workflowKey: key, restate: status });
  });

  // Exchange (Indodax) account view + treasury sweeps to Mopay's bank account.
  a.get('/admin/exchange', async (c) => {
    const shared = await sharedDepositAddress(d.db, d.chainId);
    let account = null;
    let sweeps: unknown[] = [];
    try {
      account = await d.indodax.account();
      sweeps = await treasury.reconcile();
    } catch (e) {
      return c.json(json({ depositAddress: shared?.address ?? null, error: errMsg(e), sweeps }));
    }
    return c.json(
      json({
        depositAddress: shared?.address ?? null,
        network: 'base',
        account,
        sweeps,
        bank: { bankCode: d.env.MOPAY_BANK_CODE, accountNumber: d.env.MOPAY_BANK_ACCOUNT },
      }),
    );
  });
  a.post('/admin/treasury/sweep', async (c) => {
    const b = z
      .object({ amount: z.string().regex(/^\d+$/).optional() })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!b.success) return c.json({ error: { code: 'VALIDATION', message: b.error.message } }, 400);
    const acct = await d.indodax.account();
    const free = BigInt(acct.balances.find((x) => x.asset === 'IDR')?.free ?? '0');
    const amount = b.data.amount ? BigInt(b.data.amount) : free;
    if (amount > free)
      return c.json(
        { error: { code: 'INSUFFICIENT_BALANCE', message: `exchange IDR balance is ${free}` } },
        400,
      );
    try {
      const row = await treasury.sweep(amount);
      await d.db.insert(auditLog).values({
        actor: 'admin',
        action: 'treasury_sweep',
        entity: 'treasury',
        entityId: row!.id,
        data: { amount: amount.toString() },
      });
      return c.json(json({ ok: true, sweep: row }));
    } catch (e) {
      return c.json({ error: { code: 'SWEEP_REJECTED', message: errMsg(e) } }, 400);
    }
  });

  // Indexer passthrough (the dashboard shows these too)
  a.get('/admin/indexer', async (c) => {
    try {
      const r = await fetchImpl(`${d.env.INDEXER_URL}/status`, { signal: AbortSignal.timeout(3000) });
      return c.json(await r.json());
    } catch (e) {
      return c.json(
        {
          error: { code: 'INDEXER_UNREACHABLE', message: errMsg(e) },
          db: json(await indexerStatus(d.db, d.chainId)),
        },
        503,
      );
    }
  });
  return a;
}
