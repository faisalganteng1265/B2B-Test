import { createHash, randomInt } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  Chaos,
  formatDecimal,
  indodaxSign,
  parseDecimal,
  PriceFeed,
  PriceUnavailableError,
  safeEqual,
  type Logger,
} from '@mopay/shared';
import { COIN_SCALE, IndodaxStore } from './store';

/**
 * Mock of INDODAX Trade API 2.0 for ONE account (Mopay's corporate account), following
 * btcid/indodax-official-api-docs INDODAX-TradeAPI-2-Private.md (commit 8d1b409).
 * Real: the order book used to execute MARKET orders (public Indodax depth via PriceFeed).
 * Simulated: balances, fills, deposits crediting, IDR withdrawals.
 */

export interface TransferLog {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  from: string;
  to: string;
  token: string;
  value: bigint;
}
export interface DepositScanner {
  head(): Promise<number>;
  /** Transfer logs of `tokens` to `address` in [from, to]. */
  logs(from: number, to: number, address: string, tokens: string[]): Promise<TransferLog[]>;
}

export interface IndodaxMockDeps {
  store: IndodaxStore;
  priceFeed: PriceFeed;
  chaos: Chaos;
  apiKey: string;
  apiSecret: string;
  adminToken: string;
  /** token address (lowercase) → coin symbol */
  tokens: Record<string, string>;
  tokenDecimals: number;
  network: string;
  scanner: DepositScanner;
  /** first block to scan when no checkpoint exists */
  scanStartBlock: number;
  minConfirm: number;
  creditDelayMs: [number, number];
  /** fee + tax charged on each trade, in bps of quoteQty (measured ≈ 41 bps on real sells) */
  commissionBps: bigint;
  /** an accepted order only becomes visible via GET order / myTrades after up to this delay */
  orderVisibilityDelayMs: number;
  /** IDR withdrawal: KYC-registered bank (same name rule) and fee */
  kycBank: { bankCode: string; accountNumber: string; accountName: string };
  fiatWithdrawFeeIdr: bigint;
  fiatSettleMs: number;
  log: Logger;
  now?: () => number;
}

const SYMBOLS: Record<string, { coin: string; pair: string }> = {
  USDTIDR: { coin: 'USDT', pair: 'usdtidr' },
  USDCIDR: { coin: 'USDC', pair: 'usdcidr' },
};
const MIN_ORDER_IDR = 10_000n; // trade_min_base_currency (public /api/pairs)
const err = (c: Context, status: number, code: number, msg: string) => c.json({ code, msg }, status as 400);
const atoms = (s: string) => parseDecimal(s, 8);
const fmt8 = (a: bigint) => formatDecimal(a, 8, 8) || '0';

export function createIndodaxMock(d: IndodaxMockDeps) {
  const now = d.now ?? Date.now;
  const app = new Hono();
  app.onError((e, c) => {
    d.log.error({ err: e }, 'unhandled');
    return err(c, 500, -1001, 'Internal error; unable to process your request. Please try again.');
  });
  app.get('/healthz', (c) => c.json({ ok: true }));
  d.chaos.mount(app, d.adminToken);

  // Public market data passthrough (real Indodax order book).
  app.get('/api/depth/:pair', async (c) => {
    const r = await d.priceFeed.read();
    const lv = (xs: { priceScaled: bigint; amount: bigint }[]) =>
      xs.map((l) => [formatDecimal(l.priceScaled, 6), formatDecimal(l.amount, 6)]);
    return c.json({ buy: lv(r.snapshot.bids), sell: lv(r.snapshot.asks) });
  });

  app.get('/__state', (c) => {
    if (c.req.header('x-admin-token') !== d.adminToken) return err(c, 401, -1002, 'admin only');
    const q = (s: string) => d.store.db.prepare(s).get() as Record<string, number>;
    return c.json({
      orders: q('SELECT count(*) AS n FROM orders').n,
      deposits: q('SELECT count(*) AS n FROM coin_deposits').n,
      fiatWithdrawals: q('SELECT count(*) AS n FROM fiat_withdrawals').n,
      balances: Object.fromEntries(
        ['IDR', 'USDT', 'USDC'].map((a) => [
          a,
          a === 'IDR' ? d.store.balance(a).toString() : fmt8(d.store.balance(a)),
        ]),
      ),
    });
  });

  // -------------------------------------------------------------- signed private API
  const v2 = new Hono();
  v2.use('*', d.chaos.middleware());
  v2.use('*', async (c, next) => {
    const key = c.req.header('x-apikey');
    if (!key) return err(c, 400, -2014, 'API key not found in header.');
    if (key !== d.apiKey)
      return err(
        c,
        401,
        -1002,
        'Invalid credentials. API not found or session has expired. Please generate new Key',
      );
    const url = new URL(c.req.url);
    const body = c.req.method === 'POST' ? await c.req.text() : '';
    // Sign = HMAC-SHA256(secret, queryString + requestBody)
    const payload = url.search.slice(1) + body;
    const sign = c.req.header('sign');
    if (!sign || !safeEqual(indodaxSign(d.apiSecret, payload), sign.toLowerCase())) {
      return err(c, 400, -1022, 'Invalid nonce/signature.');
    }
    const params = new URLSearchParams(c.req.method === 'POST' ? body : url.search);
    const ts = Number(params.get('timestamp') ?? params.get('nonce'));
    const recvWindow = Number(params.get('recvWindow') ?? 5000);
    const t = now();
    if (!Number.isFinite(ts) || ts <= 0)
      return err(c, 400, -1102, 'A mandatory parameter was not sent: timestamp');
    if (ts >= t + 1000 || t - ts > recvWindow)
      return err(
        c,
        400,
        -1021,
        'Invalid timestamp. Timestamp for this request is outside of the recvWindow.',
      );
    c.set('params' as never, params as never);
    await next();
  });
  const P = (c: Context) => c.get('params' as never) as unknown as URLSearchParams;

  v2.get('/account', (c) =>
    c.json({
      canTrade: true,
      canWithdraw: true,
      canWithdrawFiat: true,
      accountType: 'corporate',
      balances: ['IDR', 'USDT', 'USDC'].map((asset) => ({
        asset,
        free: asset === 'IDR' ? d.store.balance(asset).toString() : fmt8(d.store.balance(asset)),
        locked: '0',
      })),
      uid: 1776329213,
    }),
  );

  v2.get('/capital/config/getall', (c) =>
    c.json(
      ['USDT', 'USDC'].map((coin) => ({
        coin,
        depositAllEnable: true,
        withdrawAllEnable: true,
        name: coin === 'USDT' ? 'Tether' : 'USD Coin',
        free: fmt8(d.store.balance(coin)),
        locked: '0',
        trading: true,
        networkList: [
          {
            network: d.network,
            coin,
            isDefault: true,
            depositEnable: true,
            withdrawEnable: true,
            name: d.network,
            addressRegex: '^(0x)[0-9A-Fa-f]{40}$',
            memoRegex: '',
            withdrawFee: '1',
            withdrawMin: '5',
            withdrawInternalMin: '0.00000001',
            minConfirm: d.minConfirm,
            sameAddress: false,
            withdrawTag: false,
            contractAddress: Object.entries(d.tokens).find(([, s]) => s === coin)?.[0] ?? '',
          },
        ],
      })),
    ),
  );

  v2.get('/capital/deposit/address/list', (c) => {
    const coin = P(c).get('coin')?.toUpperCase();
    const network = P(c).get('network')?.toLowerCase();
    if (!coin)
      return err(
        c,
        400,
        -1130,
        "Invalid parameter value.\n\nInvalid parameter 'coin', coin parameter is required",
      );
    if (!['USDT', 'USDC'].includes(coin)) return err(c, 400, -1121, 'invalid currency');
    if (network !== d.network)
      return err(c, 400, -1130, `Invalid network, please fill with one of this (${d.network})`);
    return c.json([{ coin, address: depositAddress(coin), tag: '', network: d.network }]);
  });

  v2.get('/capital/deposit/hisrec', (c) => {
    const coin = (P(c).get('coin') ?? 'BTC').toUpperCase(); // docs: defaults to BTC when omitted
    const start = Number(P(c).get('startTime') ?? now() - 90 * 86_400_000);
    const end = Number(P(c).get('endTime') ?? now());
    if (end - start > 90 * 86_400_000)
      return err(
        c,
        400,
        -1130,
        "Invalid parameter value.\n\nInvalid parameter 'timeRange', time range cannot exceed 90 days",
      );
    const status = P(c).get('depositStatus');
    const limit = Math.min(1000, Math.max(10, Number(P(c).get('limit') ?? 1000)));
    const rows = d.store.db
      .prepare(
        `SELECT * FROM coin_deposits WHERE coin = ? AND insert_time BETWEEN ? AND ? ${status ? 'AND status = ?' : ''} ORDER BY insert_time DESC LIMIT ?`,
      )
      .all(
        ...([coin, start, end, ...(status ? [status] : []), limit] as (string | number)[]),
      ) as unknown as DepositRow[];
    return c.json(
      rows.map((r) => ({
        id: String(r.id),
        amount: formatDecimal(BigInt(r.amount_base), r.decimals),
        coin: r.coin,
        txId: r.tx_id,
        address: r.address,
        addressTag: '',
        network: r.network,
        status: r.status,
        insertTime: r.insert_time,
        completeTime: r.complete_time,
      })),
    );
  });

  v2.post('/order', async (c) => {
    const p = P(c);
    const symbol = (p.get('symbol') ?? '').toUpperCase();
    const side = p.get('side');
    const type = p.get('type');
    const clientOrderId = p.get('newClientOrderId') ?? `auto${randomInt(1e9)}`;
    const sym = SYMBOLS[symbol];
    if (!sym) return err(c, 400, -1121, 'Invalid symbol.');
    if (side !== 'BUY' && side !== 'SELL')
      return err(c, 400, -1130, "Invalid parameter value.\n\nInvalid parameter 'side', must be BUY or SELL");
    if (type !== 'MARKET' && type !== 'LIMIT')
      return err(
        c,
        400,
        -1130,
        "Invalid parameter value.\n\nInvalid parameter 'type', must be LIMIT or MARKET",
      );
    if (type === 'LIMIT')
      return err(c, 400, -1130, 'Invalid parameter value.\n\nLIMIT orders are not simulated by this mock');
    if (!/^[A-Za-z0-9_-]{1,36}$/.test(clientOrderId))
      return err(c, 400, -1130, "Invalid parameter value.\n\nInvalid parameter 'newClientOrderId'");
    const qtyStr = p.get('quantity');
    const quoteStr = p.get('quoteOrderQty');
    if (side === 'SELL' && !qtyStr) return err(c, 400, -1102, 'A mandatory parameter was not sent: quantity');
    if (side === 'BUY' && !quoteStr)
      return err(c, 400, -1102, 'A mandatory parameter was not sent: quoteOrderQty');
    if (qtyStr && !/^\d+(\.\d{1,8})?$/.test(qtyStr))
      return err(c, 400, -1130, '[quantity] amount has more precision than allowed (8)');

    let book;
    try {
      book = (await d.priceFeed.readForExecution()).snapshot;
    } catch (e) {
      if (e instanceof PriceUnavailableError)
        return err(c, 500, -1001, 'Internal error; unable to process your request. Please try again.');
      throw e;
    }

    // Check-execute-record in one SQLite transaction: atomic, serialized, crash-safe.
    const out = d.store.tx(() => {
      if (d.store.db.prepare('SELECT 1 FROM orders WHERE client_order_id = ?').get(clientOrderId)) {
        return { error: [400, -2010, 'Order was rejected. Duplicate client order ID.'] as const };
      }
      const fills: { price: bigint; qty: bigint; quote: bigint }[] = [];
      if (side === 'SELL') {
        let remaining = atoms(qtyStr!);
        if (remaining <= 0n) return { error: [400, -1111, 'Quantity validation failed.'] as const };
        if (d.store.balance(sym.coin) < remaining)
          return { error: [400, -2010, 'Order was rejected. Insufficient balance.'] as const };
        for (const lvl of book.bids) {
          if (remaining === 0n) break;
          const avail = lvl.amount * 100n; // 6dp base units → 8dp atoms
          const q = avail < remaining ? avail : remaining;
          fills.push({
            price: lvl.priceScaled,
            qty: q,
            quote: (q * lvl.priceScaled) / (COIN_SCALE * 1_000_000n),
          });
          remaining -= q;
        }
        if (remaining > 0n)
          return { error: [400, -2010, 'Order was rejected. Insufficient liquidity.'] as const };
      } else {
        let remainingIdr = BigInt(quoteStr!);
        if (d.store.balance('IDR') < remainingIdr)
          return { error: [400, -2010, 'Order was rejected. Insufficient balance.'] as const };
        for (const lvl of book.asks) {
          if (remainingIdr <= 0n) break;
          const levelIdr = (lvl.amount * 100n * lvl.priceScaled) / (COIN_SCALE * 1_000_000n);
          const spend = levelIdr < remainingIdr ? levelIdr : remainingIdr;
          fills.push({
            price: lvl.priceScaled,
            qty: (spend * COIN_SCALE * 1_000_000n) / lvl.priceScaled,
            quote: spend,
          });
          remainingIdr -= spend;
        }
      }
      const totalQuote = fills.reduce((a, f) => a + f.quote, 0n);
      if (totalQuote < MIN_ORDER_IDR)
        return {
          error: [
            400,
            -1130,
            'Parameter value does not meet the required trading rules: minimum order Rp10000',
          ] as const,
        };
      const totalQty = fills.reduce((a, f) => a + f.qty, 0n);
      const t = now();
      const visibleAt = t + (d.orderVisibilityDelayMs ? randomInt(d.orderVisibilityDelayMs + 1) : 0);
      const res = d.store.db
        .prepare(
          `INSERT INTO orders (client_order_id, symbol, side, type, orig_qty, executed_qty, status, time, visible_at)
           VALUES (?, ?, ?, 'MARKET', ?, ?, 'FILLED', ?, ?)`,
        )
        .run(clientOrderId, symbol, side, totalQty.toString(), totalQty.toString(), t, visibleAt);
      const orderId = Number(res.lastInsertRowid);
      let commissionTotal = 0n;
      for (const f of fills) {
        const commission = (f.quote * d.commissionBps + 9_999n) / 10_000n; // rounded up
        commissionTotal += commission;
        d.store.db
          .prepare(
            `INSERT INTO trades (order_id, client_order_id, symbol, price, qty, quote_qty, commission, is_buyer, time)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            orderId,
            clientOrderId,
            sym.pair,
            f.price.toString(),
            f.qty.toString(),
            f.quote.toString(),
            commission.toString(),
            side === 'BUY' ? 1 : 0,
            t,
          );
      }
      if (side === 'SELL') {
        d.store.addBalance(sym.coin, -totalQty);
        d.store.addBalance('IDR', totalQuote - commissionTotal);
      } else {
        d.store.addBalance('IDR', -totalQuote);
        d.store.addBalance(sym.coin, totalQty); // BUY commission is charged in IDR on top
        d.store.addBalance('IDR', -commissionTotal);
      }
      return { orderId, totalQty };
    });
    if ('error' in out) {
      const [status, code, msg] = out.error!;
      return err(c, status, code, msg);
    }
    d.log.info({ clientOrderId, symbol, side, qty: fmt8(out.totalQty) }, 'order filled');
    return c.json({
      symbol,
      orderId: out.orderId,
      clientOrderId,
      side,
      type,
      origQty: fmt8(out.totalQty),
      executedQty: fmt8(out.totalQty),
      fullOrderId: `${sym.pair}-market-${out.orderId}`,
    });
  });

  v2.get('/order', (c) => {
    const p = P(c);
    const sym = SYMBOLS[(p.get('symbol') ?? '').toUpperCase()];
    if (!sym) return err(c, 400, -1121, 'Invalid symbol.');
    const orderId = p.get('orderId');
    const coid = p.get('origClientOrderId');
    if (!orderId && !coid)
      return err(c, 400, -1102, 'A mandatory parameter was not sent: orderId or origClientOrderId');
    const o = (
      orderId
        ? d.store.db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(orderId))
        : d.store.db.prepare('SELECT * FROM orders WHERE client_order_id = ?').get(coid!)
    ) as OrderRow | undefined;
    if (!o || o.visible_at > now() || SYMBOLS[o.symbol]?.pair !== sym.pair)
      return err(c, 404, -2013, 'Order not found or not yet available.');
    return c.json({
      symbol: o.symbol,
      orderId: o.id,
      clientOrderId: o.client_order_id,
      side: o.side,
      origQty: fmt8(BigInt(o.orig_qty)),
      executedQty: fmt8(BigInt(o.executed_qty)),
      status: o.status,
      type: o.type,
      time: o.time,
      fullOrderId: `${sym.pair}-market-${o.id}`,
    });
  });

  v2.get('/myTrades', (c) => {
    const p = P(c);
    const pair = (p.get('symbol') ?? '').toLowerCase();
    if (!Object.values(SYMBOLS).some((s) => s.pair === pair)) return err(c, 400, -1121, 'Invalid symbol.');
    const coid = p.get('clientOrderId');
    const full = p.get('orderId');
    const rows = d.store.db
      .prepare(
        `SELECT t.*, o.visible_at FROM trades t JOIN orders o ON o.id = t.order_id
         WHERE t.symbol = ? ${coid ? 'AND t.client_order_id = ?' : ''} ${full ? 'AND t.order_id = ?' : ''} ORDER BY t.trade_id DESC LIMIT 1000`,
      )
      .all(
        ...([pair, ...(coid ? [coid] : []), ...(full ? [Number(full.split('-').pop())] : [])] as (
          string | number
        )[]),
      ) as unknown as (TradeRow & { visible_at: number })[];
    return c.json({
      data: rows
        .filter((r) => r.visible_at <= now())
        .map((r) => ({
          tradeId: String(72057594037927936 + r.trade_id),
          orderId: `${r.symbol}-market-${r.order_id}`,
          clientOrderId: r.client_order_id,
          symbol: r.symbol,
          price: formatDecimal(BigInt(r.price), 6),
          qty: fmt8(BigInt(r.qty)),
          quoteQty: r.quote_qty,
          commission: r.commission,
          commissionAsset: 'idr',
          isBuyer: r.is_buyer === 1,
          isMaker: false,
          time: r.time,
        })),
    });
  });

  v2.post('/fiat/withdraw', (c) => {
    const p = P(c);
    if (p.get('apiPaymentMethod') !== 'bank_transfer')
      return err(
        c,
        400,
        -1130,
        "Invalid parameter value.\n\nInvalid parameter 'apiPaymentMethod', only support bank_transfer",
      );
    if (p.get('currency') !== 'IDR')
      return err(c, 400, -1130, "Invalid parameter value.\n\nInvalid parameter 'currency', only support IDR");
    const amountStr = p.get('amount') ?? '';
    if (!/^\d+$/.test(amountStr))
      return err(c, 400, -1102, 'A mandatory parameter was not sent, was empty/null, or malformed: amount');
    const amount = BigInt(amountStr);
    if (amount <= 100_000n) return err(c, 400, -1130, 'Withdrawal amount must be greater than 100000');
    if (amount >= 1_000_000_000n) return err(c, 400, -1130, 'Withdrawal amount must be less than 1000000000');
    let info: { accountNumber?: string; bankCodeForPix?: string };
    try {
      info = JSON.parse(p.get('accountInfo') ?? '{}');
    } catch {
      return err(
        c,
        400,
        -1102,
        'A mandatory parameter was not sent, was empty/null, or malformed: accountInfo',
      );
    }
    if (!info.accountNumber || !/^\d{3}$/.test(info.bankCodeForPix ?? ''))
      return err(
        c,
        400,
        -1102,
        'A mandatory parameter was not sent, was empty/null, or malformed: accountInfo',
      );
    // Docs: IDR withdrawals only to a bank account in the same name as the KYC holder.
    if (info.accountNumber !== d.kycBank.accountNumber || info.bankCodeForPix !== d.kycBank.bankCode) {
      return err(c, 400, -4019, 'Withdrawal bank not allowed.');
    }
    const crid = p.get('clientRequestId') ?? undefined;
    if (crid && crid.length > 36)
      return err(
        c,
        400,
        -1130,
        "Invalid parameter value.\n\nInvalid parameter 'clientRequestId', max 36 characters",
      );
    const hash = createHash('sha256')
      .update(`${amount}|${info.accountNumber}|${info.bankCodeForPix}`)
      .digest('hex');
    const out = d.store.tx(() => {
      if (crid) {
        const prev = d.store.db
          .prepare('SELECT order_no, request_hash FROM fiat_withdrawals WHERE client_request_id = ?')
          .get(crid) as { order_no: string; request_hash: string } | undefined;
        if (prev)
          return prev.request_hash === hash
            ? { orderNo: prev.order_no }
            : { error: [400, -1000, 'duplicate request'] as const };
      }
      if (d.store.balance('IDR') < amount) return { error: [400, -4026, 'Insufficient balance.'] as const };
      const orderNo = `${now()}${randomInt(1000, 9999)}`;
      d.store.addBalance('IDR', -amount);
      d.store.db
        .prepare(
          `INSERT INTO fiat_withdrawals (order_no, client_request_id, request_hash, amount, fee, bank_code, account_number, status, create_time, update_time, settle_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        )
        .run(
          orderNo,
          crid ?? null,
          hash,
          amount.toString(),
          d.fiatWithdrawFeeIdr.toString(),
          info.bankCodeForPix!,
          info.accountNumber!,
          now(),
          now(),
          now() + d.fiatSettleMs,
        );
      return { orderNo };
    });
    if ('error' in out) {
      const [status, code, msg] = out.error!;
      return err(c, status, code, msg);
    }
    return c.json({ data: { orderId: out.orderNo } });
  });

  v2.get('/fiat/orders', (c) => {
    settleFiat();
    const type = P(c).get('transactionType') ?? '1';
    if (type !== '1') return c.json({ data: [] });
    const rows = d.store.db
      .prepare('SELECT * FROM fiat_withdrawals ORDER BY create_time DESC LIMIT 1000')
      .all() as unknown as FiatRow[];
    return c.json({
      data: rows.map((r) => ({
        orderNo: r.order_no,
        amount: r.amount,
        totalFee: r.fee,
        method: 'bank',
        fiatCurrency: 'IDR',
        status: r.status,
        createTime: r.create_time,
        updateTime: r.update_time,
        bankName: r.bank_code,
        bankTag: d.kycBank.accountName,
        bankAccountNumber: r.account_number,
        clientRequestId: r.client_request_id,
      })),
    });
  });

  app.route('/api/v2', v2);

  // -------------------------------------------------------------- internals
  function depositAddress(coin: string): string {
    const row = d.store.db
      .prepare('SELECT address FROM deposit_addresses WHERE coin = ? AND network = ?')
      .get(coin, d.network) as { address: string } | undefined;
    if (row) return row.address;
    // One address per account for EVM tokens (sameAddress semantics): reuse an existing one if any.
    const any = d.store.db
      .prepare('SELECT address, private_key FROM deposit_addresses WHERE network = ? LIMIT 1')
      .get(d.network) as { address: string; private_key: string } | undefined;
    const pk = any?.private_key ?? generatePrivateKey();
    const address = any?.address ?? privateKeyToAccount(pk as `0x${string}`).address.toLowerCase();
    d.store.db
      .prepare('INSERT INTO deposit_addresses (coin, network, address, private_key) VALUES (?, ?, ?, ?)')
      .run(coin, d.network, address, pk);
    return address;
  }

  function settleFiat() {
    d.store.db
      .prepare(
        `UPDATE fiat_withdrawals SET status = 'success', update_time = ? WHERE status = 'pending' AND settle_at <= ?`,
      )
      .run(now(), now());
  }

  let scanning = false;
  /** One pass of the deposit scanner (the real exchange watches the chain itself). */
  async function scanOnce() {
    if (scanning) return;
    scanning = true;
    try {
      settleFiat();
      const address = depositAddress('USDT');
      const head = await d.scanner.head();
      const last = Number(d.store.meta('scan_last_block') ?? d.scanStartBlock - 1);
      if (head > last) {
        const to = Math.min(head, last + 1000);
        const logs = await d.scanner.logs(last + 1, to, address, Object.keys(d.tokens));
        d.store.tx(() => {
          for (const l of logs) {
            const coin = d.tokens[l.token.toLowerCase()];
            if (!coin) continue;
            const [lo, hi] = d.creditDelayMs;
            d.store.db
              .prepare(
                `INSERT OR IGNORE INTO coin_deposits (coin, network, tx_id, log_index, from_address, address, amount_base, decimals, block_number, status, insert_time, credit_after)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
              )
              .run(
                coin!,
                d.network,
                l.txHash.toLowerCase(),
                l.logIndex,
                l.from.toLowerCase(),
                address,
                l.value.toString(),
                d.tokenDecimals,
                l.blockNumber,
                now(),
                now() + lo + (hi > lo ? randomInt(hi - lo) : 0),
              );
          }
          d.store.setMeta('scan_last_block', String(to));
        });
      }
      // credit after minConfirm confirmations and the exchange's own processing delay
      d.store.tx(() => {
        const pending = d.store.db
          .prepare(`SELECT * FROM coin_deposits WHERE status = 'pending'`)
          .all() as unknown as DepositRow[];
        for (const r of pending) {
          if (head - r.block_number + 1 < d.minConfirm || now() < r.credit_after) continue;
          d.store.db
            .prepare(`UPDATE coin_deposits SET status = 'success', complete_time = ? WHERE id = ?`)
            .run(now(), r.id);
          d.store.addBalance(r.coin, BigInt(r.amount_base) * 10n ** BigInt(8 - r.decimals));
          d.log.info(
            { txId: r.tx_id, coin: r.coin, amount: formatDecimal(BigInt(r.amount_base), r.decimals) },
            'deposit credited',
          );
        }
      });
    } finally {
      scanning = false;
    }
  }

  return { app, scanOnce, depositAddress };
}

interface DepositRow {
  id: number;
  coin: string;
  network: string;
  tx_id: string;
  log_index: number;
  from_address: string;
  address: string;
  amount_base: string;
  decimals: number;
  block_number: number;
  status: string;
  insert_time: number;
  complete_time: number | null;
  credit_after: number;
}
interface OrderRow {
  id: number;
  client_order_id: string;
  symbol: string;
  side: string;
  type: string;
  orig_qty: string;
  executed_qty: string;
  status: string;
  time: number;
  visible_at: number;
}
interface TradeRow {
  trade_id: number;
  order_id: number;
  client_order_id: string;
  symbol: string;
  price: string;
  qty: string;
  quote_qty: string;
  commission: string;
  is_buyer: number;
  time: number;
}
interface FiatRow {
  order_no: string;
  client_request_id: string | null;
  amount: string;
  fee: string;
  bank_code: string;
  account_number: string;
  status: string;
  create_time: number;
  update_time: number;
}
