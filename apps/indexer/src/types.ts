export interface BlockHeader {
  number: number;
  hash: string;
  parentHash: string;
  timestamp: number;
}

export interface TransferLog {
  blockNumber: number;
  blockHash: string;
  txHash: string;
  logIndex: number;
  token: string;
  from: string;
  to: string;
  value: bigint;
}

/** Thrown when an RPC refuses a getLogs range (too many blocks / results). */
export class RangeTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RangeTooLargeError';
  }
}

/**
 * The minimal RPC surface the indexer needs. Implemented by viem (real chain) and SimChain (tests).
 * All addresses are lowercase.
 */
export interface ChainSource {
  getHeadNumber(): Promise<number>;
  /** Block number of the `safe` / `finalized` tag, or null if the chain/RPC does not support it. */
  getFinalizedTagNumber(tag: 'safe' | 'finalized'): Promise<number | null>;
  getBlock(number: number): Promise<BlockHeader | null>;
  /** Transfer logs of `tokens` inside exactly this block (by hash, so header and logs are consistent). */
  getTransferLogsByBlockHash(blockHash: string, tokens: string[], to?: string[]): Promise<TransferLog[]>;
  /** Transfer logs in an inclusive block range. May throw RangeTooLargeError. */
  getTransferLogsByRange(
    fromBlock: number,
    toBlock: number,
    tokens: string[],
    to?: string[],
  ): Promise<TransferLog[]>;
}
