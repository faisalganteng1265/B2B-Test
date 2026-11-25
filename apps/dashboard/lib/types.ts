export type DepositStatus =
  'seen' | 'confirmed' | 'dispatched' | 'orphaned' | 'completed' | 'failed' | 'manual_review';

export interface Price {
  symbol: string;
  source: string;
  bid: string;
  ask: string;
  last: string;
  stale: boolean;
  asOf: string;
  ageMs: number;
  feedError?: boolean;
  vwap?: { amount: string; rate: string; levelsUsed: number; slippageBps: string };
}

export interface IndexerStatus {
  chainHead: number | null;
  liveHead: number | null;
  lag: number | null;
  finalizedBoundary: number | null;
  finalizedCursor: number | null;
  reorgsDetected: number;
  lastReorgDepth: number | null;
  updatedAt: string | null;
  backfill: { chunks: number; done: number; running: number; pending: number; failed: number; pct: number };
}

export interface Overview {
  chain: { id: number; name: string };
  indexer: IndexerStatus;
  deposits: Partial<Record<DepositStatus, number>>;
  payoutsToday: { count: number; idr: string; since: string };
  alerts: {
    manualReview: {
      id: string;
      status: string;
      reason: string | null;
      at: string;
      txHash: string;
      incident: boolean;
    }[];
    retryAlerts: { entityId: string; data: { step: string; attempt: number; error: string }; at: string }[];
  };
  price: Price | null;
  at: string;
}

export interface Offramp {
  step: string;
  quoteId: string | null;
  rate: string | null;
  priceAsOf: string | null;
  priceSource: string | null;
  grossIdr: string | null;
  exchangeFeeIdr: string | null;
  feeIdr: string | null;
  idrAmount: string | null;
  exchangeOrderId: string | null;
  quoteAttempts: number;
  attempts: number;
  lastError: string | null;
  updatedAt: string;
}

export interface Deposit {
  id: string;
  chainId: number;
  clientId: string | null;
  clientName?: string | null;
  token: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  from: string;
  to: string;
  amount: string;
  status: DepositStatus;
  statusReason: string | null;
  source: 'live' | 'backfill';
  confirmations: number;
  workflowId: string;
  firstSeenAt: string;
  confirmedAt: string | null;
  dispatchedAt: string | null;
  completedAt: string | null;
  offramp: Offramp | null;
  explorerUrl?: string | null;
}

export interface TimelineStep {
  step: string;
  state: 'pending' | 'running' | 'done' | 'failed';
  attempts: number;
  retries: number;
  lastError: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface LedgerLine {
  id: number;
  journalId: string;
  account: string;
  currency: string;
  debit: string;
  credit: string;
  at: string;
}

export interface DepositDetail extends Deposit {
  timeline: TimelineStep[];
  events: { step: string; kind: string; attempt: number; error: string | null; at: string }[];
  payout: {
    id: string;
    status: string;
    amountIdr: string;
    bifastRef: string | null;
    idempotencyKey: string;
    failureReason: string | null;
    updatedAt: string;
  } | null;
  ledger: LedgerLine[];
  audit: { action: string; actor: string; data: unknown; at: string }[];
}

export interface ClientRow {
  id: string;
  name: string;
  status: string;
  subAccountId: string;
  apiKeyPrefix: string;
  sharedDepositAddress: string | null;
  wallets: { address: string; label: string | null; verifiedAt: string | null }[];
  depositAddresses: { chainId: number; address: string; source: string; current: boolean }[];
  bankAccounts: {
    id: string;
    bankCode: string;
    accountNumber: string;
    accountName: string;
    verifiedAt: string | null;
  }[];
  stats: { deposits: number; completed: number; volumeUsdt: string; paidOutIdr: string };
}

export interface LedgerOverview {
  balanced: boolean;
  unbalancedJournals: number;
  totals: { account: string; currency: string; debit: string; credit: string; balance: string }[];
  journals: {
    journalId: string;
    depositId: string | null;
    txHash: string | null;
    at: string;
    kind: string;
    balanced: boolean;
    lines: LedgerLine[];
  }[];
}

export interface ChaosConfig {
  FAIL_RATE: number;
  FAIL_AFTER_RATE: number;
  TIMEOUT_RATE: number;
  TIMEOUT_MS: number;
  LATENCY_MS_MIN: number;
  LATENCY_MS_MAX: number;
  DUPLICATE_CALLBACK_RATE: number;
  LATE_CALLBACK_MS: number;
  DROP_CALLBACK_RATE: number;
  FINAL_FAILURE_RATE: number;
}
export interface ChaosState {
  config: ChaosConfig;
  stats: { requests: number; failedBefore: number; failedAfter: number; timeouts: number };
}

export interface ExchangeView {
  depositAddress: string | null;
  network?: string;
  error?: string;
  account?: {
    canTrade: boolean;
    canWithdraw: boolean;
    canWithdrawFiat: boolean;
    accountType: string;
    uid: number;
    balances: { asset: string; free: string; locked: string }[];
  };
  bank?: { bankCode: string; accountNumber: string };
  sweeps: {
    id: string;
    amountIdr: string;
    feeIdr: string | null;
    status: string;
    exchangeOrderNo: string | null;
    createdAt: string;
    updatedAt: string;
  }[];
}
