# Road to production (99.999 %)

99.999 % is ~5 minutes of unavailability per year. That is only achievable when **no single process,
machine or provider is on the critical path**, and when every failure mode resolves into "retry
later" instead of "lose or double money". The prototype already has the second property; this page
lists what the first one requires.

## What the prototype already does

| Property                  | How                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Crash-safe at every point | Restate journal for the workflow; single-transaction writes plus a checkpoint in the indexer; outbox for the hand-over    |
| Idempotent everywhere     | deterministic workflow ids, `wf:swap` / `wf:payout` keys, UNIQUE constraints, journal PKs, webhook dedup                  |
| Stateless services        | workflow, api and indexer-backfill hold no local state; they can be killed and replaced at any time                       |
| RPC failover              | viem `fallback()` over two providers, retries with backoff, adaptive range splitting                                      |
| Leader election           | Postgres advisory lock for the indexer live path; optimistic concurrency on the checkpoint                                |
| Defense in depth          | invariants enforced in the DB (ledger balance, append-only, state machine); RPC re-check at promotion; final-range sweeps |
| Degrade safely            | a stale price (> 60 s) refuses quotes; bank rejects and anomalies stop in `manual_review` instead of guessing             |

## Infrastructure

1. **Restate cluster**: ≥ 3 nodes with a replicated log (Restate's distributed deployment / Restate
   Cloud), spread across availability zones. Workflow services run as ≥ 2 replicas behind it
   (Kubernetes Deployment, HPA on in-flight invocations). Rolling deploys use Restate's deployment
   versioning, so in-flight invocations finish on the version they started on.
2. **Postgres HA**: a primary plus a synchronous replica in another AZ (Patroni, Cloud SQL HA, or Aurora),
   PgBouncer in front, PITR backups, and regular restore drills. The ledger is the system of record,
   so `synchronous_commit = on`.
3. **≥ 2 replicas of every stateless service** (api, workflow, indexer) across AZs, with readiness
   probes (`/readyz`) wired to the load balancer.
4. **Indexer**: 2 replicas; the advisory lock elects the live leader and both run backfill. Consider
   moving leadership to a Kubernetes Lease for faster failover, but keep the checkpoint's optimistic
   concurrency as the safety net.
5. **Multiple RPC providers** (≥ 3: e.g. Alchemy, QuickNode, a self-hosted `op-node`/`op-geth`), ranked by
   latency, with per-provider rate limiting and circuit breakers. Cross-check `finalized` between
   two providers before promoting.
6. **Finality on mainnet**: the `finalized` tag (L1 finalized, ~15–20 min) and distance 300, or
   per-client risk tiers (e.g. instant credit up to a limit at `safe`, larger amounts at `finalized`).

## Security

- **Secrets** in KMS/Vault (exchange API secret, webhook HMAC secret, DB credentials), injected at
  runtime and rotated. **No hot wallet keys** exist in Mopay's path; the demo wallets are testnet-only.
- **API keys**: argon2id instead of salted SHA-256, scoped keys, an IP allowlist per B2B client, and mTLS
  for the PJP callback endpoint where the PJP supports it.
- **Rate limiting** at the gateway (shared store), not per replica.
- **Audit log** shipped to append-only storage (WORM bucket) for OJK/BI examinations.
- **Four-eyes** on admin actions (manual-review re-drive, chaos is disabled in production).

## Observability

- **OpenTelemetry** traces: the deposit id is the correlation id end to end (indexer → Restate →
  workflow → upstream HTTP), plus pino JSON logs shipped to Loki/Elastic.
- Prometheus metrics already exposed by the indexer. Add workflow step latency and retry counters, and
  upstream error rates per endpoint.
- **Alerts**: `indexer_head_lag_blocks` > threshold, `indexer_reorg_incidents_total` > 0 (page),
  `step_retry_alert` audit rows, outbox age > 5 min, price staleness, `manual_review` count > 0,
  and invariants failing (run `scripts/invariants.ts` continuously as a canary).

## Reconciliation

- **Daily, automated**: Mopay ledger vs the exchange's statement (deposits credited, orders, fees)
  and vs the PJP/bank statement (BI-FAST transfers, returns). Every mismatch becomes a ticket; nothing is
  auto-corrected.
- **Intraday**: poll `GET /v1/transfers/:id` for every payout still pending after N minutes (the
  workflow already does this per payout); scan for exchange orders without a matching Mopay swap journal.
- **On-chain**: the sweep job doubles as a reconciliation that deposits on chain equal deposits in the DB.

## Real adapters

The workflow talks to `MobeeClient` / `BifastClient` (`packages/shared/src/clients`). Production replaces them with
adapters behind the same interface:

- `MobeeAdapter`: the real Mobee Open API (same HMAC scheme), using sub-accounts per client.
- `IndodaxAdapter`: an alternative PAKD (private API with its own signing); an exchange router can pick
  the best executable price across PAKDs per quote.
- `PjpAdapter`: the PJP's BI-FAST disbursement API (account inquiry, transfer, status, signed
  callbacks), plus handling for BI-FAST return codes and cut-off/maintenance windows.

Each adapter must map upstream errors to `retryable` vs `terminal` (`classifyHttp` / `UpstreamError`).
That classification decides between "retry forever" and "stop and ask a human".

## Operational runbooks (to write)

`manual_review` triage, reorg incident, RPC provider outage, exchange outage (quotes refused),
PJP outage (payouts pending), Restate node loss, Postgres failover, key rotation.
