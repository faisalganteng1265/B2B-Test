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
  reorgSafeDistance: number;
  explorerTxUrl: (hash: string) => string;
}

export const CHAINS: Record<ChainName, ChainConfig> = {
  'base-sepolia': {
    name: 'base-sepolia',
    chainId: 84532,
    blockTimeMs: 2000,
    finality: 'distance',
    reorgSafeDistance: 30,
    explorerTxUrl: (h) => `https://sepolia.basescan.org/tx/${h}`,
  },
  base: {
    name: 'base',
    chainId: 8453,
    blockTimeMs: 2000,
    finality: 'tag',
    reorgSafeDistance: 60,
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
