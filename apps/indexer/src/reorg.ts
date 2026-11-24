import type { BlockHeader } from './types';

/**
 * Pure common-ancestor search.
 * @param localDesc our canonical headers, highest first (contiguous)
 * @param remoteHashAt canonical hash on the chain at a height (undefined if unknown)
 * @returns the highest height where both agree, or null if none in the window
 */
export function findCommonAncestor(
  localDesc: Pick<BlockHeader, 'number' | 'hash'>[],
  remoteHashAt: (n: number) => string | undefined,
): number | null {
  for (const b of localDesc) {
    if (remoteHashAt(b.number) === b.hash) return b.number;
  }
  return null;
}

/** True if `next` extends `prev` (parent-hash link). */
export const extendsBlock = (prev: Pick<BlockHeader, 'hash'>, next: Pick<BlockHeader, 'parentHash'>) =>
  next.parentHash === prev.hash;
