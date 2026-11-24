import { createPublicClient, fallback, http, type PublicClient } from 'viem';
import { base, baseSepolia } from 'viem/chains';

const VIEM_CHAINS = { 84532: baseSepolia, 8453: base } as const;

/**
 * Public client with multi-RPC failover: viem `fallback()` tries transports in order and moves to
 * the next on error. Each transport retries with exponential backoff before falling over, and
 * coalesces concurrent calls into one JSON-RPC batch request (the live indexer fetches headers and
 * logs for many blocks in parallel).
 */
export function createChainClient(
  chainId: number,
  rpcUrls: string[],
  opts: { timeoutMs?: number; retryCount?: number; batchSize?: number } = {},
): PublicClient {
  const chain = VIEM_CHAINS[chainId as keyof typeof VIEM_CHAINS];
  if (!chain) throw new Error(`unsupported chainId ${chainId}`);
  const transports = rpcUrls.map((url) =>
    http(url, {
      timeout: opts.timeoutMs ?? 10_000,
      retryCount: opts.retryCount ?? 3,
      retryDelay: 250,
      batch: { batchSize: opts.batchSize ?? 50, wait: 5 },
    }),
  );
  return createPublicClient({
    chain,
    transport:
      transports.length === 1 ? transports[0]! : fallback(transports, { rank: false, retryCount: 2 }),
  }) as PublicClient;
}
