'use client';
import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { Bomb, CloudLightning, Copy, Landmark, Leaf, Send, Server, Terminal, Zap } from 'lucide-react';
import { useChaos, useSendDemo, useSetChaos } from '@/lib/api';
import { num, short } from '@/lib/format';
import type { ChaosConfig, ChaosState } from '@/lib/types';
import { Button, Card, CopyText, ErrorNote, PageHeader, Pill } from '@/components/ui';

type Target = 'mobee' | 'bifast';
const KNOBS: {
  key: keyof ChaosConfig;
  label: string;
  help: string;
  targets: Target[];
  kind: 'rate' | 'ms';
  max?: number;
}[] = [
  {
    key: 'FAIL_RATE',
    label: 'Fail before processing',
    help: '500 without doing anything',
    targets: ['mobee', 'bifast'],
    kind: 'rate',
  },
  {
    key: 'FAIL_AFTER_RATE',
    label: 'Lose the response',
    help: 'Do the work, then reply 500 — tests idempotency',
    targets: ['mobee', 'bifast'],
    kind: 'rate',
  },
  {
    key: 'TIMEOUT_RATE',
    label: 'Timeout',
    help: 'Hold the response longer than the client waits',
    targets: ['mobee', 'bifast'],
    kind: 'rate',
  },
  {
    key: 'LATENCY_MS_MAX',
    label: 'Max latency',
    help: 'Random extra delay per request',
    targets: ['mobee', 'bifast'],
    kind: 'ms',
    max: 3000,
  },
  {
    key: 'DUPLICATE_CALLBACK_RATE',
    label: 'Duplicate callback',
    help: 'Send the bank callback twice',
    targets: ['bifast'],
    kind: 'rate',
  },
  {
    key: 'DROP_CALLBACK_RATE',
    label: 'Drop callback',
    help: 'Never call back — forces reconciliation',
    targets: ['bifast'],
    kind: 'rate',
  },
  {
    key: 'LATE_CALLBACK_MS',
    label: 'Late callback',
    help: 'Extra delay before the callback',
    targets: ['bifast'],
    kind: 'ms',
    max: 180_000,
  },
  {
    key: 'FINAL_FAILURE_RATE',
    label: 'Bank rejects transfer',
    help: 'Final failure → manual review',
    targets: ['bifast'],
    kind: 'rate',
  },
];

const PRESETS: { name: string; icon: typeof Leaf; patch: Partial<ChaosConfig> }[] = [
  {
    name: 'Calm',
    icon: Leaf,
    patch: {
      FAIL_RATE: 0,
      FAIL_AFTER_RATE: 0,
      TIMEOUT_RATE: 0,
      LATENCY_MS_MAX: 0,
      DUPLICATE_CALLBACK_RATE: 0,
      DROP_CALLBACK_RATE: 0,
      FINAL_FAILURE_RATE: 0,
      LATE_CALLBACK_MS: 0,
    },
  },
  {
    name: 'Demo (30%)',
    icon: CloudLightning,
    patch: {
      FAIL_RATE: 0.3,
      FAIL_AFTER_RATE: 0.05,
      TIMEOUT_RATE: 0,
      LATENCY_MS_MAX: 300,
      DUPLICATE_CALLBACK_RATE: 0.1,
      DROP_CALLBACK_RATE: 0,
      FINAL_FAILURE_RATE: 0,
    },
  },
  {
    name: 'Storm (50%)',
    icon: Bomb,
    patch: {
      FAIL_RATE: 0.5,
      FAIL_AFTER_RATE: 0.15,
      TIMEOUT_RATE: 0.05,
      LATENCY_MS_MAX: 800,
      DUPLICATE_CALLBACK_RATE: 0.3,
      DROP_CALLBACK_RATE: 0.2,
      FINAL_FAILURE_RATE: 0,
    },
  },
];

function Knob({
  value,
  onCommit,
  kind,
  max = 1,
}: {
  value: number;
  onCommit: (v: number) => void;
  kind: 'rate' | 'ms';
  max?: number;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const step = kind === 'rate' ? 0.05 : max > 10_000 ? 5000 : 100;
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={0}
        max={max}
        step={step}
        value={v}
        onChange={(e) => setV(Number(e.target.value))}
        onPointerUp={() => v !== value && onCommit(v)}
        onKeyUp={() => v !== value && onCommit(v)}
        className="h-1.5 flex-1 cursor-pointer accent-[var(--accent)]"
      />
      <span
        className={clsx('tnum w-16 text-right text-[12px] font-medium', v > 0 ? 'text-ink' : 'text-muted')}
      >
        {kind === 'rate'
          ? `${Math.round(v * 100)}%`
          : v >= 1000
            ? `${(v / 1000).toFixed(v % 1000 ? 1 : 0)} s`
            : `${v} ms`}
      </span>
    </div>
  );
}

function MockPanel({ target, state }: { target: Target; state: ChaosState | { error: string } | undefined }) {
  const set = useSetChaos();
  const title = target === 'mobee' ? 'Exchange (Mobee mock)' : 'BI-FAST (PJP mock)';
  const Icon = target === 'mobee' ? Server : Landmark;
  const ok = state && 'config' in state;
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <Icon className="size-4 text-muted" aria-hidden />
          {title}
        </span>
      }
      action={
        ok ? (
          <Pill tone={state.config.FAIL_RATE > 0 ? 'serious' : 'good'}>
            {state.config.FAIL_RATE > 0 ? 'chaos on' : 'healthy'}
          </Pill>
        ) : (
          <Pill tone="critical">unreachable</Pill>
        )
      }
    >
      {!ok ? (
        <div className="text-[12.5px] text-muted">{state && 'error' in state ? state.error : 'loading…'}</div>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-4 gap-2 rounded-lg bg-surface-2/60 p-2.5 text-center">
            {[
              ['requests', state.stats.requests],
              ['failed', state.stats.failedBefore],
              ['lost resp.', state.stats.failedAfter],
              ['timeouts', state.stats.timeouts],
            ].map(([k, v]) => (
              <div key={k as string}>
                <div className="tnum text-[15px] font-semibold">{num(v as number)}</div>
                <div className="text-[10.5px] text-muted">{k}</div>
              </div>
            ))}
          </div>
          <div className="space-y-3.5">
            {KNOBS.filter((k) => k.targets.includes(target)).map((k) => (
              <div key={k.key}>
                <div className="mb-1">
                  <div className="text-[12.5px] font-medium">{k.label}</div>
                  <div className="text-[11px] text-muted">{k.help}</div>
                </div>
                <Knob
                  value={state.config[k.key]}
                  kind={k.kind}
                  max={k.max ?? 1}
                  onCommit={(v) =>
                    set.mutate({
                      target,
                      patch:
                        k.key === 'LATENCY_MS_MAX'
                          ? { LATENCY_MS_MAX: v, LATENCY_MS_MIN: 0 }
                          : { [k.key]: v },
                    })
                  }
                />
              </div>
            ))}
          </div>
          <ErrorNote error={set.error} />
        </>
      )}
    </Card>
  );
}

const CMDS = [
  { label: 'Kill the workflow service mid-swap', cmd: 'make kill-workflow' },
  { label: 'Restart it (resumes from the journal)', cmd: 'make restart-workflow' },
  { label: 'Kill / restart the indexer', cmd: 'make kill-indexer && sleep 60 && make restart-indexer' },
  { label: 'Catch-up demo (stop indexer, burst, restart)', cmd: 'make demo-catchup' },
  { label: 'Reorg demo (simulated chain)', cmd: 'make demo-reorg' },
  { label: 'Check invariants', cmd: 'make invariants' },
];

export default function ChaosPage() {
  const { data } = useChaos();
  const set = useSetChaos();
  const send = useSendDemo();
  const [amount, setAmount] = useState('100');
  const applyPreset = (patch: Partial<ChaosConfig>) => {
    set.mutate({
      target: 'mobee',
      patch: Object.fromEntries(
        Object.entries(patch).filter(([k]) => KNOBS.find((x) => x.key === k)?.targets.includes('mobee')),
      ) as Record<string, number>,
    });
    set.mutate({ target: 'bifast', patch: patch as Record<string, number> });
  };
  return (
    <>
      <PageHeader
        title="Chaos lab"
        desc="Break the upstreams on purpose. Every step is durable and retried until it succeeds; idempotency keys make retries safe."
        actions={PRESETS.map((p) => (
          <Button key={p.name} size="sm" onClick={() => applyPreset(p.patch)} disabled={set.isPending}>
            <p.icon className="size-3.5" aria-hidden />
            {p.name}
          </Button>
        ))}
      />
      <div className="grid gap-4 xl:grid-cols-3">
        <Card
          className="xl:col-span-1"
          title={
            <span className="flex items-center gap-2">
              <Zap className="size-4 text-muted" aria-hidden />
              Generate traffic
            </span>
          }
        >
          <p className="text-[12.5px] text-ink-2">
            Sends <b>real</b> mUSDT transfers on Base Sepolia from the client test wallets to their deposit
            addresses. The indexer picks them up within a second of being mined.
          </p>
          <label className="mt-4 block text-[12px] font-medium" htmlFor="amt">
            Amount per deposit (mUSDT)
          </label>
          <input
            id="amt"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
            className="tnum mt-1 h-9 w-full rounded-lg border border-border bg-bg px-3 text-[13px] outline-none focus:border-accent"
          />
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Button
              variant="primary"
              disabled={send.isPending || !amount}
              onClick={() => send.mutate({ amount, count: 1 })}
            >
              <Send className="size-3.5" aria-hidden /> Send 1 deposit
            </Button>
            <Button
              disabled={send.isPending || !amount}
              onClick={() => send.mutate({ amount, count: 20, randomize: true })}
            >
              <Send className="size-3.5" aria-hidden /> Send 20
            </Button>
          </div>
          {send.isPending && <div className="mt-3 text-[12px] text-muted">Broadcasting…</div>}
          {!send.data && !send.isPending && (
            <ol className="mt-5 space-y-2.5 border-t border-border pt-4 text-[12px] text-ink-2">
              <li>
                <b className="text-ink">1 · Detect.</b> Deposits page shows it as <i>Seen</i> ~1 s after it is
                mined.
              </li>
              <li>
                <b className="text-ink">2 · Finality.</b> It turns <i>Confirmed</i> once below the{' '}
                <span className="font-mono">safe</span> boundary (~2 min on Base Sepolia).
              </li>
              <li>
                <b className="text-ink">3 · Workflow.</b> Open the row: each step shows the injected errors it
                survived.
              </li>
              <li>
                <b className="text-ink">4 · Paid.</b> <i>Completed</i> = BI-FAST callback verified; the ledger
                balances.
              </li>
            </ol>
          )}
          <ErrorNote error={send.error} />
          {send.data && (
            <ul className="mt-3 max-h-48 space-y-1 overflow-y-auto rounded-lg bg-surface-2/60 p-2.5">
              {send.data.results.flatMap((r) =>
                r.txs.map((t) => (
                  <li key={t.hash} className="flex items-center justify-between gap-2 text-[11.5px]">
                    <span className="truncate text-ink-2">{r.client}</span>
                    <a
                      className="font-mono text-accent-ink hover:underline"
                      href={t.explorerUrl ?? '#'}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {short(t.hash, 8, 6)} ↗
                    </a>
                  </li>
                )),
              )}
            </ul>
          )}
        </Card>
        <MockPanel target="mobee" state={data?.mobee} />
        <MockPanel target="bifast" state={data?.bifast} />
      </div>

      <Card
        className="mt-4"
        title={
          <span className="flex items-center gap-2">
            <Terminal className="size-4 text-muted" aria-hidden />
            Kill &amp; restart (run in a terminal)
          </span>
        }
      >
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {CMDS.map((c) => (
            <div key={c.cmd} className="rounded-lg border border-border bg-surface-2/40 px-3 py-2.5">
              <div className="text-[12px] text-ink-2">{c.label}</div>
              <CopyText value={c.cmd} wrap className="mt-1 text-[12px] text-ink" />
            </div>
          ))}
        </div>
        <p className="mt-3 flex items-center gap-1.5 text-[11.5px] text-muted">
          <Copy className="size-3" aria-hidden /> Watch the Restate UI at{' '}
          <span className="font-mono">http://localhost:9070</span> to see invocations retrying and resuming.
        </p>
      </Card>
    </>
  );
}
