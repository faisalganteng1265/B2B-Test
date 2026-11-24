import { Counter, Gauge, Registry } from 'prom-client';
import type { IndexerStore } from './store';

export class IndexerMetrics {
  readonly registry = new Registry();
  readonly chainHead = new Gauge({
    name: 'indexer_chain_head',
    help: 'Latest block number from RPC',
    registers: [this.registry],
  });
  readonly liveHead = new Gauge({
    name: 'indexer_live_head',
    help: 'Live worker head',
    registers: [this.registry],
  });
  readonly headLag = new Gauge({
    name: 'indexer_head_lag_blocks',
    help: 'chain head - live head',
    registers: [this.registry],
  });
  readonly finalizedBoundary = new Gauge({
    name: 'indexer_finalized_boundary',
    help: 'Finalized boundary used',
    registers: [this.registry],
  });
  readonly reorgs = new Counter({
    name: 'indexer_reorgs_detected_total',
    help: 'Reorgs detected by the live worker',
    registers: [this.registry],
  });
  readonly reorgDepth = new Gauge({
    name: 'indexer_last_reorg_depth',
    help: 'Depth of the last reorg',
    registers: [this.registry],
  });
  readonly reorgIncidents = new Counter({
    name: 'indexer_reorg_incidents_total',
    help: 'Confirmed/dispatched deposits hit by a reorg (must stay 0)',
    registers: [this.registry],
  });
  readonly rpcErrors = new Counter({
    name: 'indexer_rpc_errors_total',
    help: 'RPC errors',
    labelNames: ['method'] as const,
    registers: [this.registry],
  });
  readonly rangeSplits = new Counter({
    name: 'indexer_getlogs_range_splits_total',
    help: 'Adaptive getLogs splits',
    registers: [this.registry],
  });
  readonly depositsDetected = new Counter({
    name: 'indexer_deposits_detected_total',
    help: 'New deposits recorded',
    labelNames: ['source'] as const,
    registers: [this.registry],
  });
  readonly dispatches = new Counter({
    name: 'indexer_dispatch_total',
    help: 'Workflow dispatch attempts',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });

  constructor(store: IndexerStore) {
    const registry = this.registry;
    new Gauge({
      name: 'indexer_backfill_chunks',
      help: 'Backfill chunks by status',
      labelNames: ['status'] as const,
      registers: [registry],
      async collect() {
        const p = await store.backfillProgress();
        this.reset();
        for (const s of ['pending', 'running', 'done', 'failed'])
          this.set({ status: s }, p.byStatus[s]?.chunks ?? 0);
      },
    });
    new Gauge({
      name: 'deposits_by_status',
      help: 'Deposits by status',
      labelNames: ['status'] as const,
      registers: [registry],
      async collect() {
        const c = await store.depositCountsByStatus();
        this.reset();
        for (const [s, n] of Object.entries(c)) this.set({ status: s }, n);
      },
    });
  }
}
