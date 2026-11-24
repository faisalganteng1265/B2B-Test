# Architecture Decision Records

## ADR-001 — Chain: Base Sepolia, no Anvil

**Context.** The original spec used Anvil locally. The product owner asked to use Base only.
**Decision.** All runtime and demo traffic runs on **Base Sepolia (chainId 84532)**. Mock tokens
(`MockUSDT`, `MockUSDC`, 6 decimals) are deployed there by `scripts/deploy.sh`, which writes
`deployments/84532.json`.
**Consequences.**

- Reorgs on Base Sepolia are rare and cannot be triggered on demand, and blocks cannot be mined
  at will. Indexer reorg, catch-up and crash-resume acceptance tests therefore run against an
  **in-process simulated chain** (`SimChain`) that implements the same RPC surface the indexer
  uses (block by number/hash, logs by blockHash/range, `finalized` tag), and can mine N blocks
  or replace a branch of depth K.
- The catch-up demo on the real chain is done by stopping the indexer for real wall-clock time
  (Base produces a block every ~2s, so 1 hour ≈ 1,800 blocks).
- Finality uses the chain's `finalized` block tag (OP-stack L2), with a configurable
  `REORG_SAFE_DISTANCE` fallback.

## ADR-002 — Runtime without Docker

**Context.** The development machine has no container runtime; Postgres 18 runs natively and the
Restate server is distributed on npm (`@restatedev/restate-server`).
**Decision.** Local runs are native (local Postgres, `restate-server` via npm, services via
`tsx`). `docker-compose.yml` is still provided per the spec for environments with Docker, but it
is not exercised on this machine.

## ADR-003 — Node 26 instead of Node 22

The machine runs Node 26. The code targets ES2023 and uses no Node-26-only APIs, so it should
still run on Node 22 LTS (`engines: >=22`).

## ADR-004 — Integer money, rounding in Mopay's favour

Token amounts are `numeric(78,0)` base units, rupiah are `bigint` whole rupiah, and rates are
integers "IDR per 1 token × 10⁶". No float ever touches money. The IDR a client receives is
rounded **down**, fees are rounded **up**, and the VWAP when selling into the bid book is rounded
**down**. Mopay can therefore never pay out more than the exchange actually credited.
Implementation: `packages/shared/src/money.ts`; a property test checks `net + fee = gross`
and `net ≤ gross`.

## ADR-005 — Ledger and state invariants enforced in the database, too

The app validates journals before posting, but the database is the last line of defence:

- a deferred constraint trigger rejects any transaction that leaves a journal unbalanced per currency;
- `ledger_entries` is append-only (UPDATE/DELETE raise);
- each journal has a deterministic id (`<depositId>:<purpose>`) with a PK in `ledger_journals`,
  so a retried workflow step cannot double-post;
- a trigger on `deposits.status` enforces the state machine. In particular, `orphaned` is
  terminal and `seen → dispatched` is illegal, so a deposit hit by a reorg can never be dispatched,
  even through a bug in application code.
  Postgres 18 (native on this machine) is used instead of 16; nothing version-specific is used.

## ADR-006 — Extra tables beyond the spec

- `offramp_step_events`: an append-only timeline (started/succeeded/retrying/failed per step,
  with attempt number and error) that backs the dashboard's per-deposit timeline.
- `ledger_journals`: the idempotency key for journal posting (see ADR-005).
- `clients.api_key_prefix` / `api_key_salt`: O(1) key lookup without storing plaintext.

## ADR-007 — Mock upstreams: SQLite state, extra chaos modes
- **State** for mobee-mock and bifast-mock lives in `node:sqlite` (WAL, `synchronous=FULL`) under
  `data/`. It is transactional, so a crash cannot half-apply a swap, and it survives restarts. This
  is stronger than the "in-memory + snapshot" option in the spec.
- **Idempotency** on `quick-swap/confirm` and `transfers`: the request hash plus the response are
  stored per `Idempotency-Key`, and a replay returns the identical response. Reusing a key with a
  different body → `422 IDEMPOTENCY_KEY_REUSED`. A quote can be executed only once
  (`QUOTE_ALREADY_USED`), even under different keys.
- **Chaos extensions** beyond the spec: `FAIL_AFTER_RATE` (process the request, then 500, i.e. the
  response is lost; this is the case that really proves idempotency), `DROP_CALLBACK_RATE` (forces
  reconciliation via `GET /v1/transfers/:id`), and `FINAL_FAILURE_RATE` (default 0, so the
  acceptance run "100 deposits → all completed" is deterministic; raise it to demo `manual_review`).
- **BI-FAST outcomes** are decided when the transfer is created and stored, so `GET` and the callback
  always agree. The callback scheduler is a DB-driven tick loop, so pending callbacks resume after
  a restart and are retried with backoff while Mopay's webhook is down.
- **Price**: only the *rate* is real (Indodax public ticker + depth, VWAP on the bid side). The
  feed caches for 3–5 s, coalesces concurrent reads (≤ 30 upstream req/min, under Indodax's 180/min),
  serves stale data with `stale: true`, and refuses `lock` with retryable `PRICE_UNAVAILABLE` once
  the data is older than 60 s.
- **Mobee signature path** = `pathname + search` (query string included), body included for POST/PUT.
- **Closed account** `002/9990000001` exists in the mock bank directory to demo a final bank reject.

## ADR-008 — Indexer finality on Base: `safe` tag + distance floor
**Measured on Base Sepolia (Nov 2026):** about 5 blocks/s; the `safe` tag trails head by ~600 blocks
(~2 min, meaning the L2 batch has been posted to L1); `finalized` trails by ~4,800 blocks (~16 min, meaning L1 finalized).
**Decision.** `finalizedBoundary = min(head − REORG_SAFE_DISTANCE, tag)`, i.e. always the more
conservative rule. Base Sepolia uses tag=`safe` and distance=150. Base mainnet uses tag=`finalized`
and distance=300. Both can be overridden with `FINALITY_MODE`, `FINALITY_TAG`, `REORG_SAFE_DISTANCE`.
A Base reorg below `safe` requires an L1 reorg, so `safe` is an acceptable demo/testnet trade-off;
production mainnet uses `finalized` (see docs/production.md).
**Observed:** detection 0.8 s after the receipt; `confirmed` ~105 s after the receipt.

## ADR-009 — Live path: batched headers + one validated range getLogs
At ~5 blocks/s, a per-block live worker (≈430 ms RPC latency) cannot keep up, and per-block
`getLogs({blockHash})` is about 10× slower than a range query on public RPCs (measured: 50 blocks →
11.8 s by hash vs ≈330 ms by range). The live worker therefore:
1. fetches up to `LIVE_BATCH` (25) headers in one JSON-RPC batch and keeps the longest prefix
   that forms a parent-hash chain from the checkpoint (a mismatch at the first block means a reorg,
   which triggers the walk back to the common ancestor);
2. runs one range `getLogs` over that prefix and **requires every log's `blockHash` to equal the
   validated header at its height**. Any mismatch discards the batch, so headers and logs can
   never come from different forks;
3. writes blocks, deposits and the checkpoint in one transaction (optimistic concurrency on the
   previous live head).
The residual risk is a lagging node behind a load balancer silently returning *fewer* logs. That is
covered by **final-range sweeps**: once a full chunk behind the live head is final, it is
re-scanned through the backfill machinery. A deposit can therefore be delayed until finality but never lost.
Sweeps are tested by simulating exactly that lagging node.

## ADR-010 — RPC providers
`sepolia.base.org` enforces 25 req/s and `eth_getLogs` ranges ≤ 200 blocks (`-32614`).
publicnode handles 100-call batches and 2,000-block ranges. Order: publicnode first, base.org as
the viem `fallback()`. The adaptive range splitter recognises the `-32614` message, so failover to
base.org still works.

## ADR-011 — Indexer HA: advisory-lock leader + SKIP LOCKED backfill
Live worker, promoter, outbox dispatcher and housekeeping run only on the replica holding
`pg_try_advisory_lock(hashtext('mopay-indexer-live:<chainId>'))` on a dedicated session. If it dies,
the session ends and a standby takes over within ~3 s. Backfill workers run on every replica,
claiming chunks with `FOR UPDATE SKIP LOCKED` plus a lease that is extended by a heartbeat. A crashed
worker's chunk is re-claimed after the lease expires (tested). In addition, the checkpoint update
uses optimistic concurrency, so even two "leaders" cannot both advance the head.

## ADR-012 — Re-included transactions after a reorg
Only `orphaned → seen` is allowed (migration 0002). A reorged deposit that reappears on the new
branch must become final again before it can be dispatched, and it keeps its deterministic
workflow id `{chainId}:{txHash}:{logIndex}`, so it can never run twice.

## ADR-013 — Why Restate for orchestration
Every step of the offramp touches money in an external system (exchange swap, bank transfer). We
need (a) a durable record of which side effects already happened, (b) automatic retries without
re-executing completed effects, and (c) waiting on external events (bank callbacks) for minutes or
hours without holding a process. Restate's journal gives exactly this. `ctx.run` results are
persisted and replayed instead of re-executed after a crash, `ctx.sleep` and awakeables suspend
the invocation without a live process, and the workflow key gives at-most-once execution per
deposit. The service itself is stateless, so we scale or restart replicas freely. Alternatives
(a hand-rolled outbox + state machine, Temporal) need either much more code or a heavier
cluster with deterministic-replay restrictions on the code.

## ADR-014 — Workflow idempotency rules
- Restate key = `{chainId}:{txHash}:{logIndex}`; a duplicate submit returns `PreviouslyAccepted` (tested).
- External idempotency keys derive from `deposits.workflow_id` (canonical), not the Restate key, so
  an admin re-drive (`<id>#retry-N`) reuses the same swap/payout keys and cannot double-pay.
- Swap: `wf:swap` on the first quote and `wf:swap:N` on re-quotes. Mobee records `QUOTE_EXPIRED` against
  a key, so a re-quote needs a new key. This is safe because we re-quote only after a definitive
  "not executed" answer, and Mobee executes a quote at most once.
- Payout: the `payouts` row (UNIQUE deposit_id + idempotency_key) and the awakeable id are stored
  BEFORE `POST /transfers`, so a fast callback can always find what to wake.
- Waiting for the bank: the awakeable plus `orTimeout(PAYOUT_CALLBACK_TIMEOUT_MS)`. On timeout we reconcile
  with `GET /v1/transfers/:id` and keep waiting on the same awakeable (tested with dropped callbacks).
- Ledger journals use ids `<depositId>:{received,swap,payout}`, so re-running a step is a no-op.
- Error classes: retryable (5xx/timeout/network/429/PRICE_UNAVAILABLE) → rethrown, and Restate
  retries with exponential backoff (300 ms → 10 s) and **no attempt limit**, with an ALERT log + audit
  row after `STEP_ALERT_AFTER_ATTEMPTS`. Terminal (validation, QUOTE_EXPIRED×5, name mismatch,
  bank reject, insufficient balance) → `TerminalError` → `manual_review` with a reason.
- A final bank reject is never retried to the same account; the IDR stays in `client_idr_payable`.

**Verified by tests (real restate-server):** with FAIL_RATE 0.3, FAIL_AFTER 0.1 and timeouts on both
mocks, plus 30% duplicate / 10% dropped callbacks and 20 duplicate dispatches, 100/100 deposits
complete; there are exactly 100 swaps and 100 transfers, `count(payouts) = count(completed)`, and the ledger is
balanced. Killing the workflow service during `confirm-swap` resumes without re-locking the quote
and without a second swap.

## ADR-015 — API surface and security
- Client keys are `mpk_<8-hex prefix>_<secret>`, stored as sha256(salt‖key) and looked up by prefix,
  then compared in constant time. The plaintext key is shown once at seed time (`data/seed-clients.json`, gitignored).
- A token-bucket rate limit runs per key, in-process. In production this moves to the gateway or Redis, since a per-replica
  limit multiplies with the replica count.
- Clients only ever see their own deposits (404, not 403, for other clients' ids), and internal
  details (ledger, audit) are not exposed on `/v1`.
- The webhook verifies HMAC over the **raw body**, dedups on `transferId:status`, and never mutates
  payouts itself. It only wakes the workflow, which owns all state transitions. Invalid
  signatures are recorded (`signature_valid=false`) for forensics.
- `/v1/stream` (SSE) and `/admin/*` require `ADMIN_TOKEN`. The dashboard reaches them only through
  Next.js server-side route handlers, so the token never reaches the browser.
- Admin re-drive refuses deposits flagged as reorg incidents; these need human resolution.
