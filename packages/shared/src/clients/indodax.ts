import { createHash, createHmac } from 'node:crypto';
import { UpstreamError, type ErrorClass } from '../errors';

/**
 * Client for INDODAX Trade API 2.0 (TAPIv2), per btcid/indodax-official-api-docs
 * INDODAX-TradeAPI-2-Private.md (commit 8d1b409, 2026-11-10):
 *  - headers `X-APIKEY` + `Sign` = hex HMAC-SHA256(secret, queryString + requestBody)
 *  - every request carries `timestamp` (ms) and optional `recvWindow` (default 5000)
 *  - POST bodies are application/x-www-form-urlencoded
 *  - errors are `{ code: number, msg: string }` with an HTTP status
 */

export interface IndodaxBalance {
  asset: string;
  free: string;
  locked: string;
}
export interface IndodaxAccount {
  canTrade: boolean;
  canWithdraw: boolean;
  canWithdrawFiat: boolean;
  accountType: string;
  balances: IndodaxBalance[];
  uid: number;
}
export interface IndodaxDepositAddress {
  coin: string;
  address: string;
  tag: string;
  network: string;
}
export interface IndodaxCoinDeposit {
  id: string;
  amount: string;
  coin: string;
  txId: string;
  address: string;
  addressTag: string;
  network: string;
  status: 'pending' | 'success' | 'failed';
  insertTime: number;
  completeTime: number | null;
}
export interface IndodaxOrderAck {
  symbol: string;
  orderId: number;
  clientOrderId: string;
  side: 'BUY' | 'SELL';
  type: 'LIMIT' | 'MARKET';
  price?: string;
  origQty: string;
  executedQty: string;
  fullOrderId: string;
}
export interface IndodaxOrder extends IndodaxOrderAck {
  status: 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELLED' | 'REJECTED';
  time: number;
}
export interface IndodaxTrade {
  tradeId: string;
  orderId: string;
  clientOrderId: string;
  symbol: string;
  price: string;
  qty: string;
  quoteQty: string;
  commission: string;
  commissionAsset: string;
  isBuyer: boolean;
  isMaker: boolean;
  time: number;
}
export interface IndodaxFiatOrder {
  orderNo: string;
  amount: string;
  totalFee: string;
  method: string;
  fiatCurrency: string;
  status: string;
  createTime: number;
  updateTime: number;
  bankName: string;
  bankTag: string;
  bankAccountNumber: string;
}

/** Error codes worth retrying (server-side, rate limit, clock skew, "not yet available"). */
const RETRYABLE = new Set([-1001, -1003, -1021, -2013, 1112]);

export class IndodaxError extends UpstreamError {
  constructor(
    readonly indodaxCode: number,
    msg: string,
    status: number,
    path: string,
  ) {
    const cls: ErrorClass =
      status >= 500 || status === 429 || RETRYABLE.has(indodaxCode) ? 'retryable' : 'terminal';
    super(`${path} -> ${status} [${indodaxCode}] ${msg}`, cls, String(indodaxCode), status, {
      code: indodaxCode,
      msg,
    });
    this.name = 'IndodaxError';
  }
  /** -2010 means "rejected" for several reasons; only this one means the id was already used. */
  get isDuplicateClientId() {
    return this.indodaxCode === -2010 && /duplicate/i.test(this.message);
  }
  get isNotYetAvailable() {
    return this.indodaxCode === -2013 || this.indodaxCode === 1112;
  }
}

export interface IndodaxClientOptions {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  recvWindow?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export function indodaxSign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Deterministic, Indodax-safe client id (alphanumeric, ≤ 36 chars) derived from our workflow id.
 * `newClientOrderId` / `clientRequestId` are limited to 36 characters, our workflow ids are ~70.
 */
export function indodaxClientId(workflowId: string, purpose: string): string {
  return `mp${createHash('sha256').update(`${workflowId}|${purpose}`).digest('hex').slice(0, 32)}`;
}

type Params = Record<string, string | number | undefined>;

export class IndodaxClient {
  constructor(private readonly o: IndodaxClientOptions) {}

  private async call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, params: Params = {}): Promise<T> {
    const all = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) all.set(k, String(v));
    all.set('timestamp', String((this.o.now ?? Date.now)()));
    all.set('recvWindow', String(this.o.recvWindow ?? 5000));
    const encoded = all.toString();
    const isPost = method === 'POST';
    const url = `${this.o.baseUrl}${path}${isPost ? '' : `?${encoded}`}`;
    let res: Response;
    try {
      res = await (this.o.fetchImpl ?? fetch)(url, {
        method,
        body: isPost ? encoded : undefined,
        headers: {
          accept: 'application/json',
          ...(isPost ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
          'X-APIKEY': this.o.apiKey,
          Sign: indodaxSign(this.o.apiSecret, encoded),
        },
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 10_000),
      });
    } catch (e) {
      const name = e instanceof Error ? e.name : 'Error';
      throw new UpstreamError(
        `${method} ${path}: ${e instanceof Error ? e.message : String(e)}`,
        'retryable',
        name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK',
      );
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    const err = json as { code?: number; msg?: string } | undefined;
    if (!res.ok || (err && typeof err.code === 'number' && err.code < 0 && typeof err.msg === 'string')) {
      throw new IndodaxError(
        err?.code ?? -1000,
        err?.msg ?? text.slice(0, 200),
        res.status,
        `${method} ${path}`,
      );
    }
    return json as T;
  }

  account() {
    return this.call<IndodaxAccount>('GET', '/api/v2/account');
  }
  depositAddresses(coin: string, network: string) {
    return this.call<IndodaxDepositAddress[]>('GET', '/api/v2/capital/deposit/address/list', {
      coin,
      network,
    });
  }
  depositHistory(
    coin: string,
    opts: { startTime?: number; endTime?: number; limit?: number; depositStatus?: string } = {},
  ) {
    return this.call<IndodaxCoinDeposit[]>('GET', '/api/v2/capital/deposit/hisrec', { coin, ...opts });
  }
  createOrder(p: {
    symbol: string;
    side: 'BUY' | 'SELL';
    type: 'MARKET' | 'LIMIT';
    quantity?: string;
    quoteOrderQty?: string;
    price?: string;
    newClientOrderId: string;
  }) {
    return this.call<IndodaxOrderAck>('POST', '/api/v2/order', p);
  }
  getOrder(symbol: string, ref: { orderId?: string; origClientOrderId?: string }) {
    return this.call<IndodaxOrder>('GET', '/api/v2/order', { symbol, ...ref });
  }
  myTrades(symbol: string, ref: { clientOrderId?: string; orderId?: string }) {
    return this.call<{ data: IndodaxTrade[] }>('GET', '/api/v2/myTrades', { symbol, ...ref });
  }
  fiatWithdraw(p: { amount: bigint; accountNumber: string; bankCode: string; clientRequestId: string }) {
    return this.call<{ data: { orderId: string } }>('POST', '/api/v2/fiat/withdraw', {
      apiPaymentMethod: 'bank_transfer',
      currency: 'IDR',
      amount: p.amount.toString(),
      accountInfo: JSON.stringify({ accountNumber: p.accountNumber, bankCodeForPix: p.bankCode }),
      clientRequestId: p.clientRequestId,
    });
  }
  fiatOrders(transactionType: '0' | '1' = '1') {
    return this.call<{ data: IndodaxFiatOrder[] }>('GET', '/api/v2/fiat/orders', { transactionType });
  }
}
