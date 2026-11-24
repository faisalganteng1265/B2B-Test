import { describe, expect, it } from 'vitest';
import { findCommonAncestor, extendsBlock } from '../src/reorg';
import { fetchLogsAdaptive, halve, splitRange } from '../src/ranges';
import { getFinalizedBoundary } from '../src/finality';
import { SimChain } from '../src/sim';
import { RangeTooLargeError } from '../src/types';
import { isRangeTooLarge } from '../src/viem-source';

describe('findCommonAncestor (pure)', () => {
  const local = [
    { number: 105, hash: 'L105' },
    { number: 104, hash: 'L104' },
    { number: 103, hash: 'C103' },
    { number: 102, hash: 'C102' },
  ];
  it('returns the highest height where hashes agree', () => {
    const remote: Record<number, string> = { 105: 'R105', 104: 'R104', 103: 'C103', 102: 'C102' };
    expect(findCommonAncestor(local, (n) => remote[n])).toBe(103);
  });
  it('returns the tip when nothing diverged', () => {
    expect(findCommonAncestor(local, (n) => local.find((b) => b.number === n)?.hash)).toBe(105);
  });
  it('returns null when the reorg is deeper than the window', () => {
    expect(findCommonAncestor(local, () => 'other')).toBeNull();
  });
  it('checks parent links', () => {
    expect(extendsBlock({ hash: 'a' }, { parentHash: 'a' })).toBe(true);
    expect(extendsBlock({ hash: 'a' }, { parentHash: 'b' })).toBe(false);
  });
});

describe('ranges', () => {
  it('splits ranges into chunks', () => {
    expect(splitRange(1, 5000, 2000)).toEqual([
      [1, 2000],
      [2001, 4000],
      [4001, 5000],
    ]);
    expect(splitRange(10, 10, 2000)).toEqual([[10, 10]]);
    expect(splitRange(11, 10, 5)).toEqual([]);
    expect(halve(0, 9)).toEqual([
      [0, 4],
      [5, 9],
    ]);
    expect(halve(4, 5)).toEqual([
      [4, 4],
      [5, 5],
    ]);
  });

  it('adaptively halves when the RPC rejects the range, keeping order and completeness', async () => {
    const sim = new SimChain({ maxRange: 300 });
    const token = '0x00000000000000000000000000000000000000aa';
    const to = '0x00000000000000000000000000000000000000b1';
    const txs: string[] = [];
    for (let i = 0; i < 20; i++) {
      txs.push(sim.transfer(token, '0x1', to, BigInt(i + 1)));
      sim.mine(97);
    }
    let splits = 0;
    const logs = await fetchLogsAdaptive(sim, 1, sim.head, [token], [to], () => splits++);
    expect(logs.map((l) => l.txHash)).toEqual(txs);
    expect(splits).toBeGreaterThan(0);
    expect(sim.calls.rangeRejected).toBe(splits);
  });

  it('propagates non-range errors', async () => {
    const src = {
      getTransferLogsByRange: async () => {
        throw new Error('boom');
      },
    };
    await expect(fetchLogsAdaptive(src, 1, 100, [])).rejects.toThrow('boom');
  });

  it('recognises common provider range errors', () => {
    expect(isRangeTooLarge(new Error('query returned more than 10000 results'))).toBe(true);
    expect(isRangeTooLarge(new Error('eth_getLogs block range too large, max 2000'))).toBe(true);
    expect(isRangeTooLarge(new Error('Log response size exceeded'))).toBe(true);
    expect(isRangeTooLarge(new Error('execution reverted'))).toBe(false);
    expect(new RangeTooLargeError('x')).toBeInstanceOf(Error);
  });
});

describe('getFinalizedBoundary', () => {
  it('uses head - distance, or the more conservative of tag and distance', async () => {
    const sim = new SimChain({ finalizedLag: 50 });
    sim.mine(200);
    expect(await getFinalizedBoundary(sim, { mode: 'distance', reorgSafeDistance: 12 })).toBe(188);
    expect(await getFinalizedBoundary(sim, { mode: 'tag', reorgSafeDistance: 12 })).toBe(150);
    sim.opts.finalizedLag = 5;
    expect(await getFinalizedBoundary(sim, { mode: 'tag', reorgSafeDistance: 12 })).toBe(188);
    sim.opts.finalizedLag = null;
    expect(await getFinalizedBoundary(sim, { mode: 'tag', reorgSafeDistance: 12 })).toBe(188);
  });
});
