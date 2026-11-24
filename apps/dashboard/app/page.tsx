'use client';
import Link from 'next/link';
import clsx from 'clsx';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Blocks,
  CheckCircle2,
  DatabaseBackup,
  GitBranchPlus,
  Layers,
  Radio,
  ShieldCheck,
  Siren,
  Wallet,
} from 'lucide-react';
import { useDeposits, useOverview } from '@/lib/api';
import { useLive } from '@/lib/live';
import { ago, idr, idrCompact, num, rate, short, time, usdt } from '@/lib/format';
import { Card, ErrorNote, Pill, Skeleton, Stat, StatusBadge } from '@/components/ui';
import { Meter, PriceSparkline, StatusDistribution } from '@/components/charts';

const BLOCK_SECONDS = 0.2; // Base: ~5 blocks/s (measured)

export default function OverviewPage() {
  const { data: o, error, isLoading } = useOverview();
  const { priceHistory } = useLive();
  const deposits = useDeposits();

  if (isLoading) return <OverviewSkeleton />;
  if (!o) return <ErrorNote error={error ?? 'API unreachable'} />;

  const p = o.price;
  const spread = p ? Number(p.ask) - Number(p.bid) : null;
  const idx = o.indexer;
  const lagTone =
    idx.lag === null ? 'default' : idx.lag > 300 ? 'critical' : idx.lag > 60 ? 'warning' : 'good';
  const total = Object.values(o.deposits).reduce((a, n) => a + (n ?? 0), 0);
  const inFlight = (o.deposits.seen ?? 0) + (o.deposits.confirmed ?? 0) + (o.deposits.dispatched ?? 0);
  const incidents = o.alerts.manualReview.filter((a) => a.incident);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold tracking-[-0.02em]">Overview</h1>
          <p className="mt-1 text-[13px] text-muted">
            USDT on {o.chain.name} → swap at a licensed exchange → rupiah via BI-FAST. Updated {time(o.at)}.
          </p>
        </div>
        {incidents.length > 0 && (
          <div className="flex items-center gap-2 rounded-lg border border-critical/30 bg-critical-soft px-3 py-2 text-[12.5px] font-medium text-critical-ink">
            <Siren className="size-4" aria-hidden /> {incidents.length} reorg incident
            {incidents.length > 1 ? 's' : ''} need attention
          </div>
        )}
      </div>

      {/* Row 1: price + money */}
      <div className="grid gap-4 xl:grid-cols-3">
        <Card
          className="xl:col-span-2"
          title={
            <span className="flex items-center gap-2">
              USDT / IDR
              <Pill tone="accent">Indodax · live</Pill>
            </span>
          }
          action={
            p ? (
              <span className="flex items-center gap-2 text-[11.5px] text-muted">
                as of {time(p.asOf)}
                {p.stale ? (
                  <Pill tone="warning">
                    <AlertTriangle className="size-3" aria-hidden />
                    stale feed
                  </Pill>
                ) : (
                  <Pill tone="good">
                    <Radio className="size-3" aria-hidden />
                    fresh
                  </Pill>
                )}
              </span>
            ) : null
          }
        >
          {p ? (
            <div className="grid gap-5 md:grid-cols-[minmax(0,240px)_1fr]">
              <div className="space-y-4">
                <div>
                  <div className="text-[12px] text-muted">Best bid (we sell USDT here)</div>
                  <div className="tnum mt-1 text-[34px] font-semibold leading-none tracking-[-0.03em]">
                    <span className="mr-1 text-[18px] font-medium text-muted">Rp</span>
                    {rate(p.bid)}
                  </div>
                </div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-[12px]">
                  <div>
                    <dt className="text-muted">Ask</dt>
                    <dd className="tnum font-medium">{rate(p.ask)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted">Spread</dt>
                    <dd className="tnum font-medium">
                      {spread !== null ? `Rp ${rate(String(spread))}` : '—'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted">Last trade</dt>
                    <dd className="tnum font-medium">{rate(p.last)}</dd>
                  </div>
                  <div>
                    <dt
                      className="text-muted"
                      title="Volume-weighted price for selling 10,000 USDT into the bid book"
                    >
                      VWAP 10k USDT
                    </dt>
                    <dd className="tnum font-medium">
                      {p.vwap ? rate(p.vwap.rate) : '—'}
                      {p.vwap && <span className="ml-1 text-muted">· {p.vwap.slippageBps} bps</span>}
                    </dd>
                  </div>
                </dl>
              </div>
              <div className="min-w-0">
                <div className="mb-2 text-[12px] text-muted">Bid, this session</div>
                <PriceSparkline points={priceHistory} />
              </div>
            </div>
          ) : (
            <div className="py-8 text-center text-[13px] text-muted">
              Price feed unavailable — quotes are refused (PRICE_UNAVAILABLE) until it recovers.
            </div>
          )}
        </Card>

        <div className="grid gap-4">
          <Stat
            icon={Wallet}
            label="Rupiah paid out today"
            value={idrCompact(o.payoutsToday.idr)}
            sub={
              <>
                {num(o.payoutsToday.count)} BI-FAST transfers ·{' '}
                <span className="tnum">{idr(o.payoutsToday.idr)}</span>
              </>
            }
            tone="good"
          />
          <Card
            title="Deposit pipeline"
            action={
              <span className="tnum text-[12px] text-muted">
                {num(total)} total · {num(inFlight)} in flight
              </span>
            }
          >
            <StatusDistribution counts={o.deposits} />
          </Card>
        </div>
      </div>

      {/* Row 2: indexer */}
      <div>
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-[13px] font-semibold">Indexer</h2>
          <span className="text-[12px] text-muted">
            live path near head · parallel backfill below finality · parent-hash reorg detection
          </span>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Stat
            icon={Blocks}
            label="Chain head"
            value={num(idx.chainHead)}
            sub={idx.updatedAt ? `checkpoint ${ago(idx.updatedAt)}` : undefined}
          />
          <Stat icon={Activity} label="Live head" value={num(idx.liveHead)} sub="last processed block" />
          <Stat
            icon={Layers}
            label="Lag"
            value={idx.lag === null ? '—' : `${num(idx.lag)} blk`}
            sub={idx.lag === null ? undefined : `≈ ${Math.round(idx.lag * BLOCK_SECONDS)} s behind`}
            tone={lagTone}
          />
          <Stat
            icon={ShieldCheck}
            label="Finalized boundary"
            value={num(idx.finalizedBoundary)}
            sub={
              idx.chainHead && idx.finalizedBoundary
                ? `${num(idx.chainHead - idx.finalizedBoundary)} blk below head`
                : undefined
            }
          />
          <div className="rounded-xl border border-border bg-surface p-4">
            <div className="flex items-center gap-1.5 text-[12px] font-medium text-muted">
              <DatabaseBackup className="size-3.5" aria-hidden />
              Backfill
            </div>
            <div className="tnum mt-2 text-[22px] font-semibold leading-none tracking-[-0.02em]">
              {idx.backfill.pct}%
            </div>
            <div className="mt-2.5">
              <Meter
                pct={idx.backfill.pct}
                tone={idx.backfill.pct >= 100 ? 'good' : 'accent'}
                label="Backfill progress"
              />
            </div>
            <div className="tnum mt-1.5 text-[11.5px] text-muted">
              {idx.backfill.done}/{idx.backfill.chunks} chunks
              {idx.backfill.running > 0 && ` · ${idx.backfill.running} running`}
              {idx.backfill.failed > 0 && ` · ${idx.backfill.failed} retrying`}
            </div>
          </div>
          <Stat
            icon={GitBranchPlus}
            label="Reorgs detected"
            value={num(idx.reorgsDetected)}
            sub={idx.lastReorgDepth ? `last depth ${idx.lastReorgDepth}` : 'none so far'}
            tone={idx.reorgsDetected ? 'warning' : 'default'}
          />
        </div>
      </div>

      {/* Row 3: attention + recent */}
      <div className="grid gap-4 xl:grid-cols-5">
        <Card
          className="xl:col-span-2"
          title="Needs attention"
          action={
            <Link href="/deposits?status=manual_review" className="text-[12px] text-muted hover:text-ink">
              View all
            </Link>
          }
        >
          {o.alerts.manualReview.length === 0 && o.alerts.retryAlerts.length === 0 ? (
            <div className="flex items-center gap-2.5 py-4 text-[12.5px] text-ink-2">
              <CheckCircle2 className="size-4 text-good-ink" aria-hidden />
              Nothing to review. Every deposit is either completed or progressing.
            </div>
          ) : (
            <ul className="-my-1 divide-y divide-border">
              {o.alerts.manualReview.slice(0, 6).map((a) => (
                <li key={a.id}>
                  <Link
                    href={`/deposits?id=${a.id}`}
                    className="flex items-start gap-2.5 py-2.5 hover:opacity-80"
                  >
                    {a.incident ? (
                      <Siren className="mt-0.5 size-4 shrink-0 text-critical-ink" aria-hidden />
                    ) : (
                      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning-ink" aria-hidden />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12.5px] font-medium text-ink">
                        {a.reason ?? 'manual review'}
                      </div>
                      <div className="font-mono text-[11px] text-muted">
                        {short(a.txHash, 10, 6)} · {ago(a.at)}
                      </div>
                    </div>
                  </Link>
                </li>
              ))}
              {o.alerts.retryAlerts.slice(0, 3).map((r, i) => (
                <li key={`r${i}`} className="flex items-start gap-2.5 py-2.5">
                  <Activity className="mt-0.5 size-4 shrink-0 text-serious-ink" aria-hidden />
                  <div className="min-w-0 flex-1 text-[12.5px]">
                    <span className="font-medium">{r.data.step}</span> retried {r.data.attempt}× (still
                    retrying)
                    <div className="truncate text-[11px] text-muted">{r.data.error}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          className="xl:col-span-3"
          title="Recent deposits"
          action={
            <Link href="/deposits" className="flex items-center gap-1 text-[12px] text-muted hover:text-ink">
              All deposits <ArrowRight className="size-3" />
            </Link>
          }
          pad={false}
        >
          {deposits.data && deposits.data.length > 0 ? (
            <ul className="divide-y divide-border">
              {deposits.data.slice(0, 7).map((d) => (
                <li key={d.id}>
                  <Link
                    href={`/deposits?id=${d.id}`}
                    className="grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-2.5 hover:bg-surface-2/50 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto_auto]"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-[12.5px] font-medium">{d.clientName}</div>
                      <div className="font-mono text-[11px] text-muted">{short(d.txHash, 10, 6)}</div>
                    </div>
                    <div className="tnum hidden text-right text-[12.5px] sm:block">
                      <div className="font-medium">
                        {usdt(d.amount)} {d.token}
                      </div>
                      <div className="text-[11px] text-muted">
                        {d.offramp?.idrAmount ? idr(d.offramp.idrAmount) : '—'}
                      </div>
                    </div>
                    <div className={clsx('hidden text-right text-[11.5px] text-muted sm:block')}>
                      {ago(d.firstSeenAt)}
                    </div>
                    <StatusBadge status={d.status} />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-4 py-10 text-center text-[12.5px] text-muted">
              No deposits yet. Send one from the{' '}
              <Link className="text-accent-ink underline" href="/chaos">
                Chaos lab
              </Link>{' '}
              or with <code className="font-mono">make send-deposit</code>.
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className="space-y-5">
      <Skeleton className="h-8 w-48" />
      <div className="grid gap-4 xl:grid-cols-3">
        <Skeleton className="h-56 xl:col-span-2" />
        <Skeleton className="h-56" />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
    </div>
  );
}
