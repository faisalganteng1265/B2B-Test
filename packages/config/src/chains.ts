import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { repoRoot } from './env';

export type ChainName = 'base-sepolia' | 'base';

export interface ChainConfig {
  name: ChainName;
  chainId: number;
  /** Approximate block time; drives polling cadence. */
  blockTimeMs: number;
  /**
   * How finality is determined. `tag` = use the RPC `finalized` block tag (OP-stack L2s
   * expose it once the batch is final on L1). `distance` = head - reorgSafeDistance.
   * The indexer always takes the MORE conservative (lower) of the two when both are available.
   */
  finality: 'tag' | 'distance';
  /** Which block tag counts as final: `safe` (L2 data posted to L1) or `finalized` (L1 finalized). */
  finalityTag: 'safe' | 'finalized';
  reorgSafeDistance: number;
  explorerTxUrl: (hash: string) => string;
}

export const CHAINS: Record<ChainName, ChainConfig> = {
  'base-sepolia': {
    name: 'base-sepolia',
    chainId: 84532,
    // Measured Nov 2026: ~5 blocks/s; `safe` trails head by ~600 blocks (~2 min),
    // `finalized` by ~4,800 (~16 min).
    blockTimeMs: 200,
    finality: 'tag',
    finalityTag: 'safe',
    reorgSafeDistance: 150,
    explorerTxUrl: (h) => `https://sepolia.basescan.org/tx/${h}`,
  },
  base: {
    name: 'base',
    chainId: 8453,
    blockTimeMs: 200,
    finality: 'tag',
    finalityTag: 'finalized',
    reorgSafeDistance: 300,
    explorerTxUrl: (h) => `https://basescan.org/tx/${h}`,
  },
};

const hex = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
export const deploymentSchema = z.object({
  chainId: z.number(),
  deployBlock: z.number(),
  deployer: hex,
  clientWallets: z.array(hex),
  tokens: z.record(z.string(), hex),
});
export type Deployment = z.infer<typeof deploymentSchema>;

export function loadDeployment(chainId: number): Deployment {
  const p = join(repoRoot(), 'deployments', `${chainId}.json`);
  if (!existsSync(p)) throw new Error(`no deployment for chain ${chainId} at ${p}; run make deploy`);
  return deploymentSchema.parse(JSON.parse(readFileSync(p, 'utf8')));
}
