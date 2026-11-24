import { RangeTooLargeError, type ChainSource, type TransferLog } from './types';

/** Split [from, to] inclusive into chunks of at most `size` blocks. */
export function splitRange(from: number, to: number, size: number): [number, number][] {
  if (size < 1) throw new Error('chunk size must be >= 1');
  const out: [number, number][] = [];
  for (let s = from; s <= to; s += size) out.push([s, Math.min(to, s + size - 1)]);
  return out;
}

/** Halve a range: [from, mid] and [mid+1, to]. */
export function halve(from: number, to: number): [[number, number], [number, number]] {
  const mid = from + Math.floor((to - from) / 2);
  return [
    [from, mid],
    [mid + 1, to],
  ];
}

/**
 * getLogs over a range, splitting adaptively in two whenever the RPC refuses the range.
 * Sub-ranges are fetched in order so results stay sorted.
 */
export async function fetchLogsAdaptive(
  src: Pick<ChainSource, 'getTransferLogsByRange'>,
  from: number,
  to: number,
  tokens: string[],
  addrs?: string[],
  onSplit?: (from: number, to: number) => void,
): Promise<TransferLog[]> {
  try {
    return await src.getTransferLogsByRange(from, to, tokens, addrs);
  } catch (e) {
    if (!(e instanceof RangeTooLargeError) || from === to) throw e;
    onSplit?.(from, to);
    const [a, b] = halve(from, to);
    const left = await fetchLogsAdaptive(src, a[0], a[1], tokens, addrs, onSplit);
    const right = await fetchLogsAdaptive(src, b[0], b[1], tokens, addrs, onSplit);
    return [...left, ...right];
  }
}
