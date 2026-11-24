import { createHash, randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { decodeEventLog, erc20Abi, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  Chaos,
  formatRate,
  PriceFeed,
  PriceUnavailableError,
  tokenToIdr,
  verifyMobee,
  type Logger,
} from '@mopay/shared';
import { MobeeStore } from './store';

export interface ReceiptLike {
  status: 'success' | 'reverted';
  blockNumber: bigint;
  logs: { address: string; topics: readonly Hex[]; data: Hex; logIndex: number }[];
}
export interface ChainReader {
  getReceipt(txHash: Hex): Promise<ReceiptLike | null>;
  getBlockNumber(): Promise<bigint>;
}

export interface MobeeDeps {
  store: MobeeStore;
  priceFeed: PriceFeed;
  chain: ChainReader;
  chaos: Chaos;
  apiKey: string;
  apiSecret: string;
  adminToken: string;
  /** token address (lowercase) -> asset symbol */
  tokens: Record<string, string>;
  chainId: number;
  minConfirmations: number;
  creditDelayMs: [number, number];
  quoteTtlMs: number;
  log: Logger;
  now?: () => number;
  rand?: () => number;
}

type Code =
  | 'UNAUTHORIZED'
  | 'INVALID_SIGNATURE'
  | 'TIMESTAMP_OUT_OF_TOLERANCE'
  | 'MISSING_HEADERS'
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'PRICE_UNAVAILABLE'
  | 'INSUFFICIENT_LIQUIDITY'
  | 'QUOTE_EXPIRED'
  | 'QUOTE_ALREADY_USED'
  | 'INSUFFICIENT_BALANCE'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'INTERNAL';

const fail = (c: Context, status: number, code: Code, message: string) =>
  c.json({ error: { code, message } }, status as 400);

const amountStr = z.string().regex(/^[1-9]\d*$/, 'positive integer base units');
const lockBody = z.object({
  subAccountId: z.string().min(1),
  symbol: z.literal('USDT-IDR'),
  amount: amountStr,
});
const confirmBody = z.object({ quoteId: z.string().min(1) });
const walletBody = z.object({
  subAccountId: z.string().min(1),
  chainId: z.number().int(),
  asset: z.string().default('USDT'),
});

export function createMobeeApp(d: MobeeDeps) {
  const now = d.now ?? Date.now;
  const rand = d.rand ?? Math.random;
  const app = new Hono();

  app.onError((err, c) => {
    d.log.error({ err }, 'unhandled');
    return fail(c, 500, 'INTERNAL', err.message);
  });
  app.get('/healthz', (c) => c.json({ ok: true }));
  d.chaos.mount(app, d.adminToken);

  // Admin introspection (used by invariant checks; not part of the Mobee API surface).
  app.get('/__state', (c) => {
    if (c.req.header('x-admin-token') !== d.adminToken) return fail(c, 401, 'UNAUTHORIZED', 'admin only');
    const orders = d.store.db
      .prepare('SELECT quote_id, count(*) AS n FROM orders GROUP BY quote_id HAVING n > 1')
      .all();
    return c.json({ orders: d.store.orderCount(), duplicateOrdersPerQuote: orders.length });
  });

  const v1 = new Hono();
  v1.use('*', d.chaos.middleware());

  // Public market data (real Indodax price).
  v1.get('/market/price', async (c) => {
    const amount = c.req.query('amount');
    try {
      const r = await d.priceFeed.read();
      const s = r.snapshot;
      let vwap;
      if (amount && /^[1-9]\d*$/.test(amount)) {
        const q = PriceFeed.quoteSell(s, BigInt(amount));
        vwap = {
          amount,
          rate: formatRate(q.vwapScaled),
          rateScaled: q.vwapScaled.toString(),
          levelsUsed: q.levelsUsed,
          slippageBps: q.slippageBps.toString(),
          idrAmount: tokenToIdr(BigInt(amount), q.vwapScaled).toString(),
        };
      }
      return c.json({
        symbol: 'USDT-IDR',
        source: s.source,
        bid: formatRate(s.bid),
        ask: formatRate(s.ask),
        last: formatRate(s.last),
        stale: r.stale,
        asOf: s.asOf.toISOString(),
        ageMs: r.ageMs,
        vwap,
      });
    } catch (e) {
      if (e instanceof PriceUnavailableError) return fail(c, 503, 'PRICE_UNAVAILABLE', e.message);
      if (e instanceof Error && e.message === 'INSUFFICIENT_LIQUIDITY')
        return fail(c, 422, 'INSUFFICIENT_LIQUIDITY', 'order book too thin');
      throw e;
    }
  });

  // Everything else requires Mobee-style HMAC auth.
  v1.use('*', async (c, next) => {
    if (c.req.header('x-api-key') !== d.apiKey) return fail(c, 401, 'UNAUTHORIZED', 'unknown api key');
    const url = new URL(c.req.url);
    const body = ['POST', 'PUT'].includes(c.req.method) ? await c.req.text() : undefined;
    const r = verifyMobee({
      secret: d.apiSecret,
      method: c.req.method,
      path: url.pathname + url.search,
      timestamp: c.req.header('x-request-timestamp'),
      signature: c.req.header('x-request-signature'),
      body,
      nowS: Math.floor(now() / 1000),
    });
    if (!r.ok) return fail(c, 401, r.code, 'request authentication failed');
    await next();
  });

  v1.post('/wallet-addresses', async (c) => {
    const b = walletBody.safeParse(await c.req.json());
    if (!b.success) return fail(c, 400, 'VALIDATION', b.error.message);
    if (b.data.chainId !== d.chainId)
      return fail(c, 400, 'VALIDATION', `unsupported chain ${b.data.chainId}`);
    // One address per (sub-account, chain), like a real exchange: idempotent.
    const row = d.store.tx(() => {
      const existing = d.store.db
        .prepare('SELECT address, created_at FROM addresses WHERE subaccount = ? AND chain_id = ?')
        .get(b.data.subAccountId, b.data.chainId) as { address: string; created_at: string } | undefined;
      if (existing) return existing;
      const pk = generatePrivateKey();
      const address = privateKeyToAccount(pk).address.toLowerCase();
      const created_at = new Date(now()).toISOString();
      d.store.db
        .prepare(
          'INSERT INTO addresses (address, subaccount, chain_id, private_key, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(address, b.data.subAccountId, b.data.chainId, pk, created_at);
      return { address, created_at };
    });
    return c.json({
      subAccountId: b.data.subAccountId,
      chainId: b.data.chainId,
      address: row.address,
      createdAt: row.created_at,
    });
  });

  v1.get('/deposits/crypto', async (c) => {
    const txHash = c.req.query('txHash')?.toLowerCase();
    if (!txHash || !/^0x[0-9a-f]{64}$/.test(txHash)) return fail(c, 400, 'VALIDATION', 'txHash required');
    let rows = depositRows(txHash);
    if (rows.length === 0) {
      const receipt = await d.chain.getReceipt(txHash as Hex);
      if (!receipt) return c.json({ txHash, status: 'not_found', deposits: [] });
      if (receipt.status !== 'success') return c.json({ txHash, status: 'failed', deposits: [] });
      d.store.tx(() => {
        for (const log of receipt.logs) {
          const asset = d.tokens[log.address.toLowerCase()];
          if (!asset) continue;
          let ev;
          try {
            ev = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
          } catch {
            continue;
          }
          if (ev.eventName !== 'Transfer') continue;
          const to = ev.args.to.toLowerCase();
          const owner = d.store.db
            .prepare('SELECT subaccount FROM addresses WHERE address = ? AND chain_id = ?')
            .get(to, d.chainId) as { subaccount: string } | undefined;
          if (!owner) continue;
          const [lo, hi] = d.creditDelayMs;
          const creditAfter = now() + lo + Math.floor(rand() * Math.max(0, hi - lo));
          d.store.db
            .prepare(
              `INSERT OR IGNORE INTO deposits (tx_hash, log_index, chain_id, block_number, subaccount, asset, amount, credit_after_ms, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
            )
            .run(
              txHash,
              log.logIndex,
              d.chainId,
              Number(receipt.blockNumber),
              owner.subaccount,
              asset,
              ev.args.value.toString(),
              creditAfter,
            );
        }
      });
      rows = depositRows(txHash);
    }
    // Credit pending deposits once they have enough confirmations AND the exchange's own delay passed.
    if (rows.some((r) => r.status === 'pending')) {
      const head = Number(await d.chain.getBlockNumber());
      d.store.tx(() => {
        for (const r of depositRows(txHash)) {
          if (r.status !== 'pending') continue;
          if (head - r.block_number + 1 < d.minConfirmations || now() < r.credit_after_ms) continue;
          const res = d.store.db
            .prepare(
              `UPDATE deposits SET status = 'credited', credited_at = ? WHERE tx_hash = ? AND log_index = ? AND status = 'pending'`,
            )
            .run(new Date(now()).toISOString(), r.tx_hash, r.log_index);
          if (res.changes === 1) d.store.addBalance(r.subaccount, r.asset, BigInt(r.amount));
        }
      });
      rows = depositRows(txHash);
    }
    const head = Number(await d.chain.getBlockNumber().catch(() => 0n));
    return c.json({
      txHash,
      status: 'found',
      deposits: rows.map((r) => ({
        txHash: r.tx_hash,
        logIndex: r.log_index,
        asset: r.asset,
        amount: r.amount,
        subAccountId: r.subaccount,
        status: r.status,
        confirmations: head ? Math.max(0, head - r.block_number + 1) : 0,
        creditedAt: r.credited_at,
      })),
    });
  });

  v1.get('/balances', (c) => {
    const sub = c.req.query('subAccountId');
    if (!sub) return fail(c, 400, 'VALIDATION', 'subAccountId required');
    return c.json({ subAccountId: sub, balances: d.store.balances(sub) });
  });

  async function priceFor(amount: bigint) {
    const r = await d.priceFeed.readForExecution();
    const q = PriceFeed.quoteSell(r.snapshot, amount);
    return { r, q, idr: tokenToIdr(amount, q.vwapScaled) };
  }

  const priceErrors = (c: Context, e: unknown) => {
    if (e instanceof PriceUnavailableError) return fail(c, 503, 'PRICE_UNAVAILABLE', e.message);
    if (e instanceof Error && e.message === 'INSUFFICIENT_LIQUIDITY')
      return fail(c, 422, 'INSUFFICIENT_LIQUIDITY', 'order book too thin');
    throw e;
  };

  v1.post('/quick-swap/calculate', async (c) => {
    const b = lockBody.safeParse(await c.req.json());
    if (!b.success) return fail(c, 400, 'VALIDATION', b.error.message);
    try {
      const { r, q, idr } = await priceFor(BigInt(b.data.amount));
      return c.json({
        subAccountId: b.data.subAccountId,
        symbol: b.data.symbol,
        amount: b.data.amount,
        rate: formatRate(q.vwapScaled),
        rateScaled: q.vwapScaled.toString(),
        idrAmount: idr.toString(),
        priceSource: r.snapshot.source,
        priceAsOf: r.snapshot.asOf.toISOString(),
        stale: r.stale,
        levelsUsed: q.levelsUsed,
        slippageBps: q.slippageBps.toString(),
      });
    } catch (e) {
      return priceErrors(c, e);
    }
  });

  v1.post('/quick-swap/lock', async (c) => {
    const b = lockBody.safeParse(await c.req.json());
    if (!b.success) return fail(c, 400, 'VALIDATION', b.error.message);
    try {
      const amount = BigInt(b.data.amount);
      const { r, q, idr } = await priceFor(amount);
      const id = `q_${randomUUID()}`;
      const expiresAt = now() + d.quoteTtlMs;
      d.store.db
        .prepare(
          `INSERT INTO quotes (id, subaccount, symbol, amount, rate_scaled, idr_amount, price_as_of, expires_at_ms, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          b.data.subAccountId,
          b.data.symbol,
          amount.toString(),
          q.vwapScaled.toString(),
          idr.toString(),
          r.snapshot.asOf.toISOString(),
          expiresAt,
          new Date(now()).toISOString(),
        );
      return c.json({
        quoteId: id,
        subAccountId: b.data.subAccountId,
        symbol: b.data.symbol,
        amount: amount.toString(),
        rate: formatRate(q.vwapScaled),
        rateScaled: q.vwapScaled.toString(),
        idrAmount: idr.toString(),
        priceSource: r.snapshot.source,
        priceAsOf: r.snapshot.asOf.toISOString(),
        stale: r.stale,
        levelsUsed: q.levelsUsed,
        slippageBps: q.slippageBps.toString(),
        expiresAt: new Date(expiresAt).toISOString(),
      });
    } catch (e) {
      return priceErrors(c, e);
    }
  });

  v1.post('/quick-swap/confirm', async (c) => {
    const key = c.req.header('idempotency-key');
    if (!key) return fail(c, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header required');
    const raw = await c.req.text();
    const b = confirmBody.safeParse(JSON.parse(raw || '{}'));
    if (!b.success) return fail(c, 400, 'VALIDATION', b.error.message);
    const reqHash = createHash('sha256').update(raw).digest('hex');

    // The whole check-execute-record sequence is one SQLite transaction: atomic and serialized.
    const result = d.store.tx(() => {
      const prev = d.store.db
        .prepare('SELECT request_hash, status_code, body FROM idempotency WHERE key = ?')
        .get(key) as { request_hash: string; status_code: number; body: string } | undefined;
      if (prev) {
        if (prev.request_hash !== reqHash)
          return {
            status: 422,
            body: { error: { code: 'IDEMPOTENCY_KEY_REUSED', message: 'key used with a different request' } },
          };
        return { status: prev.status_code, body: JSON.parse(prev.body), replay: true };
      }
      const record = (status: number, body: unknown) => {
        d.store.db
          .prepare(
            'INSERT INTO idempotency (key, request_hash, status_code, body, created_at) VALUES (?, ?, ?, ?, ?)',
          )
          .run(key, reqHash, status, JSON.stringify(body), new Date(now()).toISOString());
        return { status, body };
      };
      const q = d.store.db.prepare('SELECT * FROM quotes WHERE id = ?').get(b.data.quoteId) as
        | {
            id: string;
            subaccount: string;
            symbol: string;
            amount: string;
            rate_scaled: string;
            idr_amount: string;
            expires_at_ms: number;
            order_id: string | null;
          }
        | undefined;
      if (!q) return record(404, { error: { code: 'NOT_FOUND', message: 'quote not found' } });
      if (q.order_id)
        return record(409, {
          error: { code: 'QUOTE_ALREADY_USED', message: `quote already executed as ${q.order_id}` },
        });
      if (now() > q.expires_at_ms)
        return record(409, { error: { code: 'QUOTE_EXPIRED', message: 'quote expired' } });
      const amount = BigInt(q.amount);
      if (d.store.balance(q.subaccount, 'USDT') < amount) {
        // Not recorded: the balance may arrive later, so a retry with the same key may succeed.
        return {
          status: 422,
          body: { error: { code: 'INSUFFICIENT_BALANCE', message: 'USDT balance too low' } },
        };
      }
      const orderId = `o_${randomUUID()}`;
      const createdAt = new Date(now()).toISOString();
      d.store.addBalance(q.subaccount, 'USDT', -amount);
      d.store.addBalance(q.subaccount, 'IDR', BigInt(q.idr_amount));
      d.store.db
        .prepare(
          `INSERT INTO orders (id, quote_id, subaccount, symbol, amount, rate_scaled, idr_amount, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'filled', ?)`,
        )
        .run(orderId, q.id, q.subaccount, q.symbol, q.amount, q.rate_scaled, q.idr_amount, createdAt);
      d.store.db.prepare('UPDATE quotes SET order_id = ? WHERE id = ?').run(orderId, q.id);
      return record(
        200,
        orderJson({
          id: orderId,
          quote_id: q.id,
          subaccount: q.subaccount,
          symbol: q.symbol,
          amount: q.amount,
          rate_scaled: q.rate_scaled,
          idr_amount: q.idr_amount,
          status: 'filled',
          created_at: createdAt,
        }),
      );
    });
    if ('replay' in result) c.header('idempotent-replay', 'true');
    return c.json(result.body, result.status as 200);
  });

  v1.get('/orders/:id', (c) => {
    const o = d.store.db.prepare('SELECT * FROM orders WHERE id = ?').get(c.req.param('id')) as
      OrderRow | undefined;
    if (!o) return fail(c, 404, 'NOT_FOUND', 'order not found');
    return c.json(orderJson(o));
  });

  app.route('/v1', v1);
  return app;

  function depositRows(txHash: string) {
    return d.store.db
      .prepare('SELECT * FROM deposits WHERE tx_hash = ? ORDER BY log_index')
      .all(txHash) as unknown as DepositRow[];
  }
}

interface DepositRow {
  tx_hash: string;
  log_index: number;
  block_number: number;
  subaccount: string;
  asset: string;
  amount: string;
  credit_after_ms: number;
  status: 'pending' | 'credited';
  credited_at: string | null;
}
interface OrderRow {
  id: string;
  quote_id: string;
  subaccount: string;
  symbol: string;
  amount: string;
  rate_scaled: string;
  idr_amount: string;
  status: string;
  created_at: string;
}
const orderJson = (o: OrderRow) => ({
  orderId: o.id,
  quoteId: o.quote_id,
  subAccountId: o.subaccount,
  symbol: o.symbol,
  amount: o.amount,
  rateScaled: o.rate_scaled,
  idrAmount: o.idr_amount,
  status: o.status,
  createdAt: o.created_at,
});
