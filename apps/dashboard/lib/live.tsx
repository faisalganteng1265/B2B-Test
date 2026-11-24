'use client';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { qk } from './api';
import type { Overview } from './types';

export interface PricePoint {
  t: number;
  bid: number;
  ask: number;
  stale: boolean;
}

interface LiveState {
  connected: boolean;
  lastEventAt: number | null;
  priceHistory: PricePoint[];
  /** deposit ids changed recently (for row flash) */
  recentlyChanged: Set<string>;
}

const LiveCtx = createContext<LiveState>({
  connected: false,
  lastEventAt: null,
  priceHistory: [],
  recentlyChanged: new Set(),
});
export const useLive = () => useContext(LiveCtx);

/**
 * One EventSource per tab (→ Next route → API /v1/stream → Postgres LISTEN/NOTIFY).
 * `metrics` events replace the overview cache; deposit/run/payout events invalidate the lists and
 * the open deposit (debounced so a burst of 100 deposits is a handful of refetches).
 */
export function LiveProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const [priceHistory, setPriceHistory] = useState<PricePoint[]>([]);
  const [recentlyChanged, setRecentlyChanged] = useState<Set<string>>(new Set());
  const pending = useRef<Set<string>>(new Set());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const flush = () => {
      timer.current = null;
      const ids = [...pending.current];
      pending.current.clear();
      void qc.invalidateQueries({ queryKey: ['deposits'] });
      void qc.invalidateQueries({ queryKey: qk.ledger });
      void qc.invalidateQueries({ queryKey: qk.clients });
      for (const id of ids) void qc.invalidateQueries({ queryKey: qk.deposit(id) });
      setRecentlyChanged(new Set(ids));
    };

    const connect = () => {
      es = new EventSource('/api/stream');
      es.addEventListener('hello', () => setConnected(true));
      es.addEventListener('metrics', (e) => {
        setConnected(true);
        setLastEventAt(Date.now());
        const o = JSON.parse((e as MessageEvent).data) as Overview;
        qc.setQueryData(qk.overview, o);
        if (o.price) {
          const p = o.price;
          setPriceHistory((h) => {
            const point = {
              t: new Date(o.at).getTime(),
              bid: Number(p.bid),
              ask: Number(p.ask),
              stale: p.stale,
            };
            const last = h[h.length - 1];
            if (last && last.t === point.t) return h;
            return [...h, point].slice(-180);
          });
        }
      });
      for (const type of ['deposit', 'run', 'payout', 'indexer']) {
        es.addEventListener(type, (e) => {
          setLastEventAt(Date.now());
          try {
            const p = JSON.parse((e as MessageEvent).data) as { id?: string };
            if (p.id) pending.current.add(p.id);
          } catch {
            /* ignore */
          }
          if (type !== 'indexer' && !timer.current) timer.current = setTimeout(flush, 400);
        });
      }
      es.onerror = () => {
        setConnected(false);
        es?.close();
        if (!closed) retry = setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      closed = true;
      es?.close();
      if (retry) clearTimeout(retry);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [qc]);

  return (
    <LiveCtx.Provider value={{ connected, lastEventAt, priceHistory, recentlyChanged }}>
      {children}
    </LiveCtx.Provider>
  );
}
