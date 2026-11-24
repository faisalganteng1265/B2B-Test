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
