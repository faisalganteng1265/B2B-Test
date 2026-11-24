'use client';
import { useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import type { PricePoint } from '@/lib/live';
import type { DepositStatus } from '@/lib/types';
import { num, rate, time } from '@/lib/format';
import { STATUS, STATUS_ORDER } from './ui';

/** Single-series line (bid) with crosshair + tooltip. One series → no legend; the card title names it. */
export function PriceSparkline({ points, height = 120 }: { points: PricePoint[]; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const W = 600;
  const H = height;
  const PAD = 8;
  const geo = useMemo(() => {
    if (points.length < 2) return null;
    const vals = points.map((p) => p.bid);
    let min = Math.min(...vals);
    let max = Math.max(...vals);
    if (max - min < 4) {
      min -= 2;
      max += 2;
    }
    const x = (i: number) => (i / (points.length - 1)) * W;
    const y = (v: number) => PAD + (1 - (v - min) / (max - min)) * (H - PAD * 2);
    const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.bid).toFixed(1)}`).join(' ');
    const area = `${line} L${W},${H} L0,${H} Z`;
    return { min, max, x, y, line, area };
  }, [points, H]);

  if (!geo) {
    return (
      <div
        className="grid place-items-center rounded-lg bg-surface-2/50 text-[12px] text-muted"
        style={{ height }}
      >
        Collecting live price points…
      </div>
    );
  }
  const hp = hover !== null ? points[hover] : null;
  return (
    <div
      ref={ref}
      className="relative select-none"
      style={{ height }}
      onMouseMove={(e) => {
        const r = ref.current!.getBoundingClientRect();
        const i = Math.round(((e.clientX - r.left) / r.width) * (points.length - 1));
        setHover(Math.max(0, Math.min(points.length - 1, i)));
      }}
      onMouseLeave={() => setHover(null)}
      role="img"
      aria-label={`USDT/IDR bid, last ${points.length} readings, from ${rate(String(points[0]!.bid))} to ${rate(String(points[points.length - 1]!.bid))}`}
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full overflow-visible"
      >
        <defs>
          <linearGradient id="spark-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.16" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1="0"
            x2={W}
            y1={H * f}
            y2={H * f}
            stroke="var(--grid)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <path d={geo.area} fill="url(#spark-fill)" />
        <path
          d={geo.line}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {hover !== null && (
          <line
            x1={geo.x(hover)}
            x2={geo.x(hover)}
            y1="0"
            y2={H}
            stroke="var(--border-strong)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      {hp && hover !== null && (
        <>
          <div
            className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface bg-accent"
            style={{ left: `${(geo.x(hover) / W) * 100}%`, top: geo.y(hp.bid) }}
          />
          <div
            className="pointer-events-none absolute top-0 z-10 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-[11.5px] shadow-lg"
            style={{
              left: `${(geo.x(hover) / W) * 100}%`,
              transform: `translateX(${hover > points.length / 2 ? 'calc(-100% - 10px)' : '10px'})`,
            }}
          >
            <div className="text-muted">{time(new Date(hp.t).toISOString())}</div>
            <div className="tnum mt-0.5 font-semibold text-ink">Bid {rate(String(hp.bid))}</div>
            <div className="tnum text-ink-2">Ask {rate(String(hp.ask))}</div>
            {hp.stale && <div className="mt-0.5 text-warning-ink">stale reading</div>}
          </div>
        </>
      )}
      <div className="tnum pointer-events-none absolute right-0 top-0 text-[10.5px] text-muted">
        {rate(String(Math.round(geo.max)))}
      </div>
      <div className="tnum pointer-events-none absolute bottom-0 right-0 text-[10.5px] text-muted">
        {rate(String(Math.round(geo.min)))}
      </div>
    </div>
  );
}

/** Part-to-whole across deposit states: one stacked bar, 2px gaps, legend with counts, table toggle. */
export function StatusDistribution({ counts }: { counts: Partial<Record<DepositStatus, number>> }) {
  const [hover, setHover] = useState<DepositStatus | null>(null);
  const [table, setTable] = useState(false);
  const rows = STATUS_ORDER.map((s) => ({ s, n: counts[s] ?? 0 })).filter((r) => r.n > 0);
  const total = rows.reduce((a, r) => a + r.n, 0);
  if (!total)
    return (
      <div className="rounded-lg bg-surface-2/50 py-6 text-center text-[12px] text-muted">
        No deposits yet
      </div>
    );
  return (
    <div>
      <div
        className="flex h-3 w-full gap-[2px] overflow-hidden rounded"
        role="img"
        aria-label={rows.map((r) => `${STATUS[r.s].label} ${r.n}`).join(', ')}
      >
        {rows.map((r) => (
          <div
            key={r.s}
            className={clsx(
              'h-full transition-opacity first:rounded-l last:rounded-r',
              hover && hover !== r.s && 'opacity-35',
            )}
            style={{ width: `${(r.n / total) * 100}%`, minWidth: 4, background: STATUS[r.s].bar }}
            onMouseEnter={() => setHover(r.s)}
            onMouseLeave={() => setHover(null)}
            title={`${STATUS[r.s].label}: ${r.n} (${Math.round((r.n / total) * 100)}%)`}
          />
        ))}
      </div>
      {table ? (
        <table className="mt-3 w-full text-[12px]">
          <tbody>
            {rows.map((r) => (
              <tr key={r.s} className="border-b border-border last:border-0">
                <td className="py-1 text-ink-2">{STATUS[r.s].label}</td>
                <td className="tnum py-1 text-right text-ink">{num(r.n)}</td>
                <td className="tnum py-1 text-right text-muted">{((r.n / total) * 100).toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
          {rows.map((r) => {
            const Icon = STATUS[r.s].icon;
            return (
              <li
                key={r.s}
                className={clsx(
                  'flex items-center gap-1.5 text-[12px] transition-opacity',
                  hover && hover !== r.s && 'opacity-45',
                )}
                onMouseEnter={() => setHover(r.s)}
                onMouseLeave={() => setHover(null)}
              >
                <span className="size-2.5 rounded-sm" style={{ background: STATUS[r.s].bar }} aria-hidden />
                <Icon className="size-3 text-muted" aria-hidden />
                <span className="text-ink-2">{STATUS[r.s].label}</span>
                <span className="tnum font-medium text-ink">{num(r.n)}</span>
              </li>
            );
          })}
        </ul>
      )}
      <button
        type="button"
        onClick={() => setTable((t) => !t)}
        className="mt-2 text-[11.5px] text-muted underline-offset-2 hover:text-ink hover:underline"
      >
        {table ? 'Show legend' : 'Show as table'}
      </button>
    </div>
  );
}

export function Meter({
  pct,
  tone = 'accent',
  label,
}: {
  pct: number;
  tone?: 'accent' | 'good' | 'warning';
  label?: string;
}) {
  const p = Math.max(0, Math.min(100, pct));
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3"
      role="meter"
      aria-valuenow={p}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div
        className={clsx(
          'h-full rounded-full transition-[width] duration-500',
          tone === 'accent' && 'bg-accent',
          tone === 'good' && 'bg-good',
          tone === 'warning' && 'bg-warning',
        )}
        style={{ width: `${p}%` }}
      />
    </div>
  );
}
