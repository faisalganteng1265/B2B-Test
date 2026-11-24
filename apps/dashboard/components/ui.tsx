'use client';
import { useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import clsx from 'clsx';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  CircleDashed,
  Copy,
  GitBranchPlus,
  Loader2,
  ShieldCheck,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import type { DepositStatus } from '@/lib/types';

export function Card({
  title,
  action,
  children,
  className,
  pad = true,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  pad?: boolean;
}) {
  return (
    <section
      className={clsx(
        'rounded-xl border border-border bg-surface shadow-[0_1px_0_rgba(0,0,0,0.02)]',
        className,
      )}
    >
      {(title || action) && (
        <header className="flex min-h-11 items-center justify-between gap-3 border-b border-border px-4 py-2.5">
          <h2 className="text-[13px] font-semibold tracking-[-0.005em] text-ink">{title}</h2>
          {action}
        </header>
      )}
      <div className={clsx(pad && 'p-4')}>{children}</div>
    </section>
  );
}

export function Stat({
  label,
  value,
  sub,
  icon: Icon,
  tone = 'default',
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  icon?: LucideIcon;
  tone?: 'default' | 'good' | 'warning' | 'critical';
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="flex items-center gap-1.5 text-[12px] font-medium text-muted">
        {Icon && <Icon className="size-3.5" aria-hidden />}
        {label}
      </div>
      <div
        className={clsx(
          'tnum mt-2 text-[22px] font-semibold leading-none tracking-[-0.02em]',
          tone === 'good' && 'text-good-ink',
          tone === 'warning' && 'text-warning-ink',
          tone === 'critical' && 'text-critical-ink',
        )}
      >
        {value}
      </div>
      {sub && <div className="mt-2 text-[12px] text-muted">{sub}</div>}
    </div>
  );
}

export const STATUS: Record<
  DepositStatus,
  { label: string; icon: LucideIcon; cls: string; bar: string; hint: string }
> = {
  seen: {
    label: 'Seen',
    icon: CircleDashed,
    cls: 'bg-neutral-soft text-ink-2',
    bar: '#a3a29c',
    hint: 'In a block, waiting for finality',
  },
  confirmed: {
    label: 'Confirmed',
    icon: ShieldCheck,
    cls: 'bg-accent-soft text-accent-ink',
    bar: '#86b6ef',
    hint: 'Final; queued in the outbox',
  },
  dispatched: {
    label: 'Processing',
    icon: Loader2,
    cls: 'bg-accent-soft text-accent-ink',
    bar: '#2a78d6',
    hint: 'Offramp workflow running',
  },
  completed: {
    label: 'Completed',
    icon: CheckCircle2,
    cls: 'bg-good-soft text-good-ink',
    bar: '#0ca30c',
    hint: 'Rupiah delivered via BI-FAST',
  },
  orphaned: {
    label: 'Orphaned',
    icon: GitBranchPlus,
    cls: 'bg-serious-soft text-serious-ink',
    bar: '#ec835a',
    hint: 'Block reorged away; never processed',
  },
  manual_review: {
    label: 'Manual review',
    icon: AlertTriangle,
    cls: 'bg-warning-soft text-warning-ink',
    bar: '#fab219',
    hint: 'Stopped safely; needs an operator',
  },
  failed: {
    label: 'Failed',
    icon: XCircle,
    cls: 'bg-critical-soft text-critical-ink',
    bar: '#d03b3b',
    hint: 'Failed',
  },
};
export const STATUS_ORDER: DepositStatus[] = [
  'seen',
  'confirmed',
  'dispatched',
  'completed',
  'manual_review',
  'orphaned',
  'failed',
];

export function StatusBadge({ status, className }: { status: DepositStatus; className?: string }) {
  const s = STATUS[status];
  const Icon = s.icon;
  return (
    <span
      title={s.hint}
      className={clsx(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-medium',
        s.cls,
        className,
      )}
    >
      <Icon
        className={clsx('size-3', status === 'dispatched' && 'animate-spin [animation-duration:2.4s]')}
        aria-hidden
      />
      {s.label}
    </span>
  );
}

export function Pill({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'good' | 'warning' | 'critical' | 'serious';
  className?: string;
}) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-medium',
        tone === 'neutral' && 'bg-neutral-soft text-ink-2',
        tone === 'accent' && 'bg-accent-soft text-accent-ink',
        tone === 'good' && 'bg-good-soft text-good-ink',
        tone === 'warning' && 'bg-warning-soft text-warning-ink',
        tone === 'serious' && 'bg-serious-soft text-serious-ink',
        tone === 'critical' && 'bg-critical-soft text-critical-ink',
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Button({
  variant = 'default',
  size = 'md',
  className,
  ...p
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
}) {
  return (
    <button
      {...p}
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        size === 'md' ? 'h-9 px-3.5 text-[13px]' : 'h-7 px-2.5 text-[12px]',
        variant === 'default' && 'border border-border bg-surface text-ink hover:bg-surface-2',
        variant === 'primary' && 'bg-accent text-white hover:brightness-110',
        variant === 'ghost' && 'text-ink-2 hover:bg-surface-2 hover:text-ink',
        variant === 'danger' && 'border border-border bg-surface text-critical-ink hover:bg-critical-soft',
        className,
      )}
    />
  );
}

export function Copy_({
  value,
  label,
  className,
  wrap,
}: {
  value: string;
  label?: ReactNode;
  className?: string;
  wrap?: boolean;
}) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(value).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
      className={clsx(
        'group inline-flex min-w-0 items-center gap-1 rounded font-mono text-[12px] text-ink-2 hover:text-ink',
        className,
      )}
      title="Copy"
    >
      <span className={wrap ? 'text-left break-all' : 'truncate'}>{label ?? value}</span>
      {done ? (
        <Check className="size-3 shrink-0 text-good-ink" aria-hidden />
      ) : (
        <Copy className="size-3 shrink-0 opacity-40 group-hover:opacity-100" aria-hidden />
      )}
    </button>
  );
}
export { Copy_ as CopyText };

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('animate-pulse rounded-md bg-surface-2', className)} />;
}

export function Empty({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <div className="mb-3 grid size-10 place-items-center rounded-full bg-surface-2 text-muted">
        <Icon className="size-5" aria-hidden />
      </div>
      <div className="text-[13px] font-medium text-ink">{title}</div>
      {children && <div className="mt-1 max-w-sm text-[12.5px] text-muted">{children}</div>}
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div className="flex items-start gap-2 rounded-lg border border-critical/30 bg-critical-soft px-3 py-2 text-[12.5px] text-critical-ink">
      <XCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span>{error instanceof Error ? error.message : String(error)}</span>
    </div>
  );
}

export function PageHeader({
  title,
  desc,
  actions,
}: {
  title: string;
  desc?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-[20px] font-semibold tracking-[-0.02em] text-ink">{title}</h1>
        {desc && <p className="mt-1 text-[13px] text-muted">{desc}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
