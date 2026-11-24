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
