import { signMobee } from '../hmac';
import { httpJson, type HttpOptions } from './http';

export interface MobeePrice {
  symbol: string;
  source: 'indodax' | 'fixed';
  bid: string;
  ask: string;
  last: string;
  stale: boolean;
  asOf: string;
  ageMs: number;
  vwap?: {
    amount: string;
    rate: string;
    rateScaled: string;
    levelsUsed: number;
    slippageBps: string;
    idrAmount: string;
  };
}
export interface MobeeWalletAddress {
  subAccountId: string;
  chainId: number;
  address: string;
  createdAt: string;
}
export interface MobeeDeposit {
  txHash: string;
  logIndex: number;
  asset: string;
  amount: string;
  subAccountId: string;
  status: 'pending' | 'credited';
  confirmations: number;
  creditedAt: string | null;
}
export interface MobeeDepositStatus {
  txHash: string;
  status: 'not_found' | 'failed' | 'found';
  deposits: MobeeDeposit[];
}
export interface MobeeQuote {
  quoteId: string;
  subAccountId: string;
  symbol: string;
  amount: string;
  rate: string;
  rateScaled: string;
  idrAmount: string;
  priceSource: string;
  priceAsOf: string;
  stale: boolean;
  levelsUsed: number;
  slippageBps: string;
  expiresAt: string;
}
export interface MobeeOrder {
  orderId: string;
  quoteId: string;
  subAccountId: string;
  symbol: string;
  amount: string;
  rateScaled: string;
  idrAmount: string;
  status: 'filled';
  createdAt: string;
}
export interface MobeeBalances {
  subAccountId: string;
  balances: Record<string, string>;
}

export interface MobeeClientOptions extends HttpOptions {
  apiKey: string;
  apiSecret: string;
  now?: () => number;
}

/** Client for the Mobee-shaped Open API (here: mobee-mock). Signs every private request. */
export class MobeeClient {
  constructor(private readonly o: MobeeClientOptions) {}

  private req<T>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
    const raw = body === undefined ? undefined : JSON.stringify(body);
    const ts = String(Math.floor((this.o.now ?? Date.now)() / 1000));
    return httpJson<T>(this.o, method, path, raw, {
      'x-api-key': this.o.apiKey,
      'x-request-timestamp': ts,
      'x-request-signature': signMobee(this.o.apiSecret, method, path, ts, raw),
      ...extraHeaders,
    });
  }

  price(amountBaseUnits?: bigint) {
    const q = amountBaseUnits ? `&amount=${amountBaseUnits}` : '';
    return this.req<MobeePrice>('GET', `/v1/market/price?symbol=USDT-IDR${q}`);
  }
  createWalletAddress(subAccountId: string, chainId: number) {
    return this.req<MobeeWalletAddress>('POST', '/v1/wallet-addresses', {
      subAccountId,
      chainId,
      asset: 'USDT',
    });
  }
  depositStatus(txHash: string) {
    return this.req<MobeeDepositStatus>('GET', `/v1/deposits/crypto?txHash=${txHash}`);
  }
  balances(subAccountId: string) {
    return this.req<MobeeBalances>('GET', `/v1/balances?subAccountId=${encodeURIComponent(subAccountId)}`);
  }
  calculate(subAccountId: string, amountBaseUnits: bigint) {
    return this.req<Omit<MobeeQuote, 'quoteId' | 'expiresAt'>>('POST', '/v1/quick-swap/calculate', {
      subAccountId,
      symbol: 'USDT-IDR',
      amount: amountBaseUnits.toString(),
    });
  }
  lock(subAccountId: string, amountBaseUnits: bigint) {
    return this.req<MobeeQuote>('POST', '/v1/quick-swap/lock', {
      subAccountId,
      symbol: 'USDT-IDR',
      amount: amountBaseUnits.toString(),
    });
  }
  confirm(quoteId: string, idempotencyKey: string) {
    return this.req<MobeeOrder>(
      'POST',
      '/v1/quick-swap/confirm',
      { quoteId },
      { 'idempotency-key': idempotencyKey },
    );
  }
  order(orderId: string) {
    return this.req<MobeeOrder>('GET', `/v1/orders/${encodeURIComponent(orderId)}`);
  }
}
