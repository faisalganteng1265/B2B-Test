import type { ChainSource } from './types';

export interface FinalityConfig {
  mode: 'tag' | 'distance';
  /** tag used in `tag` mode (default `finalized`) */
  tag?: 'safe' | 'finalized';
  reorgSafeDistance: number;
}

/**
 * Highest block we treat as final. Always the MORE conservative of the configured rules:
 *  - distance: head - reorgSafeDistance
 *  - tag: min(head - reorgSafeDistance, `safe`|`finalized` tag). If the RPC cannot serve the tag we
 *    fall back to distance only.
 */
export async function getFinalizedBoundary(
  src: ChainSource,
  cfg: FinalityConfig,
  head?: number,
): Promise<number> {
  const h = head ?? (await src.getHeadNumber());
  const byDistance = h - cfg.reorgSafeDistance;
  if (cfg.mode === 'distance') return byDistance;
  const tag = await src.getFinalizedTagNumber(cfg.tag ?? 'finalized');
  return tag === null ? byDistance : Math.min(byDistance, tag);
}
