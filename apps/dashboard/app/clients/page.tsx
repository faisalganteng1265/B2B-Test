'use client';
import { useState } from 'react';
import { Building2, Landmark, Send, Wallet } from 'lucide-react';
import { useClients, useSendDemo } from '@/lib/api';
import { BANKS, idr, num, short, usdt } from '@/lib/format';
import { Button, Card, CopyText, Empty, ErrorNote, PageHeader, Pill, Skeleton } from '@/components/ui';

export default function ClientsPage() {
  const { data, error, isLoading } = useClients();
  const send = useSendDemo();
  const [sentFor, setSentFor] = useState<string | null>(null);
  return (
    <>
      <PageHeader
        title="Clients"
        desc="B2B clients, their exchange-issued deposit addresses and verified payout accounts."
      />
      <ErrorNote error={error} />
      {isLoading ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      ) : !data?.length ? (
        <Card>
          <Empty icon={Building2} title="No clients">
            Run <code className="font-mono">make seed</code> to create the two demo clients.
          </Empty>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {data.map((c) => {
            const addr = c.depositAddresses.find((a) => a.current);
            const bank = c.bankAccounts[0];
            return (
              <Card
                key={c.id}
                title={
                  <span className="flex items-center gap-2">
                    {c.name}
                    <Pill tone={c.status === 'active' ? 'good' : 'warning'}>{c.status}</Pill>
                  </span>
                }
                action={<span className="font-mono text-[11px] text-muted">mpk_{c.apiKeyPrefix}_…</span>}
              >
                <div className="grid grid-cols-3 gap-3 border-b border-border pb-4">
                  <div>
                    <div className="text-[11.5px] text-muted">Deposits</div>
                    <div className="tnum mt-1 text-[17px] font-semibold">{num(c.stats.deposits)}</div>
                    <div className="tnum text-[11px] text-muted">{num(c.stats.completed)} completed</div>
                  </div>
                  <div>
                    <div className="text-[11.5px] text-muted">Volume</div>
                    <div className="tnum mt-1 text-[17px] font-semibold">{usdt(c.stats.volumeUsdt)}</div>
                    <div className="text-[11px] text-muted">USDT offramped</div>
                  </div>
                  <div>
                    <div className="text-[11.5px] text-muted">Paid out</div>
                    <div className="tnum mt-1 truncate text-[17px] font-semibold">
                      {idr(c.stats.paidOutIdr)}
                    </div>
                    <div className="text-[11px] text-muted">via BI-FAST</div>
                  </div>
                </div>
                <div className="mt-4 space-y-3">
                  <div className="flex items-start gap-3">
                    <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-ink">
                      <Wallet className="size-4" aria-hidden />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[11.5px] text-muted">
                        Registered sender wallets (KYB) · deposits are attributed by sender
                      </div>
                      {c.wallets.length ? (
                        c.wallets.map((w) => (
                          <CopyText key={w.address} value={w.address} className="mt-0.5 text-[12.5px]" />
                        ))
                      ) : (
                        <div className="mt-0.5 text-[12px] text-warning-ink">
                          none: deposits from this client will be held for review
                        </div>
                      )}
                      {addr ? null : (
                        <div className="mt-1 text-[11px] text-muted">
                          sends to the shared Indodax address{' '}
                          {c.sharedDepositAddress && (
                            <span className="font-mono">{short(c.sharedDepositAddress, 8, 6)}</span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-good-soft text-good-ink">
                      <Landmark className="size-4" aria-hidden />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[11.5px] text-muted">Payout account (BI-FAST)</div>
                      {bank ? (
                        <>
                          <div className="mt-0.5 text-[12.5px] font-medium">{bank.accountName}</div>
                          <div className="font-mono text-[11.5px] text-ink-2">
                            {BANKS[bank.bankCode] ?? bank.bankCode} · {bank.accountNumber}
                            {bank.verifiedAt && (
                              <Pill tone="good" className="ml-2">
                                verified
                              </Pill>
                            )}
                          </div>
                        </>
                      ) : (
                        <span className="text-muted">none</span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3">
                  <Button
                    size="sm"
                    disabled={send.isPending}
                    onClick={() => {
                      setSentFor(c.id);
                      send.mutate({ clientId: c.id, amount: '250', count: 1 });
                    }}
                  >
                    <Send className="size-3.5" aria-hidden /> Send 250 mUSDT test deposit
                  </Button>
                  {sentFor === c.id && send.data?.results[0]?.txs[0] && (
                    <a
                      className="font-mono text-[11.5px] text-accent-ink hover:underline"
                      href={send.data.results[0].txs[0].explorerUrl ?? '#'}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {short(send.data.results[0].txs[0].hash, 10, 6)} ↗
                    </a>
                  )}
                </div>
                {sentFor === c.id && <ErrorNote error={send.error} />}
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
