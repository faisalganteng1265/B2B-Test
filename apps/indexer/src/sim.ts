import { randomBytes } from 'node:crypto';
import { RangeTooLargeError, type BlockHeader, type ChainSource, type TransferLog } from './types';

interface SimTx {
  txHash: string;
  token: string;
  from: string;
  to: string;
  value: bigint;
}
interface SimBlock extends BlockHeader {
  txs: SimTx[];
}

export interface SimChainOptions {
  genesisNumber?: number;
  /** max blocks per getLogs range; larger ranges throw RangeTooLargeError */
  maxRange?: number;
  /** artificial latency per RPC call */
  latencyMs?: number;
  /** extra latency for range getLogs (makes backfill observable) */
  rangeLatencyMs?: number;
  /** probability any call throws a transient error */
  failRate?: number;
  /** if set, the `finalized` tag is head - this */
  finalizedLag?: number | null;
}

const rnd32 = () => `0x${randomBytes(32).toString('hex')}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * In-process chain simulator implementing ChainSource. Can mine blocks instantly and replace the
 * tip with a different branch (reorg) — things a real Base Sepolia cannot do on demand.
 */
export class SimChain implements ChainSource {
  private blocks: SimBlock[] = [];
  private pending: SimTx[] = [];
  readonly calls = { getBlock: 0, byHash: 0, byRange: 0, rangeRejected: 0, failures: 0 };
  constructor(public opts: SimChainOptions = {}) {
    const g = opts.genesisNumber ?? 0;
    this.blocks[g] = { number: g, hash: rnd32(), parentHash: rnd32(), timestamp: 1_700_000_000, txs: [] };
  }

  get head(): number {
    return this.blocks.length - 1;
  }

  /** Queue a token transfer; it is included in the next mined block. Returns the tx hash. */
  transfer(token: string, from: string, to: string, value: bigint): string {
    const tx = {
      txHash: rnd32(),
      token: token.toLowerCase(),
      from: from.toLowerCase(),
      to: to.toLowerCase(),
      value,
    };
    this.pending.push(tx);
    return tx.txHash;
  }

  /** Mine `n` blocks; pending transfers go into the first one. */
  mine(n = 1): BlockHeader {
    for (let i = 0; i < n; i++) {
      const parent = this.blocks[this.head]!;
      this.blocks.push({
        number: parent.number + 1,
        hash: rnd32(),
        parentHash: parent.hash,
        timestamp: parent.timestamp + 2,
        txs: i === 0 ? this.pending.splice(0) : [],
      });
    }
    return this.header(this.head)!;
  }

  /**
   * Replace the last `depth` blocks with a new branch of `depth + extra` blocks. Transactions from
   * the dropped blocks are discarded unless `reinclude` is set (then they go into the first new block).
   */
  reorg(depth: number, opts: { extra?: number; reinclude?: boolean } = {}): { dropped: string[] } {
    const dropped = this.blocks.splice(this.head - depth + 1, depth);
    const droppedTxs = dropped.flatMap((b) => b.txs);
    if (opts.reinclude) this.pending.unshift(...droppedTxs);
    this.mine(depth + (opts.extra ?? 1));
    return { dropped: dropped.map((b) => b.hash) };
  }

  header(n: number): BlockHeader | null {
    const b = this.blocks[n];
    return b ? { number: b.number, hash: b.hash, parentHash: b.parentHash, timestamp: b.timestamp } : null;
  }

  private async rpc() {
    if (this.opts.latencyMs) await sleep(this.opts.latencyMs);
    if (this.opts.failRate && Math.random() < this.opts.failRate) {
      this.calls.failures++;
      throw new Error('sim: transient RPC error');
    }
  }

  private logsOf(b: SimBlock, tokens: string[], to?: string[]): TransferLog[] {
    const t = new Set(tokens.map((x) => x.toLowerCase()));
    const a = to ? new Set(to) : null;
    return b.txs
      .map((tx, i) => ({ tx, i }))
      .filter(({ tx }) => t.has(tx.token) && (!a || a.has(tx.to)))
      .map(({ tx, i }) => ({
        blockNumber: b.number,
        blockHash: b.hash,
        txHash: tx.txHash,
        logIndex: i,
        token: tx.token,
        from: tx.from,
        to: tx.to,
        value: tx.value,
      }));
  }

  async getHeadNumber() {
    await this.rpc();
    return this.head;
  }
  async getFinalizedTagNumber() {
    await this.rpc();
    const lag = this.opts.finalizedLag;
    return lag === undefined || lag === null ? null : Math.max(0, this.head - lag);
  }
  async getBlock(n: number) {
    await this.rpc();
    this.calls.getBlock++;
    return this.header(n);
  }
  async getTransferLogsByBlockHash(hash: string, tokens: string[], to?: string[]) {
    await this.rpc();
    this.calls.byHash++;
    const b = this.blocks.find((x) => x?.hash === hash);
    // Like a real node: logs for a non-canonical hash are not returned.
    return b ? this.logsOf(b, tokens, to) : [];
  }
  async getTransferLogsByRange(from: number, to: number, tokens: string[], addrs?: string[]) {
    await this.rpc();
    if (this.opts.rangeLatencyMs) await sleep(this.opts.rangeLatencyMs);
    if (this.opts.maxRange && to - from + 1 > this.opts.maxRange) {
      this.calls.rangeRejected++;
      throw new RangeTooLargeError(`sim: block range ${to - from + 1} exceeds ${this.opts.maxRange}`);
    }
    this.calls.byRange++;
    const out: TransferLog[] = [];
    for (let n = from; n <= Math.min(to, this.head); n++)
      out.push(...this.logsOf(this.blocks[n]!, tokens, addrs));
    return out;
  }
}
