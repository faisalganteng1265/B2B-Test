'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import {
  ArrowLeftRight,
  BookOpenCheck,
  Coins,
  Building2,
  Gauge,
  Moon,
  Sun,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useOverview } from '@/lib/api';
import { useLive } from '@/lib/live';
import { ago, rate } from '@/lib/format';

const NAV: { href: string; label: string; icon: LucideIcon }[] = [
  { href: '/', label: 'Overview', icon: Gauge },
  { href: '/deposits', label: 'Deposits', icon: ArrowLeftRight },
  { href: '/clients', label: 'Clients', icon: Building2 },
  { href: '/exchange', label: 'Exchange', icon: Coins },
  { href: '/ledger', label: 'Ledger', icon: BookOpenCheck },
  { href: '/chaos', label: 'Chaos lab', icon: Zap },
];

function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="grid size-7 place-items-center rounded-lg bg-ink text-[13px] font-bold text-bg">M</div>
      <div className="leading-tight">
        <div className="text-[13.5px] font-semibold tracking-[-0.01em] text-ink">Mopay</div>
        <div className="text-[11px] text-muted">B2B Offramp · Ops</div>
      </div>
    </div>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState<'light' | 'dark' | null>(null);
  useEffect(() => {
    const t = document.documentElement.dataset.theme as 'light' | 'dark' | undefined;
    setTheme(t ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  }, []);
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      aria-label={`Switch to ${next} mode`}
      onClick={() => {
        document.documentElement.dataset.theme = next;
        try {
          localStorage.setItem('mopay-theme', next);
        } catch {
          /* storage unavailable */
        }
        setTheme(next);
      }}
      className="grid size-8 place-items-center rounded-lg text-ink-2 hover:bg-surface-2 hover:text-ink"
    >
      {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}

function LiveIndicator() {
  const { connected, lastEventAt } = useLive();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div
      className="flex items-center gap-2 text-[12px] text-ink-2"
      title={lastEventAt ? `last event ${ago(new Date(lastEventAt).toISOString())}` : undefined}
    >
      <span
        className={clsx('size-2 rounded-full', connected ? 'live-dot bg-good' : 'bg-critical')}
        aria-hidden
      />
      <span className="hidden sm:inline">{connected ? 'Live' : 'Reconnecting…'}</span>
    </div>
  );
}

function TopPrice() {
  const { data } = useOverview();
  const p = data?.price;
  if (!p) return null;
  return (
    <div className="hidden items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1 text-[12px] md:flex">
      <span className="text-muted">USDT/IDR</span>
      <span className="tnum font-semibold text-ink">{rate(p.bid)}</span>
      {p.stale && (
        <span className="rounded bg-warning-soft px-1 text-[10.5px] font-medium text-warning-ink">stale</span>
      )}
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { data } = useOverview();
  const chain = data?.chain.name ?? 'base-sepolia';
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[232px_1fr]">
      <aside className="sticky top-0 hidden h-dvh flex-col border-r border-border bg-surface px-3 py-4 lg:flex">
        <div className="px-2">
          <Logo />
        </div>
        <nav className="mt-6 flex flex-col gap-0.5" aria-label="Main">
          {NAV.map((n) => {
            const active = n.href === '/' ? path === '/' : path.startsWith(n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                className={clsx(
                  'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors',
                  active ? 'bg-surface-2 text-ink' : 'text-ink-2 hover:bg-surface-2/60 hover:text-ink',
                )}
              >
                <n.icon className={clsx('size-4', active ? 'text-accent' : 'text-muted')} aria-hidden />
                {n.label}
              </Link>
            );
          })}
        </nav>
        <div className="mt-auto space-y-3 px-2">
          <div className="rounded-lg border border-border bg-surface-2/60 p-3 text-[11.5px] leading-relaxed text-ink-2">
            <div className="font-medium text-ink">Prototype</div>
            Crypto custody &amp; swap: Indodax TAPIv2 <span className="text-muted">(mock)</span>. IDR via
            BI-FAST: PJP <span className="text-muted">(mock)</span>. Price: Indodax{' '}
            <span className="text-muted">(real)</span>.
          </div>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-20 border-b border-border bg-bg/85 backdrop-blur">
          <div className="flex h-14 items-center gap-3 px-4 sm:px-6">
            <div className="lg:hidden">
              <Logo />
            </div>
            <div className="ml-auto flex items-center gap-3">
              <TopPrice />
              <span className="hidden rounded-md border border-border bg-surface px-2 py-1 font-mono text-[11.5px] text-ink-2 sm:inline">
                {chain}
              </span>
              <LiveIndicator />
              <ThemeToggle />
            </div>
          </div>
          <nav className="flex gap-1 overflow-x-auto px-3 pb-2 lg:hidden" aria-label="Main">
            {NAV.map((n) => {
              const active = n.href === '/' ? path === '/' : path.startsWith(n.href);
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  className={clsx(
                    'flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12.5px] font-medium',
                    active ? 'bg-surface-2 text-ink' : 'text-ink-2',
                  )}
                >
                  <n.icon className="size-3.5" aria-hidden />
                  {n.label}
                </Link>
              );
            })}
          </nav>
        </header>
        <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6">{children}</main>
      </div>
    </div>
  );
}
