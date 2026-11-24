const idrFmt = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });
const numFmt = new Intl.NumberFormat('en-US');

/** Format an integer-rupiah string without going through float for large values. */
export function idr(v: string | null | undefined, withSymbol = true): string {
  if (v === null || v === undefined || v === '') return '—';
  const neg = v.startsWith('-');
  const digits = neg ? v.slice(1) : v;
  const grouped =
    digits.length > 15 ? digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.') : idrFmt.format(Number(digits));
  return `${neg ? '−' : ''}${withSymbol ? 'Rp ' : ''}${grouped}`;
}

/** Compact rupiah: Rp 16,2 jt / Rp 1,4 M */
export function idrCompact(v: string | null | undefined): string {
  if (!v) return '—';
  const n = Number(v);
  if (Math.abs(n) >= 1e12) return `Rp ${(n / 1e12).toLocaleString('id-ID', { maximumFractionDigits: 2 })} T`;
  if (Math.abs(n) >= 1e9) return `Rp ${(n / 1e9).toLocaleString('id-ID', { maximumFractionDigits: 2 })} M`;
  if (Math.abs(n) >= 1e6) return `Rp ${(n / 1e6).toLocaleString('id-ID', { maximumFractionDigits: 1 })} jt`;
  return idr(v);
}

export function rate(v: string | null | undefined): string {
  if (!v) return '—';
  const [i, f] = v.split('.');
  return `${idrFmt.format(Number(i))}${f ? ',' + f.slice(0, 2) : ''}`;
}

export function usdt(v: string | null | undefined): string {
  if (!v) return '—';
  const [i, f = ''] = v.split('.');
  const frac = f.replace(/0+$/, '').slice(0, 2);
  return `${numFmt.format(Number(i))}${frac ? '.' + frac.padEnd(2, '0') : '.00'}`;
}

/** Token base units (6dp) string → decimal string. */
export function fromBase(v: string, decimals = 6): string {
  const s = v.replace(/^-/, '').padStart(decimals + 1, '0');
  const out = `${s.slice(0, -decimals)}.${s.slice(-decimals)}`.replace(/\.?0+$/, '');
  return v.startsWith('-') ? `-${out}` : out;
}

export const num = (n: number | null | undefined) => (n === null || n === undefined ? '—' : numFmt.format(n));

export const short = (h: string, a = 6, b = 4) =>
  h.length > a + b + 2 ? `${h.slice(0, a)}…${h.slice(-b)}` : h;

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function duration(fromIso: string | null, toIso: string | null): string {
  if (!fromIso || !toIso) return '';
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export const time = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '—';

export const BANKS: Record<string, string> = { '002': 'BRI', '008': 'Mandiri', '009': 'BNI', '014': 'BCA' };
