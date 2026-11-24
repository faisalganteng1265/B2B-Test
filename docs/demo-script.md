# Demo script (video, ~8 minutes)

**Setup before recording:** `make up`. Open four windows: the dashboard (http://localhost:3000), the
Restate UI (http://localhost:9070), a terminal, and Basescan (https://sepolia.basescan.org). In the
dashboard, Chaos lab → **Calm**.

---

## 1. Architecture (30 s)

Show `docs/architecture.md` (component diagram).

> "Mopay only orchestrates. USDT is held and sold by a licensed exchange (PAKD), and rupiah goes out via
> BI-FAST through a PJP. Here both are mocks, but the chain is real (Base Sepolia) and the USDT/IDR
> price is real, from Indodax's public order book. Three parts: an indexer that detects deposits
> reorg-safely, a Restate workflow that makes every step durable, and an API + dashboard."

## 2. Happy path (1 min)

Overview: point at the **live Indodax** price card (bid/ask, VWAP for 10k USDT, "fresh").

Clients → **Send 250 mUSDT test deposit** → click the tx hash → it shows on Basescan.

Deposits: the row appears as **Seen** within ~1 s.

> "It's in a block, but not final yet. We wait for Base's `safe` boundary (~2 min). Until then
> nothing irreversible happens."

When it turns **Processing**, open the row and watch the timeline fill in: exchange credit → lock quote
(rate from the real order book) → swap → ledger → name inquiry → BI-FAST transfer → callback →
**Completed**. Show the money box (rate, gross, 0.35 % fee rounded up, net) and the balanced ledger lines.

## 3. Chaos: every step retries until it succeeds (1.5 min)

Chaos lab → **Storm (50%)** (or `make demo-chaos`). Then **Send 20**.

- Restate UI → Invocations: show invocations with retry counts and backoff.
- Dashboard → open a deposit: steps show "recovered after N retries" with the real injected
  errors (`500 CHAOS_INJECTED`, lost responses, duplicate callbacks).

> "Each external call runs inside `ctx.run`: its result is journaled, retryable errors are retried with
> backoff forever, and idempotency keys (`workflowId:swap`, `workflowId:payout`) make a retry after
> a lost response safe."

All 20 end **Completed**. Chaos lab → **Calm**.

## 4. Kill the workflow service mid-swap (1 min)

Chaos lab: set _Max latency_ on the exchange to ~3 s so a swap takes a while. Send 1 deposit and open it.
When the timeline reaches **Execute swap**:

```bash
make kill-workflow        # SIGKILL — no graceful shutdown
# a few seconds later
make restart-workflow
```

> "Restate notices the dead connection and re-invokes. The quote lock is in the journal, so it is not
> repeated; the swap is re-sent with the same idempotency key, and the exchange returns the original
> order instead of swapping twice."

Then run `make invariants` → _Exchange: exactly one swap per swapped deposit_ ✔.
(The same scenario is an automated test: `apps/workflow/test/offramp.int.test.ts`.)

## 5. Indexer outage + catch-up (1.5 min)

```bash
WAIT=300 make demo-catchup     # stop indexer → 50 real deposits → 5 min down (~1,500 blocks) → restart
```

> "While the indexer is down, the chain keeps going. On restart the live worker **jumps straight to
> the finalized boundary** and follows the head again; the gap is cut into chunks that 4 workers
> claim with `SKIP LOCKED`."

Overview: **Lag** drops to ~0 within seconds; **Backfill** climbs to 100 %. The new deposit sent during
catch-up is detected in ~1 s. Deposits page: missed deposits are marked _via backfill_.

For the spec's exact scenario (indexer down, 50 deposits, 5,000 blocks), run it on the simulated chain:
`make demo-catchup-sim` (finishes in ~2 s).

## 6. Reorg (1 min)

```bash
make demo-reorg
```

Base Sepolia can't be reorged on demand, so this runs the same indexer against a simulated chain:

1. A and B deposit, and both are **seen**.
2. The last 4 blocks are replaced by a competing branch, the parent-hash mismatch is detected, the indexer walks
   back to the common ancestor and rolls back in one DB transaction, and both deposits become **orphaned**.
3. 30 more blocks are mined, and the deposits stay orphaned with **0 workflows dispatched**.
4. Bonus: a tx re-included on the new branch is processed exactly once after it becomes final.

> "And even if application code had a bug, a database trigger forbids `orphaned → confirmed`."

## 7. Invariants (30 s)

```bash
make invariants
```

The ledger balances, there is at most one payout per deposit, payouts = completed, orphaned deposits were never touched,
exactly one exchange order per swapped deposit, one BI-FAST transfer per key, and no reorg incidents. **All green.**

## 8. (Optional) Basescan

Open any deposit's tx on Basescan from the drawer: the same `Transfer` event the indexer saw.
