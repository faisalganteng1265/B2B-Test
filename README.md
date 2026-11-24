# Mopay B2B Offramp — prototype

USDT on **Base Sepolia** → sold for IDR at a licensed exchange (PAKD) → rupiah to the client's bank
account via **BI-FAST** (PJP). Mopay only orchestrates and never holds funds.

|                  | In this prototype                                                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chain + USDT     | **real**: Base Sepolia, `MockUSDT` (6 decimals) at [`0xd3dD…F7C0`](https://sepolia.basescan.org/address/0xd3dD2744A70188e5fdD17F302d1003E37E2dF7C0) |
| USDT/IDR price   | **real**: Indodax public ticker + order book (VWAP on the bid side)                                                                                 |
| Exchange (Mobee) | mock: `apps/mobee-mock` (HMAC auth, quick-swap lock/confirm, idempotent)                                                                            |
| BI-FAST (PJP)    | mock: `apps/bifast-mock` (async signed callbacks, duplicates, drops)                                                                                |

Built for the four reviewer requirements: **durable auto-retried steps** (Restate), a **fast
reorg-safe indexer that catches up while staying live**, a **design that supports 99.999 %**, and **no double payout,
no reorged deposit ever processed**.

## Quickstart

Prerequisites: Node ≥ 22, pnpm 12, a local Postgres on `localhost:5432` (user `postgres`, trust/peer
auth), Foundry (only to redeploy contracts). Docker is optional (`docker compose up` is also provided).

```bash
pnpm install && make deps          # JS deps + Foundry libs
cp .env.example .env               # fill DEPLOYER/CLIENT keys (Base Sepolia); see below
make up                            # migrate, Restate, mocks, workflow (+register), seed, indexer, api, dashboard
open http://localhost:3000         # dashboard (opens on the live Overview)
make send-deposit CLIENT=A AMOUNT=1000
```

`make deploy` (already done: `deployments/84532.json`) deploys `MockUSDT`/`MockUSDC`, mints 10M to
each client wallet, and tops the wallets up with gas from the deployer. The seed writes the client API
keys (shown once) to `data/seed-clients.json`.

| URL                           |                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| http://localhost:3000         | Ops dashboard (Overview, Deposits + workflow timeline, Clients, Ledger, Chaos lab) |
| http://localhost:4000/docs    | B2B API (OpenAPI / Swagger)                                                        |
| http://localhost:9070         | Restate UI (invocations, retries, journals)                                        |
| http://localhost:4300/metrics | Indexer Prometheus metrics (`/readyz`, `/status`)                                  |

## Architecture

```
Base Sepolia ──logs/headers──▶ indexer ──outbox──▶ Restate ──▶ offramp workflow ──▶ mobee-mock (swap, real Indodax price)
                                 │                    ▲                 └──────────▶ bifast-mock ──callback──▶ api ─┘
                                 └──────── Postgres (deposits, ledger, checkpoints, audit) ◀── api (SSE) ◀── dashboard
```

- **Indexer** (`apps/indexer`): a batched live path near the head with parent-hash reorg detection, a parallel
  backfill below finality (`SKIP LOCKED` + leases, adaptive range splitting), a promoter that re-checks the
  block hash against the RPC, a transactional outbox to Restate, final-range sweeps, and an advisory-lock leader.
- **Workflow** (`apps/workflow`): a Restate workflow with 10 journaled steps; retryable errors retry forever, and terminal
  errors go to `manual_review`. The bank result arrives via an awakeable + timeout + reconciliation.
- **API** (`apps/api`): Hono; B2B endpoints (API keys, rate limit), the HMAC-verified BI-FAST webhook, SSE via
  Postgres `LISTEN/NOTIFY`, and admin (chaos, re-drive, demo deposits).
- **Dashboard** (`apps/dashboard`): Next.js + TanStack Query + Tailwind, live over SSE; the admin token
  stays server-side.

More detail: [architecture](docs/architecture.md) · [indexer](docs/indexer.md) ·
[decisions (ADRs)](docs/decisions.md) · [production](docs/production.md) · [demo script](docs/demo-script.md)

## Demos

| Command                                        | Shows                                                                                                    |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `make demo-chaos`                              | 50 % failures, lost responses, duplicate/dropped callbacks → every deposit still completes once          |
| `make kill-workflow` / `make restart-workflow` | crash mid-swap → resumes from the journal, no second swap                                                |
| `make demo-catchup`                            | **real chain**: indexer down for `WAIT` s while 50 deposits land → restart → backfill + live in parallel |
| `make demo-catchup-sim`                        | simulated chain: 50 deposits + 5,000 blocks while down → all processed once in ~2 s                      |
| `make demo-reorg`                              | simulated chain: a reorged deposit becomes `orphaned` and is never dispatched                            |
| `make invariants`                              | 11 invariants: ledger balanced, ≤ 1 payout/swap per deposit, payouts = completed, …                      |
| `make e2e`                                     | chaos on → 100 real deposits → all complete → invariants                                                 |

## Tests

```bash
make test            # forge test + every package's vitest suite (needs local Postgres; starts its own restate-server)
```

| Suite                                 | Highlights                                                                                                                                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contracts` (forge)                   | decimals, owner-only mint, `Transfer` event, fuzz                                                                                                                                                                         |
| `packages/shared`                     | integer money math (round in Mopay's favour), VWAP, HMAC, error classification                                                                                                                                            |
| `packages/db`                         | ledger balance trigger, append-only ledger, deposit state-machine guard, idempotent journals                                                                                                                              |
| `apps/mobee-mock`, `apps/bifast-mock` | HMAC valid/invalid/stale, idempotent confirm/transfer, quote expiry, lost responses, duplicate/dropped/late callbacks, PriceFeed staleness                                                                                |
| `apps/indexer` (simulated chain)      | < 3 s detection; 50 deposits + 5,000 blocks catch-up while live; reorg → orphaned; re-inclusion; deep-reorg incident; worker crash; flaky RPC; sweeps                                                                     |
| `apps/workflow` (real restate-server) | **100 deposits under FAIL_RATE 0.3** (+ lost responses, timeouts, duplicate/dropped callbacks, duplicate dispatch) → all complete exactly once; kill mid-swap; quote expiry; bank reject; name mismatch; webhook security |
| `apps/api`                            | auth, rate limit, tenant isolation, quote math, webhook, admin re-drive, SSE                                                                                                                                              |

## Verified results (Nov 2026, this machine, real Base Sepolia)

| Scenario                                                                                                   | Result                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Detection latency (live path)                                                                              | deposit `seen` **0.8 s** after its receipt; `confirmed` at the `safe` boundary ~105–155 s later                                                         |
| `make e2e` — 100 real deposits, FAIL_RATE 0.3 on both mocks + lost responses + duplicate/dropped callbacks | **100/100 completed** in 344 s; invariants green                                                                                                        |
| `make demo-catchup` — indexer down 5 min while 50 real deposits land                                       | live jumped to the boundary, 6 backfill chunks done, lag 362 → 23 blocks, the deposit sent during catch-up was picked up live; 50/50 found via backfill |
| Bug found by that demo                                                                                     | outbox/workflow race (1/50) → fixed + regression tests (ADR-016); the affected deposit was recovered with the admin re-drive; no double swap/payout     |
| `make invariants` after all of the above                                                                   | 11/11 hold over 159 completed deposits: 159 swaps, 159 transfers, 159 payouts, ledger balanced                                                          |
| Test suites                                                                                                | 5 forge + 82 vitest, all green                                                                                                                          |

## Environment notes

- **Chain**: Base only (no Anvil), as requested. Reorg/mining-dependent tests run on `SimChain`, an
  in-process chain that implements the same interface as the viem source (ADR-001).
- **No Docker on the dev machine**: `make up` runs everything natively (`scripts/stack.sh`).
  `docker-compose.yml` is provided but was not exercised here (ADR-002).
- Base Sepolia runs at ~5 blocks/s; the `safe` tag trails by ~2 min, so a deposit is **seen in ~1 s** and
  **paid ~2 min later** (ADR-008).

## Known limitations

- Exchange and bank are mocks; only the price and the chain are real. Swaps settle against mock balances.
- Admin re-drive after a _final_ bank reject reuses the same payout key, so it ends in the same
  rejection. Paying to a corrected account needs a new payout flow (not built).
- Rate limiting is in-process (per replica); webhooks have no mTLS; API keys use salted SHA-256
  (argon2id recommended; see production.md).
- The reorg demo uses the simulated chain; on Base Sepolia reorgs below `safe` would need an L1 reorg.
- Restate runs as a single node locally; production needs a replicated cluster.
