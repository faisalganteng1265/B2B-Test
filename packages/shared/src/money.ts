/**
 * Integer-only money math. Conventions:
 *  - token amounts: bigint base units (USDT/USDC = 6 decimals)
 *  - rupiah: bigint whole rupiah (IDR has no minor unit in BI-FAST)
 *  - rates: bigint "IDR per 1 whole token" scaled by RATE_SCALE (1e6)
 *
 * Rounding policy (safe for Mopay, see docs/decisions.md ADR-006):
 *  - IDR the client receives from a swap: rounded DOWN
 *  - fees charged by Mopay: rounded UP
 *  - VWAP of a sell into the bid book: rounded DOWN (pessimistic execution price)
 */
export const TOKEN_DECIMALS = 6;
export const RATE_SCALE = 1_000_000n;
export const BPS = 10_000n;
/** Default Mopay fee: 0.35% = 35 bps. */
export const DEFAULT_FEE_BPS = 35n;

export function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** Parse a non-negative decimal string into an integer scaled by 10^decimals, truncating extra digits. */
export function parseDecimal(value: string, decimals: number): bigint {
  const s = value.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`invalid decimal: ${value}`);
  const [int, frac = ''] = s.split('.') as [string, string?];
  const fracPadded = (frac ?? '').slice(0, decimals).padEnd(decimals, '0');
  return BigInt(int) * pow10(decimals) + BigInt(fracPadded || '0');
}

/** Format an integer scaled by 10^decimals as a decimal string (no float). */
export function formatDecimal(value: bigint, decimals: number, maxFrac = decimals): string {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const base = pow10(decimals);
  const int = v / base;
  const frac = (v % base).toString().padStart(decimals, '0').slice(0, maxFrac).replace(/0+$/, '');
  const out = frac ? `${int}.${frac}` : `${int}`;
  return neg ? `-${out}` : out;
}

export const parseToken = (v: string, decimals = TOKEN_DECIMALS) => parseDecimal(v, decimals);
export const formatToken = (v: bigint, decimals = TOKEN_DECIMALS) => formatDecimal(v, decimals);
export const parseRate = (v: string) => parseDecimal(v, 6);
export const formatRate = (v: bigint) => formatDecimal(v, 6, 2);

/** Gross IDR for `amount` token base units at `rateScaled`, rounded down. */
export function tokenToIdr(amount: bigint, rateScaled: bigint, decimals = TOKEN_DECIMALS): bigint {
  if (amount < 0n || rateScaled < 0n) throw new Error('negative amount/rate');
  return (amount * rateScaled) / (pow10(decimals) * RATE_SCALE);
}

/** Fee in IDR, rounded up. */
export function feeIdr(gross: bigint, feeBps: bigint = DEFAULT_FEE_BPS): bigint {
  if (gross < 0n) throw new Error('negative gross');
  return ceilDiv(gross * feeBps, BPS);
}

export interface SwapBreakdown {
  grossIdr: bigint;
  feeIdr: bigint;
  netIdr: bigint;
}

export function swapBreakdown(
  amount: bigint,
  rateScaled: bigint,
  feeBps: bigint = DEFAULT_FEE_BPS,
): SwapBreakdown {
  const grossIdr = tokenToIdr(amount, rateScaled);
  const fee = feeIdr(grossIdr, feeBps);
  return { grossIdr, feeIdr: fee, netIdr: grossIdr - fee };
}

export interface BookLevel {
  /** price, IDR per token, scaled 1e6 */
  priceScaled: bigint;
  /** token base units available at this level */
  amount: bigint;
}

export interface VwapResult {
  vwapScaled: bigint;
  bestScaled: bigint;
  worstScaled: bigint;
  filled: bigint;
  levelsUsed: number;
  /** (best - vwap) / best, in bps, rounded up */
  slippageBps: bigint;
}

/**
 * Walk the bid side (sorted best/highest first) to sell `amount`. Throws if the book is too thin.
 * VWAP is rounded down (worse for the seller, i.e. conservative).
 */
export function vwapSell(bids: BookLevel[], amount: bigint): VwapResult {
  if (amount <= 0n) throw new Error('amount must be positive');
  const first = bids[0];
  if (!first) throw new Error('empty order book');
  let remaining = amount;
  let notional = 0n;
  let worst = first.priceScaled;
  let levels = 0;
  for (const lvl of bids) {
    if (remaining === 0n) break;
    const fill = lvl.amount < remaining ? lvl.amount : remaining;
    if (fill <= 0n) continue;
    notional += fill * lvl.priceScaled;
    remaining -= fill;
    worst = lvl.priceScaled;
    levels++;
  }
  if (remaining > 0n) throw new Error('INSUFFICIENT_LIQUIDITY');
  const vwap = notional / amount;
  const slippageBps = ceilDiv((first.priceScaled - vwap) * BPS, first.priceScaled);
  return {
    vwapScaled: vwap,
    bestScaled: first.priceScaled,
    worstScaled: worst,
    filled: amount,
    levelsUsed: levels,
    slippageBps,
  };
}

/** JSON-safe bigint serialization helper. */
export const bigintReplacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);
