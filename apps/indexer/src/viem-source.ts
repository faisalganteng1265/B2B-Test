import { erc20Abi, getAbiItem, type Address, type Hash, type Log, type PublicClient } from 'viem';
import { RangeTooLargeError, type BlockHeader, type ChainSource, type TransferLog } from './types';

const transferEvent = getAbiItem({ abi: erc20Abi, name: 'Transfer' });
/** With more deposit addresses than this, filter `to` in the app instead of the topic filter. */
const MAX_TOPIC_ADDRESSES = 200;

const RANGE_ERROR_PATTERNS = [
  /block range/i,
  /range (is )?too (large|wide)/i,
  /exceed(s|ed)? (the )?max/i,
  /more than \d+ (results|logs)/i,
  /query returned more than/i,
  /response size (exceeded|is larger)/i,
  /limit exceeded/i,
  /too many (blocks|results|logs)/i,
  /limited to (a )?\d+ (block )?range/i, // sepolia.base.org: -32614 "eth_getLogs is limited to a 200 range"
  /-32614|-32005/,
];

export function isRangeTooLarge(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.message} ${(e as { details?: string }).details ?? ''}` : String(e);
  return RANGE_ERROR_PATTERNS.some((p) => p.test(msg));
}

type TransferViemLog = Log<bigint, number, false, typeof transferEvent, true>;

function toTransfer(l: TransferViemLog): TransferLog {
  return {
    blockNumber: Number(l.blockNumber),
    blockHash: l.blockHash.toLowerCase(),
    txHash: l.transactionHash.toLowerCase(),
    logIndex: l.logIndex,
    token: l.address.toLowerCase(),
    from: l.args.from.toLowerCase(),
    to: l.args.to.toLowerCase(),
    value: l.args.value,
  };
}

export class ViemChainSource implements ChainSource {
  constructor(private readonly client: PublicClient) {}

  getHeadNumber() {
    return this.client.getBlockNumber({ cacheTime: 0 }).then(Number);
  }

  async getFinalizedTagNumber(tag: 'safe' | 'finalized') {
    try {
      const b = await this.client.getBlock({ blockTag: tag });
      return b.number === null ? null : Number(b.number);
    } catch {
      return null;
    }
  }

  async getBlock(number: number): Promise<BlockHeader | null> {
    try {
      const b = await this.client.getBlock({ blockNumber: BigInt(number) });
      if (!b.hash || b.number === null) return null;
      return {
        number: Number(b.number),
        hash: b.hash.toLowerCase(),
        parentHash: b.parentHash.toLowerCase(),
        timestamp: Number(b.timestamp),
      };
    } catch (e) {
      if (e instanceof Error && e.name === 'BlockNotFoundError') return null;
      throw e;
    }
  }

  private filterTo(to?: string[]) {
    return to && to.length > 0 && to.length <= MAX_TOPIC_ADDRESSES ? { to: to as Address[] } : undefined;
  }

  private post(logs: TransferViemLog[], to?: string[]) {
    const set = to ? new Set(to) : null;
    return logs.map(toTransfer).filter((l) => !set || set.has(l.to));
  }

  async getTransferLogsByBlockHash(blockHash: string, tokens: string[], to?: string[]) {
    if (to && to.length === 0) return [];
    const logs = await this.client.getLogs({
      address: tokens as Address[],
      event: transferEvent,
      args: this.filterTo(to),
      blockHash: blockHash as Hash,
      strict: true,
    });
    return this.post(logs as TransferViemLog[], to);
  }

  async getTransferLogsByRange(fromBlock: number, toBlock: number, tokens: string[], to?: string[]) {
    if (to && to.length === 0) return [];
    try {
      const logs = await this.client.getLogs({
        address: tokens as Address[],
        event: transferEvent,
        args: this.filterTo(to),
        fromBlock: BigInt(fromBlock),
        toBlock: BigInt(toBlock),
        strict: true,
      });
      return this.post(logs as TransferViemLog[], to);
    } catch (e) {
      if (isRangeTooLarge(e)) throw new RangeTooLargeError(e instanceof Error ? e.message : String(e));
      throw e;
    }
  }
}
