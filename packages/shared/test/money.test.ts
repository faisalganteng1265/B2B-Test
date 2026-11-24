import { describe, expect, it } from 'vitest';
import { feeIdr, formatDecimal, parseDecimal, parseToken, swapBreakdown, tokenToIdr, vwapSell, parseRate } from '../src/money';

describe('money', () => {
  it('parses and formats decimals without floats', () => {
    expect(parseDecimal('1000', 6)).toBe(1_000_000_000n);
    expect(parseDecimal('0.000001', 6)).toBe(1n);
    expect(parseDecimal('1.23456789', 6)).toBe(1_234_567n); // truncates
    expect(formatDecimal(1_234_567n, 6)).toBe('1.234567');
    expect(formatDecimal(1_000_000n, 6)).toBe('1');
    expect(() => parseDecimal('1e5', 6)).toThrow();
    expect(() => parseDecimal('-1', 6)).toThrow();
  });

  it('converts token to IDR rounding down', () => {
    // 1.000001 USDT at 18312.5 IDR => 18312.5183... -> 18312
    expect(tokenToIdr(1_000_001n, parseRate('18312.5'))).toBe(18_312n);
    expect(tokenToIdr(parseToken('1000'), parseRate('18312'))).toBe(18_312_000n);
  });

  it('rounds fee up and net down', () => {
    expect(feeIdr(10_000n)).toBe(35n);
    expect(feeIdr(10_001n)).toBe(36n); // 35.0035 -> 36
    expect(feeIdr(0n)).toBe(0n);
    const b = swapBreakdown(parseToken('1000'), parseRate('18312'));
    expect(b.grossIdr).toBe(18_312_000n);
    expect(b.feeIdr).toBe(64_092n);
    expect(b.netIdr + b.feeIdr).toBe(b.grossIdr);
  });

  it('never pays out more than gross for random inputs', () => {
    for (let i = 0; i < 1000; i++) {
      const amt = BigInt(Math.floor(Math.random() * 1e12));
      const rate = BigInt(Math.floor(Math.random() * 3e10));
      const b = swapBreakdown(amt, rate);
      expect(b.netIdr).toBeLessThanOrEqual(b.grossIdr);
      expect(b.feeIdr).toBeGreaterThanOrEqual(0n);
      expect(b.netIdr + b.feeIdr).toBe(b.grossIdr);
    }
  });

  it('computes VWAP by walking the bid book', () => {
    const bids = [
      { priceScaled: parseRate('18312'), amount: parseToken('100') },
      { priceScaled: parseRate('18306'), amount: parseToken('100') },
      { priceScaled: parseRate('18300'), amount: parseToken('1000') },
    ];
    const r = vwapSell(bids, parseToken('300'));
    // (100*18312 + 100*18306 + 100*18300)/300 = 18306
    expect(r.vwapScaled).toBe(parseRate('18306'));
    expect(r.levelsUsed).toBe(3);
    expect(r.worstScaled).toBe(parseRate('18300'));
    expect(r.slippageBps).toBe(4n); // 6/18312 = 3.27bps -> 4
    expect(vwapSell(bids, parseToken('50')).vwapScaled).toBe(parseRate('18312'));
    expect(() => vwapSell(bids, parseToken('5000'))).toThrow('INSUFFICIENT_LIQUIDITY');
  });
});
