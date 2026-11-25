import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http2 from 'node:http2';
import { randomBytes } from 'node:crypto';
import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import * as restate from '@restatedev/restate-sdk';
import * as clients from '@restatedev/restate-sdk-clients';
import type { Hex } from 'viem';
import { eq, sql } from 'drizzle-orm';
import { repoRoot } from '@mopay/config';
import {
  deposits,
  clients as clientsTbl,
  resetTestDb,
  seedIndodax,
  clientWallets,
  findUnbalancedJournals,
  payouts,
  type DbHandle,
} from '@mopay/db';
import {
  BifastClient,
  Chaos,
  createLogger,
  depositWorkflowId,
  IndodaxClient,
  PriceFeed,
} from '@mopay/shared';
import { createIndodaxMock, IndodaxStore, type TransferLog } from '@mopay/indodax-mock';
import { createBifast } from '@mopay/bifast-mock';
import {
  createOfframpWorkflow,
  handleBifastCallback,
  restateAwakeableResolver,
  registerDeployment,
  type OfframpConfig,
} from '../src';

export const PORTS = {
  ingress: 18080,
  admin: 19070,
  node: 15122,
  workflow: 19080,
  indodax: 14100,
  bifast: 14200,
  webhook: 14000,
};
const CHAIN = 84532;
const USDT = '0x00000000000000000000000000000000000000aa';
const SECRET = {
  indodaxKey: 'TEST-INDODAX-KEY',
  indodax: 'test-indodax-secret-0123456789',
  bifastWebhook: 'test-webhook-secret',
};
const SENDERS = ['0x00000000000000000000000000000000000000c1', '0x00000000000000000000000000000000000000c2'];
export const log = createLogger('wf-test', process.env.TEST_LOG ?? 'silent');

async function waitHttp(url: string, timeoutMs = 30_000) {
  const t = Date.now();
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() - t > timeoutMs) throw new Error(`timeout waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

export class Harness {
  restateProc!: ChildProcess;
  restateDir!: string;
  h!: DbHandle;
  wfServer: http2.Http2Server | null = null;
  sessions = new Set<http2.ServerHttp2Session>();
  servers: ServerType[] = [];
  exchangeChaos = new Chaos();
  bifastChaos = new Chaos();
  exchangeStore = new IndodaxStore(':memory:');
  /** on-chain transfers the mock exchange's deposit scanner can see */
  chainLogs: TransferLog[] = [];
  head = 1000;
  scanTick: NodeJS.Timeout | null = null;
  sharedAddress = '';
  bifastTick: NodeJS.Timeout | null = null;
  ingress = clients.connect({ url: `http://127.0.0.1:${PORTS.ingress}` });
  indodax = new IndodaxClient({
    baseUrl: `http://127.0.0.1:${PORTS.indodax}`,
    apiKey: SECRET.indodaxKey,
    apiSecret: SECRET.indodax,
    timeoutMs: 1500,
  });
  priceFeed = new PriceFeed({ source: 'fixed', fixedRate: '16250' });
  bifastClient = new BifastClient({
    baseUrl: `http://127.0.0.1:${PORTS.bifast}`,
    apiKey: 'pjp',
    timeoutMs: 1500,
  });
  bifastDb!: ReturnType<typeof createBifast>['db'];
  webhookCalls = 0;
  exchangeDeps!: Parameters<typeof createIndodaxMock>[0];
  /** delay injected into POST /api/v2/order (to kill the workflow mid-sell) */
  confirmDelayMs = 0;

  cfg: OfframpConfig = {
    minAmountBaseUnits: 1_000_000n,
    feeBps: 35n,
    maxSlippageBps: 50n,
    fillPollMs: 150,
    creditPollMs: 150,
    creditPollMaxMs: 600,
    payoutCallbackTimeoutMs: 1500,
    initialRetryIntervalMs: 50,
    maxRetryIntervalMs: 800,
    alertAfterAttempts: 10,
  };

  async start() {
    this.h = await resetTestDb();
    this.restateDir = mkdtempSync(join(tmpdir(), 'rs-'));
    this.restateProc = spawn(
      join(repoRoot(), 'node_modules/.bin/restate-server'),
      ['--listen-mode', 'tcp', '--base-dir', this.restateDir, '--node-name', 'wftest'],
      {
        env: {
          ...process.env,
          RESTATE_INGRESS__BIND_ADDRESS: `127.0.0.1:${PORTS.ingress}`,
          RESTATE_ADMIN__BIND_ADDRESS: `127.0.0.1:${PORTS.admin}`,
          RESTATE_BIND_ADDRESS: `127.0.0.1:${PORTS.node}`,
          RESTATE_ADVERTISED_ADDRESS: `http://127.0.0.1:${PORTS.node}`,
          RESTATE_LOG_FILTER: 'warn',
        },
        stdio: 'ignore',
      },
    );

    // indodax-mock (TAPIv2) with a fake chain scanner (transfers registered by the test) and a fixed book
    this.exchangeDeps = {
      store: this.exchangeStore,
      priceFeed: this.priceFeed,
      chaos: this.exchangeChaos,
      apiKey: SECRET.indodaxKey,
      apiSecret: SECRET.indodax,
      adminToken: 'admin-token',
      tokens: { [USDT]: 'USDT' },
      tokenDecimals: 6,
      network: 'base',
      scanner: {
        head: async () => this.head,
        logs: async (from, to, address) =>
          this.chainLogs.filter((l) => l.blockNumber >= from && l.blockNumber <= to && l.to === address),
      },
      scanStartBlock: 1,
      minConfirm: 1,
      creditDelayMs: [0, 300],
      commissionBps: 41n,
      orderVisibilityDelayMs: 300,
      kycBank: { bankCode: '014', accountNumber: '5270011223', accountName: 'PT MOPAY' },
      fiatWithdrawFeeIdr: 10_000n,
      fiatSettleMs: 500,
      log,
    };
    const exchange = createIndodaxMock(this.exchangeDeps);
    this.sharedAddress = exchange.depositAddress('USDT');
    this.scanTick = setInterval(() => void exchange.scanOnce().catch(() => {}), 100);
    const slowOrder = new Hono();
    slowOrder.use('/api/v2/order', async (c, next) => {
      if (this.confirmDelayMs && c.req.method === 'POST')
        await new Promise((r) => setTimeout(r, this.confirmDelayMs));
      await next();
    });
    slowOrder.route('/', exchange.app);
    this.servers.push(serve({ fetch: slowOrder.fetch, port: PORTS.indodax }));

    const bifast = createBifast({
      dbPath: ':memory:',
      chaos: this.bifastChaos,
      apiKey: 'pjp',
      adminToken: 'admin-token',
      webhookSecret: SECRET.bifastWebhook,
      callbackUrl: `http://127.0.0.1:${PORTS.webhook}/webhooks/bifast`,
      settleMs: [100, 600],
      log,
    });
    this.bifastDb = bifast.db;
    this.servers.push(serve({ fetch: bifast.app.fetch, port: PORTS.bifast }));
    this.bifastTick = setInterval(() => void bifast.tick(), 100);

    // Mopay webhook receiver = production callback handler
    const resolve = restateAwakeableResolver(`http://127.0.0.1:${PORTS.ingress}`);
    const hook = new Hono();
    hook.post('/webhooks/bifast', async (c) => {
      this.webhookCalls++;
      const raw = await c.req.text();
      const r = await handleBifastCallback(
        { db: this.h.db, webhookSecret: SECRET.bifastWebhook, resolveAwakeable: resolve, log },
        raw,
        c.req.header('x-signature'),
      );
      return c.json(r.body, r.http);
    });
    this.servers.push(serve({ fetch: hook.fetch, port: PORTS.webhook }));

    await waitHttp(`http://127.0.0.1:${PORTS.admin}/health`);
    this.startWorkflow();
    await registerDeployment(`http://127.0.0.1:${PORTS.admin}`, `http://127.0.0.1:${PORTS.workflow}`);

    // clients + their registered wallets + the exchange's shared deposit address
    const [addr] = await this.indodax.depositAddresses('USDT', 'base');
    await seedIndodax(this.h.db, CHAIN, addr!.address, SENDERS);
  }

  startWorkflow() {
    const wf = createOfframpWorkflow({
      db: this.h.db,
      indodax: this.indodax,
      priceFeed: this.priceFeed,
      bifast: this.bifastClient,
      cfg: this.cfg,
      log,
    });
    const server = http2.createServer(restate.createEndpointHandler({ services: [wf] }));
    server.on('session', (s) => {
      this.sessions.add(s);
      s.on('close', () => this.sessions.delete(s));
    });
    server.listen(PORTS.workflow);
    this.wfServer = server;
  }

  /** Hard-kill the workflow service: drop every connection immediately. */
  async killWorkflow() {
    for (const s of this.sessions) s.destroy();
    await new Promise<void>((r) => (this.wfServer ? this.wfServer.close(() => r()) : r()));
    this.wfServer = null;
  }

  async stop() {
    if (this.bifastTick) clearInterval(this.bifastTick);
    if (this.scanTick) clearInterval(this.scanTick);
    await this.killWorkflow().catch(() => {});
    for (const s of this.servers) s.close();
    this.restateProc?.kill('SIGKILL');
    await this.h?.close();
    rmSync(this.restateDir, { recursive: true, force: true });
  }

  /** Create an on-chain-looking deposit from a client's registered wallet to the shared address. */
  async createDeposit(clientIndex: number, amount: bigint) {
    const rows = await this.h.db
      .select({ clientId: clientsTbl.id, wallet: clientWallets.address })
      .from(clientsTbl)
      .innerJoin(clientWallets, eq(clientWallets.clientId, clientsTbl.id))
      .orderBy(clientsTbl.createdAt);
    const c = rows[clientIndex % rows.length]!;
    const txHash = `0x${randomBytes(32).toString('hex')}` as Hex;
    this.head += 1;
    this.chainLogs.push({
      txHash,
      logIndex: 0,
      blockNumber: this.head,
      from: c.wallet,
      to: this.sharedAddress,
      token: USDT,
      value: amount,
    });
    this.head += 1; // one confirmation on top
    const workflowId = depositWorkflowId(CHAIN, txHash, 0);
    const [d] = await this.h.db
      .insert(deposits)
      .values({
        chainId: CHAIN,
        tokenAddress: USDT,
        tokenSymbol: 'USDT',
        txHash,
        logIndex: 0,
        blockNumber: this.head - 1,
        blockHash: `0x${'b'.repeat(64)}`,
        fromAddress: c.wallet,
        toAddress: this.sharedAddress,
        amountBaseUnits: amount,
        clientId: c.clientId,
        status: 'confirmed',
        source: 'live',
        workflowId,
      })
      .returning();
    await this.h.db
      .update(deposits)
      .set({ status: 'dispatched', dispatchedAt: new Date() })
      .where(eq(deposits.id, d!.id));
    return { id: d!.id, workflowId, txHash, clientId: c.clientId };
  }

  submit(workflowId: string, depositId: string) {
    type Def = { run: (ctx: unknown, input: { depositId: string }) => Promise<unknown> };
    return this.ingress
      .workflowClient<Def>({ name: 'offramp' } as clients.WorkflowDefinitionFrom<Def>, workflowId)
      .workflowSubmit({ depositId });
  }

  async statusCounts() {
    const rows = await this.h.db
      .select({ s: deposits.status, n: sql<number>`count(*)::int` })
      .from(deposits)
      .groupBy(deposits.status);
    return Object.fromEntries(rows.map((r) => [r.s, Number(r.n)])) as Record<string, number>;
  }

  /** The invariants the system must never violate. */
  async invariants() {
    const unbalanced = await findUnbalancedJournals(this.h.db);
    const counts = await this.statusCounts();
    const [p] = await this.h.db
      .select({
        n: sql<number>`count(*)::int`,
        ok: sql<number>`count(*) filter (where status = 'success')::int`,
      })
      .from(payouts);
    const exchangeOrders = (
      this.exchangeStore.db.prepare('SELECT count(*) AS n FROM orders').get() as { n: number }
    ).n;
    // one sell per deposit: client order ids are derived from the deposit's workflow id
    const ordersWithoutSwap = (
      await this.h.db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM offramp_runs WHERE exchange_order_id IS NOT NULL`,
      )
    )[0]!.n;
    const bf = this.bifastDb
      .prepare('SELECT count(*) AS n, count(DISTINCT idempotency_key) AS k FROM transfers')
      .get() as { n: number; k: number };
    return {
      unbalancedJournals: unbalanced.length,
      completed: counts.completed ?? 0,
      payouts: Number(p?.n ?? 0),
      payoutsSuccess: Number(p?.ok ?? 0),
      exchangeOrders,
      runsWithSell: Number(ordersWithoutSwap),
      bifastTransfers: bf.n,
      bifastDistinctKeys: bf.k,
    };
  }
}

export async function waitFor<T>(
  fn: () => Promise<T | undefined | null | false>,
  timeoutMs = 60_000,
  everyMs = 200,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
