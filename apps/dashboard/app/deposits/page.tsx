'use client';
import { Suspense, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import clsx from 'clsx';
import { ArrowLeftRight, Search } from 'lucide-react';
import { useDeposits } from '@/lib/api';
import { useLive } from '@/lib/live';
import { ago, idr, num, rate, short, usdt } from '@/lib/format';
import type { DepositStatus } from '@/lib/types';
import { Card, Empty, ErrorNote, PageHeader, Pill, Skeleton, STATUS, StatusBadge } from '@/components/ui';
import { DepositDrawer } from '@/components/deposit-drawer';

const TABS: { key: DepositStatus | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'seen', label: 'Seen' },
  { key: 'dispatched', label: 'Processing' },
  { key: 'completed', label: 'Completed' },
  { key: 'manual_review', label: 'Manual review' },
  { key: 'orphaned', label: 'Orphaned' },
];

function DepositsInner() {
  const sp = useSearchParams();
  const router = useRouter();
  const status = (sp.get('status') as DepositStatus | null) ?? undefined;
  const openId = sp.get('id');
  const [q, setQ] = useState('');
  const { data, error, isLoading } = useDeposits();
  const { recentlyChanged } = useLive();

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: data?.length ?? 0 };
    for (const d of data ?? []) c[d.status] = (c[d.status] ?? 0) + 1;
    c.dispatched = (c.dispatched ?? 0) + (c.confirmed ?? 0);
    return c;
  }, [data]);

  const rows = useMemo(() => {
    let r = data ?? [];
    if (status)
      r = r.filter((d) => d.status === status || (status === 'dispatched' && d.status === 'confirmed'));
    const s = q.trim().toLowerCase();
    if (s)
      r = r.filter(
        (d) => d.txHash.includes(s) || (d.clientName ?? '').toLowerCase().includes(s) || d.id.startsWith(s),
      );
    return r;
  }, [data, status, q]);

  const setParam = (k: string, v: string | null) => {
    const p = new URLSearchParams(sp.toString());
    if (v) p.set(k, v);
    else p.delete(k);
    router.replace(`/deposits${p.size ? `?${p}` : ''}`, { scroll: false });
  };

  return (
    <>
      <PageHeader
        title="Deposits"
        desc="Every USDT transfer to a client deposit address, from first sighting to rupiah delivered. Click a row for its workflow timeline."
      />
      <Card pad={false}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-3 py-2.5">
          <div className="flex gap-1 overflow-x-auto" role="tablist">
            {TABS.map((t) => {
              const active = (status ?? 'all') === t.key;
              return (
                <button
                  key={t.key}
                  role="tab"
                  aria-selected={active}
                  onClick={() => setParam('status', t.key === 'all' ? null : t.key)}
                  className={clsx(
                    'flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12.5px] font-medium',
                    active ? 'bg-surface-2 text-ink' : 'text-ink-2 hover:text-ink',
                  )}
                >
                  {t.label}
                  <span className="tnum text-[11px] text-muted">{num(counts[t.key] ?? 0)}</span>
                </button>
              );
            })}
          </div>
          <label className="relative w-full sm:w-64">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted"
              aria-hidden
            />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search tx hash or client"
              className="h-8 w-full rounded-lg border border-border bg-bg pl-8 pr-3 text-[12.5px] outline-none placeholder:text-muted focus:border-accent"
            />
          </label>
        </div>
        <ErrorNote error={error} />
        {isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-9" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <Empty icon={ArrowLeftRight} title={q || status ? 'No matching deposits' : 'No deposits yet'}>
            {!q &&
              !status &&
              'Send a test deposit from the Chaos lab; it shows up here within a second of being mined.'}
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-[12.5px]">
              <thead>
                <tr className="border-b border-border text-left text-[11.5px] text-muted">
                  <th className="px-4 py-2 font-medium">Client</th>
                  <th className="px-3 py-2 font-medium">Tx</th>
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                  <th className="px-3 py-2 text-right font-medium">Rate</th>
                  <th className="px-3 py-2 text-right font-medium">Rupiah</th>
                  <th className="px-3 py-2 font-medium">Step</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 text-right font-medium">Age</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((d) => (
                  <tr
                    key={d.id}
                    onClick={() => setParam('id', d.id)}
                    className={clsx(
                      'cursor-pointer hover:bg-surface-2/50',
                      recentlyChanged.has(d.id) && 'row-flash',
                    )}
                  >
                    <td className="max-w-[200px] px-4 py-2.5">
                      <div className="truncate font-medium">
                        {d.clientName ?? <Pill tone="warning">Unattributed sender</Pill>}
                      </div>
                      {d.source === 'backfill' && (
                        <div className="text-[10.5px] text-muted">via backfill</div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-[11.5px] text-ink-2">
                      {d.explorerUrl ? (
                        <a
                          href={d.explorerUrl}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="hover:text-accent-ink hover:underline"
                        >
                          {short(d.txHash, 8, 6)}
                        </a>
                      ) : (
                        short(d.txHash, 8, 6)
                      )}
                    </td>
                    <td className="tnum px-3 py-2.5 text-right font-medium">
                      {usdt(d.amount)} <span className="text-muted">{d.token}</span>
                    </td>
                    <td className="tnum px-3 py-2.5 text-right text-ink-2">
                      {d.offramp?.rate ? rate(d.offramp.rate) : '—'}
                    </td>
                    <td className="tnum px-3 py-2.5 text-right">
                      {d.offramp?.idrAmount ? idr(d.offramp.idrAmount) : '—'}
                    </td>
                    <td className="px-3 py-2.5">
                      {d.offramp && !['completed', 'manual_review'].includes(d.offramp.step) ? (
                        <span className="font-mono text-[11px] text-ink-2">{d.offramp.step}</span>
                      ) : d.status === 'seen' ? (
                        <span className="tnum text-[11px] text-muted">{num(d.confirmations)} conf.</span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                      {d.offramp?.lastError && d.status === 'dispatched' && (
                        <Pill tone="serious" className="ml-1.5">
                          retrying
                        </Pill>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <StatusBadge status={d.status} />
                    </td>
                    <td
                      className="tnum px-4 py-2.5 text-right text-[11.5px] text-muted"
                      title={STATUS[d.status].hint}
                    >
                      {ago(d.firstSeenAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <DepositDrawer id={openId} onClose={() => setParam('id', null)} />
    </>
  );
}

export default function DepositsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <DepositsInner />
    </Suspense>
  );
}
