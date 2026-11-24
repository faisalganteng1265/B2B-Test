'use client';
import Link from 'next/link';
import clsx from 'clsx';
import { BookOpenCheck, CheckCircle2, XCircle } from 'lucide-react';
import { useLedger } from '@/lib/api';
import { fromBase, idr, short, time } from '@/lib/format';
import { Card, Empty, ErrorNote, PageHeader, Pill, Skeleton } from '@/components/ui';

const ACCOUNT_INFO: Record<string, string> = {
  exchange_usdt: 'USDT held at the exchange (asset)',
  client_usdt_liability: 'USDT owed to clients (liability)',
  exchange_idr: 'IDR received from swaps (asset)',
  client_idr_payable: 'IDR owed to clients, not yet paid (liability)',
  bank_out: 'IDR sent out via BI-FAST',
  fee_revenue: 'Mopay fee income',
};

const fmt = (v: string, cur: string) => (cur === 'IDR' ? idr(v, false) : fromBase(v));

export default function LedgerPage() {
  const { data, error, isLoading } = useLedger();
  return (
    <>
      <PageHeader
        title="Ledger"
        desc="Double-entry journals per deposit. Every journal balances per currency — enforced by the app and by a deferred database trigger; entries are append-only."
      />
      <ErrorNote error={error} />
      {isLoading || !data ? (
        <Skeleton className="h-96" />
      ) : (
        <div className="space-y-4">
          <div
            className={clsx(
              'flex items-center gap-3 rounded-xl border px-4 py-3',
              data.balanced ? 'border-good/30 bg-good-soft' : 'border-critical/40 bg-critical-soft',
            )}
          >
            {data.balanced ? (
              <CheckCircle2 className="size-5 text-good-ink" aria-hidden />
            ) : (
              <XCircle className="size-5 text-critical-ink" aria-hidden />
            )}
            <div>
              <div
                className={clsx(
                  'text-[13.5px] font-semibold',
                  data.balanced ? 'text-good-ink' : 'text-critical-ink',
                )}
              >
                {data.balanced ? 'All journals balance' : `${data.unbalancedJournals} unbalanced journal(s)`}
              </div>
              <div className="text-[12px] text-ink-2">Σ debit = Σ credit for every journal and currency.</div>
            </div>
          </div>

          <Card title="Account balances" pad={false}>
            {data.totals.length === 0 ? (
              <Empty icon={BookOpenCheck} title="No entries yet" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-[12.5px]">
                  <thead>
                    <tr className="border-b border-border text-left text-[11.5px] text-muted">
                      <th className="px-4 py-2 font-medium">Account</th>
                      <th className="px-3 py-2 font-medium">Currency</th>
                      <th className="px-3 py-2 text-right font-medium">Debit</th>
                      <th className="px-3 py-2 text-right font-medium">Credit</th>
                      <th className="px-4 py-2 text-right font-medium">Balance (Dr − Cr)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {data.totals.map((t) => (
                      <tr key={t.account + t.currency}>
                        <td className="px-4 py-2.5">
                          <div className="font-mono text-[12px]">{t.account}</div>
                          <div className="text-[11px] text-muted">{ACCOUNT_INFO[t.account]}</div>
                        </td>
                        <td className="px-3 py-2.5 text-ink-2">{t.currency}</td>
                        <td className="tnum px-3 py-2.5 text-right">{fmt(t.debit, t.currency)}</td>
                        <td className="tnum px-3 py-2.5 text-right">{fmt(t.credit, t.currency)}</td>
                        <td className="tnum px-4 py-2.5 text-right font-medium">
                          {fmt(t.balance, t.currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card
            title="Recent journals"
            action={<span className="text-[12px] text-muted">{data.journals.length} shown</span>}
            pad={false}
          >
            <ul className="divide-y divide-border">
              {data.journals.slice(0, 60).map((j) => (
                <li key={j.journalId} className="px-4 py-3">
                  <div className="mb-1.5 flex flex-wrap items-center gap-2">
                    <Pill tone={j.kind === 'payout' ? 'good' : j.kind === 'swap' ? 'accent' : 'neutral'}>
                      {j.kind}
                    </Pill>
                    {j.balanced ? <Pill tone="good">balanced</Pill> : <Pill tone="critical">unbalanced</Pill>}
                    {j.depositId && (
                      <Link
                        href={`/deposits?id=${j.depositId}`}
                        className="font-mono text-[11.5px] text-ink-2 hover:text-accent-ink hover:underline"
                      >
                        {j.txHash ? short(j.txHash, 10, 6) : short(j.depositId)}
                      </Link>
                    )}
                    <span className="tnum ml-auto text-[11px] text-muted">{time(j.at)}</span>
                  </div>
                  <div className="grid gap-x-6 gap-y-0.5 text-[12px] sm:grid-cols-2">
                    {j.lines.map((l) => (
                      <div key={l.id} className="flex justify-between gap-3">
                        <span
                          className={clsx(
                            'font-mono text-[11.5px]',
                            l.debit !== '0' ? 'text-ink' : 'pl-4 text-ink-2',
                          )}
                        >
                          {l.account}
                        </span>
                        <span className="tnum">
                          {l.debit !== '0'
                            ? `Dr ${fmt(l.debit, l.currency)}`
                            : `Cr ${fmt(l.credit, l.currency)}`}{' '}
                          <span className="text-muted">{l.currency}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </>
  );
}
