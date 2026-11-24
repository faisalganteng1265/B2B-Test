'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChaosState, ClientRow, DepositDetail, Deposit, LedgerOverview, Overview } from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/proxy/${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = (body as { error?: { code?: string; message?: string } }).error;
    throw new ApiError(res.status, e?.code ?? `HTTP_${res.status}`, e?.message ?? res.statusText);
  }
  return body as T;
}

export const qk = {
  overview: ['overview'] as const,
  deposits: (status?: string) => ['deposits', status ?? 'all'] as const,
  deposit: (id: string) => ['deposit', id] as const,
  clients: ['clients'] as const,
  ledger: ['ledger'] as const,
  chaos: ['chaos'] as const,
};

export const useOverview = () =>
  useQuery({
    queryKey: qk.overview,
    queryFn: () => api<Overview>('admin/overview'),
    refetchInterval: 10_000,
  });
export const useDeposits = (status?: string) =>
  useQuery({
    queryKey: qk.deposits(status),
    queryFn: () =>
      api<{ data: Deposit[] }>(`admin/deposits?limit=300${status ? `&status=${status}` : ''}`).then(
        (r) => r.data,
      ),
    refetchInterval: 15_000,
  });
export const useDeposit = (id: string | null) =>
  useQuery({
    queryKey: qk.deposit(id ?? ''),
    queryFn: () => api<DepositDetail>(`admin/deposits/${id}`),
    enabled: !!id,
    refetchInterval: 5000,
  });
export const useClients = () =>
  useQuery({
    queryKey: qk.clients,
    queryFn: () => api<{ data: ClientRow[] }>('admin/clients').then((r) => r.data),
  });
export const useLedger = () =>
  useQuery({
    queryKey: qk.ledger,
    queryFn: () => api<LedgerOverview>('admin/ledger'),
    refetchInterval: 15_000,
  });
export const useChaos = () =>
  useQuery({
    queryKey: qk.chaos,
    queryFn: () =>
      api<{ mobee: ChaosState | { error: string }; bifast: ChaosState | { error: string } }>('admin/chaos'),
    refetchInterval: 3000,
  });

export function useRetryDeposit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ workflowKey: string }>(`admin/deposits/${id}/retry`, { method: 'POST' }),
    onSuccess: (_d, id) => {
      void qc.invalidateQueries({ queryKey: qk.deposit(id) });
      void qc.invalidateQueries({ queryKey: ['deposits'] });
    },
  });
}

export function useSendDemo() {
  return useMutation({
    mutationFn: (b: { clientId?: string; amount: string; count: number; randomize?: boolean }) =>
      api<{ results: { client: string; txs: { hash: string; explorerUrl: string | null }[] }[] }>(
        'admin/demo/deposits',
        {
          method: 'POST',
          body: JSON.stringify(b),
        },
      ),
  });
}

export function useSetChaos() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ target, patch }: { target: 'mobee' | 'bifast'; patch: Record<string, number> }) =>
      api<ChaosState>(`admin/chaos/${target}`, { method: 'POST', body: JSON.stringify(patch) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.chaos }),
  });
}
