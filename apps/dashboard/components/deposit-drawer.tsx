'use client';
import { useEffect } from 'react';
import clsx from 'clsx';
import {
  AlertTriangle,
  ArrowDown,
  Check,
  CircleDashed,
  ExternalLink,
  Loader2,
  RotateCcw,
  X,
  XCircle,
} from 'lucide-react';
import { useDeposit, useRetryDeposit } from '@/lib/api';
import { ago, duration, fromBase, idr, num, rate, short, time, usdt } from '@/lib/format';
import type { DepositDetail, TimelineStep } from '@/lib/types';
import { Button, CopyText, ErrorNote, Pill, Skeleton, StatusBadge } from './ui';

const STEP_LABEL: Record<string, { title: string; desc: string }> = {
  'load-deposit': {
    title: 'Load & validate',
    desc: 'Client active, amount ≥ minimum, verified bank account',
  },
  'record-received': { title: 'Record receipt', desc: 'Ledger: USDT owed to client, held at exchange' },
  'wait-exchange-credit': {
    title: 'Exchange credit',
    desc: 'Wait until the PAKD credits the deposit (durable sleep)',
  },
  'lock-quote': { title: 'Lock quote', desc: 'VWAP on the live Indodax bid book, 30 s TTL' },
  'confirm-swap': { title: 'Execute swap', desc: 'Idempotency-Key = workflow id + :swap' },
  'record-swap': { title: 'Record swap', desc: 'Ledger: USDT → IDR, 0.35% fee (rounded up)' },
  'account-inquiry': { title: 'Account inquiry', desc: 'BI-FAST name check against our records' },
  'create-payout': { title: 'Create payout', desc: 'Payout row + awakeable stored before the transfer' },
  'await-payout-result': {
    title: 'Await bank result',
    desc: 'Signed callback, or reconciliation after timeout',
  },
  finalize: { title: 'Finalize', desc: 'Ledger: payable → bank out; deposit completed' },
};

function StepIcon({ s }: { s: TimelineStep }) {
  const base = 'relative z-10 grid size-6 shrink-0 place-items-center rounded-full border-2';
  if (s.state === 'done')
    return (
      <span className={clsx(base, 'border-good bg-good text-white')}>
        <Check className="size-3.5" strokeWidth={3} aria-hidden />
      </span>
    );
  if (s.state === 'failed')
    return (
      <span className={clsx(base, 'border-critical bg-critical text-white')}>
        <XCircle className="size-3.5" aria-hidden />
      </span>
    );
  if (s.state === 'running')
    return (
      <span
        className={clsx(
          base,
          s.retries
            ? 'border-serious bg-serious-soft text-serious-ink'
            : 'border-accent bg-accent-soft text-accent-ink',
        )}
      >
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
      </span>
    );
  return (
    <span className={clsx(base, 'border-border-strong bg-surface text-muted')}>
      <CircleDashed className="size-3" aria-hidden />
    </span>
  );
}

function Timeline({ steps }: { steps: TimelineStep[] }) {
  return (
    <ol className="relative">
      {steps.map((s, i) => {
        const meta = STEP_LABEL[s.step] ?? { title: s.step, desc: '' };
        return (
          <li key={s.step} className="relative flex gap-3 pb-4 last:pb-0">
            {i < steps.length - 1 && (
              <span
                className={clsx(
                  'absolute left-[11px] top-6 h-[calc(100%-24px)] w-0.5',
                  s.state === 'done' ? 'bg-good/50' : 'bg-border',
                )}
                aria-hidden
              />
            )}
            <StepIcon s={s} />
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span
                  className={clsx(
                    'text-[12.5px] font-medium',
                    s.state === 'pending' ? 'text-muted' : 'text-ink',
                  )}
                >
                  {meta.title}
                </span>
                <span className="font-mono text-[10.5px] text-muted">{s.step}</span>
                {s.state === 'running' && s.retries > 0 && (
                  <Pill tone="serious">retrying · {s.retries} failed so far</Pill>
                )}
                {s.retries > 0 && s.state === 'done' && (
                  <Pill tone="good">
                    recovered after {s.retries} retr{s.retries > 1 ? 'ies' : 'y'}
                  </Pill>
                )}
                {s.finishedAt && s.startedAt && (
                  <span className="tnum ml-auto text-[11px] text-muted">
                    {duration(s.startedAt, s.finishedAt)}
                  </span>
                )}
              </div>
              <div className="text-[11.5px] text-muted">{meta.desc}</div>
              {s.lastError && (s.state !== 'done' || s.retries > 0) && (
                <div
                  className={clsx(
                    'mt-1.5 rounded-md px-2 py-1 font-mono text-[10.5px] leading-relaxed',
                    s.state === 'failed' ? 'bg-critical-soft text-critical-ink' : 'bg-surface-2 text-ink-2',
                  )}
                >
                  {s.state === 'done' ? 'last error: ' : ''}
                  {s.lastError}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Money({ d }: { d: DepositDetail }) {
  const o = d.offramp;
  const rows: [string, string, string?][] = [
    ['Received', `${usdt(d.amount)} ${d.token}`],
    [
      'Rate (VWAP, Indodax bid)',
      o?.rate ? `Rp ${rate(o.rate)}` : '—',
      o?.priceAsOf ? `price as of ${time(o.priceAsOf)}` : undefined,
    ],
    ['Gross', idr(o?.grossIdr)],
    ['Mopay fee 0.35%', o?.feeIdr ? `− ${idr(o.feeIdr)}` : '—'],
  ];
  return (
    <div className="rounded-xl border border-border bg-surface-2/40 p-3.5">
      <dl className="space-y-1.5 text-[12.5px]">
        {rows.map(([k, v, sub]) => (
          <div key={k} className="flex items-baseline justify-between gap-4">
            <dt className="text-muted">{k}</dt>
            <dd className="tnum text-right">
              {v}
              {sub && <div className="text-[10.5px] text-muted">{sub}</div>}
            </dd>
          </div>
        ))}
      </dl>
      <div className="my-2.5 flex items-center gap-2 text-muted">
        <span className="h-px flex-1 bg-border" />
        <ArrowDown className="size-3.5" aria-hidden />
        <span className="h-px flex-1 bg-border" />
      </div>
      <div className="flex items-baseline justify-between">
        <span className="text-[12.5px] font-medium">Client receives</span>
        <span className="tnum text-[20px] font-semibold tracking-[-0.02em]">{idr(o?.idrAmount)}</span>
      </div>
      {o?.quoteAttempts && o.quoteAttempts > 1 ? (
        <div className="mt-1 text-[11px] text-serious-ink">re-quoted {o.quoteAttempts}× (quote expired)</div>
      ) : null}
    </div>
  );
}

export function DepositDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { data: d, error, isLoading } = useDeposit(id);
  const retry = useRetryDeposit();
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  if (!id) return null;
  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label="Deposit detail">
      <div className="absolute inset-0 bg-black/25 backdrop-blur-[1px]" onClick={onClose} />
      <aside className="absolute inset-y-0 right-0 flex w-full max-w-[560px] flex-col border-l border-border bg-surface shadow-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {d && <StatusBadge status={d.status} />}
              {d && <Pill>{d.source === 'backfill' ? 'found by backfill' : 'found live'}</Pill>}
            </div>
            <div className="mt-2 text-[17px] font-semibold tracking-[-0.01em]">
              {d ? `${usdt(d.amount)} ${d.token}` : '…'}
            </div>
            <div className="text-[12px] text-muted">{d?.clientName}</div>
          </div>
          <button
            onClick={onClose}
            className="grid size-8 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </header>
        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {isLoading && <Skeleton className="h-64" />}
          <ErrorNote error={error} />
          {d && (
            <>
              {d.statusReason && (
                <div
                  className={clsx(
                    'flex gap-2 rounded-lg border px-3 py-2 text-[12.5px]',
                    d.status === 'manual_review'
                      ? 'border-warning/40 bg-warning-soft text-warning-ink'
                      : d.status === 'orphaned'
                        ? 'border-serious/40 bg-serious-soft text-serious-ink'
                        : 'border-border bg-surface-2 text-ink-2',
                  )}
                >
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  <div className="min-w-0 flex-1 break-words">{d.statusReason}</div>
                </div>
              )}
              {d.status === 'manual_review' && !(d.statusReason ?? '').startsWith('INCIDENT') && (
                <div className="flex items-center gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={retry.isPending}
                    onClick={() => retry.mutate(d.id)}
                  >
                    <RotateCcw className="size-3.5" aria-hidden /> Re-drive workflow
                  </Button>
                  <span className="text-[11.5px] text-muted">
                    Reuses the same swap/payout idempotency keys — cannot pay twice.
                  </span>
                </div>
              )}
              <ErrorNote error={retry.error} />
              {d.status === 'orphaned' && (
                <div className="rounded-lg border border-border bg-surface-2/50 px-3 py-2 text-[12px] text-ink-2">
                  The block containing this transfer was replaced by a reorg before it became final. It was
                  never confirmed, dispatched, swapped or paid out.
                </div>
              )}

              {d.offramp && <Money d={d} />}

              <section>
                <h3 className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-muted">
                  Workflow timeline
                </h3>
                {d.offramp ? (
                  <Timeline steps={d.timeline} />
                ) : (
                  <div className="rounded-lg bg-surface-2/50 px-3 py-3 text-[12px] text-muted">
                    {d.status === 'seen' &&
                      `Waiting for finality (${num(d.confirmations)} confirmations so far). The workflow starts after the block is below the safe boundary.`}
                    {d.status === 'confirmed' &&
                      'Final. Queued in the outbox; the dispatcher is starting the workflow.'}
                    {d.status === 'orphaned' && 'No workflow — reorged deposits are never dispatched.'}
                    {d.status === 'dispatched' && 'Workflow accepted by Restate; first step starting…'}
                  </div>
                )}
              </section>

              {d.payout && (
                <section>
                  <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted">
                    BI-FAST payout
                  </h3>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12.5px]">
                    <dt className="text-muted">Status</dt>
                    <dd>
                      <Pill
                        tone={
                          d.payout.status === 'success'
                            ? 'good'
                            : d.payout.status === 'failed'
                              ? 'critical'
                              : 'accent'
                        }
                      >
                        {d.payout.status}
                      </Pill>
                      {d.payout.failureReason && (
                        <span className="ml-2 text-critical-ink">{d.payout.failureReason}</span>
                      )}
                    </dd>
                    <dt className="text-muted">Amount</dt>
                    <dd className="tnum">{idr(d.payout.amountIdr)}</dd>
                    <dt className="text-muted">Transfer</dt>
                    <dd>
                      {d.payout.bifastRef ? (
                        <CopyText value={d.payout.bifastRef} label={short(d.payout.bifastRef, 12, 6)} />
                      ) : (
                        '—'
                      )}
                    </dd>
                    <dt className="text-muted">Idempotency key</dt>
                    <dd className="min-w-0">
                      <CopyText
                        value={d.payout.idempotencyKey}
                        label={short(d.payout.idempotencyKey, 14, 12)}
                      />
                    </dd>
                  </dl>
                </section>
              )}

              <section>
                <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted">
                  On-chain
                </h3>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12.5px]">
                  <dt className="text-muted">Tx</dt>
                  <dd className="flex min-w-0 items-center gap-2">
                    <CopyText value={d.txHash} label={short(d.txHash, 12, 8)} />
                    {d.explorerUrl && (
                      <a
                        href={d.explorerUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-0.5 text-[11.5px] text-accent-ink hover:underline"
                      >
                        Basescan <ExternalLink className="size-3" aria-hidden />
                      </a>
                    )}
                  </dd>
                  <dt className="text-muted">Block · log</dt>
                  <dd className="tnum">
                    {num(d.blockNumber)} · #{d.logIndex}
                  </dd>
                  <dt className="text-muted">From → to</dt>
                  <dd className="font-mono text-[11.5px] text-ink-2">
                    {short(d.from)} → {short(d.to)}
                  </dd>
                  <dt className="text-muted">Workflow id</dt>
                  <dd className="min-w-0">
                    <CopyText value={d.workflowId} label={short(d.workflowId, 16, 6)} />
                  </dd>
                  <dt className="text-muted">Seen · confirmed</dt>
                  <dd className="tnum text-ink-2">
                    {time(d.firstSeenAt)} · {time(d.confirmedAt)}{' '}
                    <span className="text-muted">
                      ({duration(d.firstSeenAt, d.confirmedAt) || 'pending'})
                    </span>
                  </dd>
                  {d.completedAt && (
                    <>
                      <dt className="text-muted">End to end</dt>
                      <dd className="tnum font-medium">{duration(d.firstSeenAt, d.completedAt)}</dd>
                    </>
                  )}
                </dl>
              </section>

              {d.ledger.length > 0 && (
                <section>
                  <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted">
                    Ledger (double-entry)
                  </h3>
                  <div className="overflow-hidden rounded-lg border border-border">
                    <table className="w-full text-[11.5px]">
                      <thead className="bg-surface-2/60 text-muted">
                        <tr>
                          <th className="px-2.5 py-1.5 text-left font-medium">Journal</th>
                          <th className="px-2.5 py-1.5 text-left font-medium">Account</th>
                          <th className="px-2.5 py-1.5 text-right font-medium">Debit</th>
                          <th className="px-2.5 py-1.5 text-right font-medium">Credit</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {d.ledger.map((l) => {
                          const fmt = (v: string) =>
                            v === '0' ? '' : l.currency === 'IDR' ? idr(v, false) : fromBase(v);
                          return (
                            <tr key={l.id}>
                              <td className="px-2.5 py-1.5 text-muted">{l.journalId.split(':').pop()}</td>
                              <td className="px-2.5 py-1.5 font-mono">{l.account}</td>
                              <td className="tnum px-2.5 py-1.5 text-right">
                                {fmt(l.debit)}
                                {l.debit !== '0' && <span className="ml-1 text-muted">{l.currency}</span>}
                              </td>
                              <td className="tnum px-2.5 py-1.5 text-right">
                                {fmt(l.credit)}
                                {l.credit !== '0' && <span className="ml-1 text-muted">{l.currency}</span>}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}
              <div className="text-[11px] text-muted">First seen {ago(d.firstSeenAt)}</div>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
