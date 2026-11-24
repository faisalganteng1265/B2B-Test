# Indexer design

The indexer turns ERC-20 `Transfer` logs to client deposit addresses into `deposits` rows, makes
sure only _final, canonical_ deposits ever reach the money-moving workflow, and survives crashes,
outages, flaky RPCs and reorgs. Code: `apps/indexer/src`.

It follows the pattern common to production indexers. **Coinbase ChainStorage** separates a
sequential "poller" near the tip from parallel "backfillers", with reorg handling based on parent
hashes. The **AWS blockchain-indexer guidance** recommends durable checkpoints and idempotent sinks.
**Envio HyperIndex** and **rindexer** stream historical ranges in parallel while a head follower
handles the unfinal window with rollback. **Shovel** validates block hashes per batch and rewinds on
mismatch. Concretely:

1. **Two independent paths** over one durable store: _live_ (sequential, near the head) and
   _backfill_ (parallel, strictly below finality).
2. **Reorg detection by parent hash** within the unfinal window.
3. **Durable checkpoints** updated in the same transaction as the data.
4. **Idempotent output**: `UNIQUE(chain_id, tx_hash, log_index)` + deterministic workflow id.

## Finality

```
finalizedBoundary = min(head − REORG_SAFE_DISTANCE, tag)     tag ∈ {safe, finalized}
```

Always the more conservative rule. On Base Sepolia (~5 blocks/s), `safe` trails the head by ~600
blocks (~2 min; the L2 batch has been posted to L1) and `finalized` by ~4,800 (~16 min; L1 finalized). The
prototype uses `safe` + 150 blocks; production mainnet uses `finalized` (ADR-008). Abstraction:
`getFinalizedBoundary(src, cfg)`.

## Live path (`Indexer.liveStep`)

```
cp ← checkpoint (live_head_number, live_head_hash)
head ← eth_blockNumber
if head − cp.head > JUMP_THRESHOLD: catch-up (below)
headers ← getBlock(cp.head+1 … cp.head+LIVE_BATCH)        one JSON-RPC batch
keep the longest prefix with parentHash links starting at cp.head_hash
  first block's parentHash ≠ cp.head_hash → REORG
logs ← getLogs(range of the prefix, token addresses, to ∈ deposit addresses)
require ∀ log: log.blockHash == header[log.blockNumber].hash   (else discard batch, retry)
TX { insert chain_blocks; upsert deposits (status seen); checkpoint := last  (WHERE head = cp.head) }
```

- **Why batch and range:** Base produces ~5 blocks/s. Measured on public RPCs, per-block
  `getLogs({blockHash})` costs ≈230 ms/block, while one range query costs ≈330 ms for up to 2,000
  blocks (ADR-009). Detection latency on Base Sepolia: **~0.8 s** after the receipt.
- **Consistency:** headers and logs come from separate requests, so every log is checked against the
  validated header hash at its height. A batch that straddles a reorg is thrown away.
- **Optimistic concurrency:** the checkpoint update is conditioned on the previous head, so two
  writers can never both advance it.

### Reorg handling

On a parent-hash mismatch:

1. Load our stored canonical headers (descending), fetch the chain's hashes in batches of 32, and run
   the pure `findCommonAncestor(local, remoteHashAt)`.
2. In **one transaction**: mark blocks above the ancestor `orphaned`; `seen` deposits in those blocks
   → `orphaned`; `confirmed`/`dispatched` deposits there → `manual_review` with
   `INCIDENT: reorg after confirmation` (+ audit row, error log, dashboard alert). Then reset the
   checkpoint to the ancestor and record `reorgs_detected` / `last_reorg_depth`.
3. If no ancestor exists within the stored window (deeper than anything we keep), the indexer
   **stops advancing and alerts** (`REORG_TOO_DEEP`) instead of guessing.

Re-included transactions (same `tx_hash`/`log_index` on the new branch) are allowed back only as
`orphaned → seen`, so they must become final again (ADR-012).

## Promoter + transactional outbox

- **Promoter** (leader only, every second): `seen` deposits with `block_number ≤ boundary` are
  re-checked **against the RPC** (`getBlock(height).hash == deposit.block_hash`) and promoted to
  `confirmed`, or orphaned if the hash changed. This is a second, independent reorg check at the
  moment it matters most.
- **Outbox:** `status = confirmed` _is_ the outbox. The dispatcher submits
  `offramp/{chainId}:{txHash}:{logIndex}` to Restate and then sets `dispatched`. A crash between
  the two re-submits, and Restate answers `PreviouslyAccepted` (tested), so the deposit is never lost
  and never doubled.

## Catch-up after downtime

When `head − live_head > JUMP_THRESHOLD`:

1. Verify the old live head is still canonical. If not, roll back first (reorgs during the outage).
2. In one transaction, **move the live head to the finalized boundary** and enqueue
   `(old_head, boundary]` as `backfill_chunks` (default 2,000 blocks).
3. The live path immediately follows the head again, so new deposits keep their ~1 s latency.

**Backfill workers** (`BACKFILL_CONCURRENCY`, default 4, on every replica):

- claim with `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)` + a lease (`locked_until`)
  that a heartbeat extends; a dead worker's chunk is re-claimed when the lease expires;
- `getLogs` per chunk, **halving the range adaptively** when the RPC refuses it (`-32614 "limited to
a 200 range"`, "query returned more than…", etc.);
- because the range is final, deposits are inserted directly as `confirmed`. A deposit the live path
  already saw is upgraded `seen → confirmed`, and an orphaned one is resurrected;
- a failed chunk backs off exponentially and is retried.

**Sweeps** (defense in depth): once a full chunk behind the live head is final, it is re-scanned
through the same machinery. This catches anything the live path might have missed, e.g. a lagging RPC
node behind a load balancer that silently returned fewer logs.

Progress: `finalized_cursor` = everything at or below is covered and final; the dashboard shows chunk
progress. Metrics: `indexer_head_lag_blocks`, `indexer_reorgs_detected_total`,
`indexer_backfill_chunks{status}`, `indexer_rpc_errors_total{method}`, `deposits_by_status`, …

## Resilience

| Concern                  | Mechanism                                                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| RPC outage / rate limits | viem `fallback([publicnode, base.org])`, per-transport retries with backoff, JSON-RPC batching; loops back off with jitter |
| Crash anywhere           | every write is one DB transaction; checkpoint and data move together; leases expire                                        |
| Graceful shutdown        | SIGTERM → loops finish their in-flight step → leases released → exit                                                       |
| HA                       | Postgres advisory lock elects the live leader (standby takes over in ~3 s); backfill on all replicas                       |
| Health                   | `/healthz` (liveness), `/readyz` (lag < `READY_MAX_LAG` and checkpoint fresh), `/metrics` (Prometheus)                     |

## Tests (simulated chain)

Base Sepolia cannot reorg or mine on demand, so `SimChain` implements the same `ChainSource`
interface with `mine(n)`, `reorg(depth, {reinclude})`, range limits, latency and failure injection
(`apps/indexer/test/indexer.int.test.ts`):

- new deposit detected < 3 s, confirmed after 12 blocks, dispatched exactly once;
- **50 deposits + 5,000 blocks while down** → all processed exactly once, a deposit sent during
  catch-up is detected while backfill is still running, and the range splitter is exercised;
- reorged deposit → `orphaned`, never dispatched; re-included tx → processed once on the new branch;
- reorg deeper than the safe distance → `manual_review` incident, never dispatched;
- worker crash mid-backfill → leases expire → another worker finishes, exactly once;
- 20 % RPC error rate during catch-up → nothing lost or duplicated;
- sweep catches a deposit the live path missed.
