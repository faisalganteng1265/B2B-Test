'use client';
import { useState } from 'react';
import { ArrowDownToLine, Landmark, Server, ShieldCheck, Wallet } from 'lucide-react';
import { useExchange, useSweep } from '@/lib/api';
import { BANKS, idr, short, time, usdt } from '@/lib/format';
import { Button, Card, CopyText, Empty, ErrorNote, PageHeader, Pill, Skeleton, Stat } from '@/components/ui';

export default function ExchangePage() {
  const { data, error, isLoading } = useExchange();
  const sweep = useSweep();
  const [amount, setAmount] = useState('');
  const bal = (a: string) => data?.account?.balances.find((b) => b.asset === a)?.free ?? '0';
  const idrFree = BigInt(bal('IDR').split('.')[0] || '0');
  return (
    <>
      <PageHeader
        title="Exchange"
        desc="Mopay's account at the PAKD (Indodax, TAPIv2 mock). Crypto is sold here; rupiah is swept to Mopay's own bank account, which funds BI-FAST payouts."
      />
      <ErrorNote error={error ?? (data?.error ? new Error(data.error) : null)} />
      {isLoading || !data ? (
        <Skeleton className="h-80" />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Stat
              icon={Wallet}
              label="USDT at Indodax"
              value={usdt(bal('USDT'))}
              sub="credited deposits not yet sold"
            />
            <Stat
              icon={Server}
              label="IDR at Indodax"
              value={idr(bal('IDR'))}
              sub="sale proceeds, ready to sweep"
              tone={idrFree > 100_000n ? 'good' : 'default'}
            />
            <Stat
              icon={ShieldCheck}
              label="API key"
              value={data.account ? 'TAPIv2' : '—'}
              sub={data.account ? `${data.account.accountType} · uid ${data.account.uid}` : undefined}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Deposit address (one per account)">
              {data.depositAddress ? (
                <>
                  <CopyText value={data.depositAddress} className="text-[13px] text-ink" />
                  <p className="mt-3 text-[12.5px] leading-relaxed text-ink-2">
                    Indodax gives one USDT address per account and network, so every client sends to this
                    address. A deposit is credited to the client whose <b>registered wallet</b> sent it.
                    Deposits from unknown wallets are held for review and never sold automatically.
                  </p>
                  <div className="mt-3 flex gap-2 text-[11.5px]">
                    <Pill>network: {data.network ?? 'base'}</Pill>
                    <Pill>GET /api/v2/capital/deposit/address/list</Pill>
                  </div>
                </>
              ) : (
                <div className="text-muted">Not provisioned. Run make seed.</div>
              )}
            </Card>

            <Card
              title={
                <span className="flex items-center gap-2">
                  <Landmark className="size-4 text-muted" aria-hidden />
                  Treasury sweep
                </span>
              }
            >
              <p className="text-[12.5px] leading-relaxed text-ink-2">
                Withdraws IDR from Indodax to Mopay's own bank account (Indodax only allows a bank account in
                the same name as the KYC holder). Idempotent via{' '}
                <span className="font-mono">clientRequestId</span>. Minimum above Rp100.000.
              </p>
              {data.bank && (
                <div className="mt-2 text-[12px] text-muted">
                  To {BANKS[data.bank.bankCode] ?? data.bank.bankCode} ·{' '}
                  <span className="font-mono">{data.bank.accountNumber}</span>
                </div>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))}
                  placeholder={`all (${idr(idrFree.toString())})`}
                  className="tnum h-9 min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 text-[13px] outline-none focus:border-accent"
                  aria-label="Amount to sweep (IDR)"
                />
                <Button
                  variant="primary"
                  disabled={sweep.isPending || idrFree <= 100_000n}
                  onClick={() => sweep.mutate(amount || undefined)}
                >
                  <ArrowDownToLine className="size-3.5" aria-hidden /> Sweep to bank
                </Button>
              </div>
              <ErrorNote error={sweep.error} />
            </Card>
          </div>

          <Card title="Sweeps" pad={false}>
            {data.sweeps.length === 0 ? (
              <Empty icon={Landmark} title="No sweeps yet">
                Sale proceeds stay at the exchange until swept.
              </Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-[12.5px]">
                  <thead>
                    <tr className="border-b border-border text-left text-[11.5px] text-muted">
                      <th className="px-4 py-2 font-medium">Created</th>
                      <th className="px-3 py-2 text-right font-medium">Amount</th>
                      <th className="px-3 py-2 text-right font-medium">Fee</th>
                      <th className="px-3 py-2 font-medium">Indodax order</th>
                      <th className="px-4 py-2 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {data.sweeps.map((s) => (
                      <tr key={s.id}>
                        <td className="tnum px-4 py-2.5 text-ink-2">{time(s.createdAt)}</td>
                        <td className="tnum px-3 py-2.5 text-right">{idr(s.amountIdr)}</td>
                        <td className="tnum px-3 py-2.5 text-right text-ink-2">
                          {s.feeIdr ? idr(s.feeIdr) : '—'}
                        </td>
                        <td className="px-3 py-2.5 font-mono text-[11.5px] text-ink-2">
                          {s.exchangeOrderNo ? short(s.exchangeOrderNo, 8, 4) : '—'}
                        </td>
                        <td className="px-4 py-2.5">
                          <Pill
                            tone={
                              s.status === 'success'
                                ? 'good'
                                : s.status === 'rejected'
                                  ? 'critical'
                                  : 'accent'
                            }
                          >
                            {s.status}
                          </Pill>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
