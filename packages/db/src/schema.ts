import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/*
 * Money rule: token amounts are numeric(78,0) in base units (6 decimals for USDT/USDC),
 * rupiah amounts are bigint whole rupiah. No floats anywhere. Rates are stored as
 * numeric(38,0) "IDR per 1 whole token, scaled by 1e6" (see @mopay/shared money.ts).
 */
const tokenAmount = (name: string) => numeric(name, { precision: 78, scale: 0, mode: 'bigint' });
const idr = (name: string) => bigint(name, { mode: 'bigint' });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const now = (name: string) => ts(name).notNull().defaultNow();

export const clientStatus = pgEnum('client_status', ['active', 'suspended']);
export const blockStatus = pgEnum('block_status', ['canonical', 'orphaned']);
export const chunkStatus = pgEnum('chunk_status', ['pending', 'running', 'done', 'failed']);
export const depositStatus = pgEnum('deposit_status', [
  'seen',
  'confirmed',
  'dispatched',
  'orphaned',
  'completed',
  'failed',
  'manual_review',
]);
export const offrampStep = pgEnum('offramp_step', [
  'load-deposit',
  'record-received',
  'wait-exchange-credit',
  'lock-quote',
  'confirm-swap',
  'record-swap',
  'account-inquiry',
  'create-payout',
  'await-payout-result',
  'finalize',
  'completed',
  'manual_review',
]);
export const stepEventKind = pgEnum('step_event_kind', ['started', 'succeeded', 'failed', 'retrying']);
export const payoutStatus = pgEnum('payout_status', ['pending', 'success', 'failed']);
export const ledgerAccount = pgEnum('ledger_account', [
  'client_usdt_liability',
  'exchange_usdt',
  'exchange_idr',
  'client_idr_payable',
  'bank_out',
  'fee_revenue',
]);

export const clients = pgTable('clients', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  /** sha256(salt || key) hex; the plaintext key is shown once at creation. */
  apiKeyHash: text('api_key_hash').notNull().unique(),
  apiKeySalt: text('api_key_salt').notNull(),
  apiKeyPrefix: text('api_key_prefix').notNull(),
  status: clientStatus('status').notNull().default('active'),
  /** Mobee sub-account id holding this client's crypto. */
  exchangeSubaccount: text('exchange_subaccount').notNull(),
  createdAt: now('created_at'),
});

export const clientBankAccounts = pgTable('client_bank_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id')
    .notNull()
    .references(() => clients.id),
  bankCode: text('bank_code').notNull(),
  accountNumber: text('account_number').notNull(),
  accountName: text('account_name').notNull(),
  verifiedAt: ts('verified_at'),
  createdAt: now('created_at'),
});

export const depositAddresses = pgTable(
  'deposit_addresses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    chainId: integer('chain_id').notNull(),
    /** Lowercased 0x address. */
    address: text('address').notNull(),
    source: text('source').notNull().default('mobee'),
    createdAt: now('created_at'),
  },
  (t) => [uniqueIndex('deposit_addresses_chain_address_uq').on(t.chainId, t.address)],
);

export const chainBlocks = pgTable(
  'chain_blocks',
  {
    chainId: integer('chain_id').notNull(),
    number: bigint('number', { mode: 'number' }).notNull(),
    hash: text('hash').notNull(),
    parentHash: text('parent_hash').notNull(),
    timestamp: bigint('timestamp', { mode: 'number' }).notNull(),
    status: blockStatus('status').notNull().default('canonical'),
    createdAt: now('created_at'),
  },
  (t) => [
    primaryKey({ columns: [t.chainId, t.hash] }),
    index('chain_blocks_chain_number_idx').on(t.chainId, t.number),
    // At most one canonical block per height.
    uniqueIndex('chain_blocks_one_canonical_uq')
      .on(t.chainId, t.number)
      .where(sql`status = 'canonical'`),
  ],
);

export const indexerCheckpoints = pgTable('indexer_checkpoints', {
  chainId: integer('chain_id').primaryKey(),
  liveHeadNumber: bigint('live_head_number', { mode: 'number' }).notNull(),
  liveHeadHash: text('live_head_hash').notNull(),
  /** Highest block below which everything is covered (live or backfill) and final. */
  finalizedCursor: bigint('finalized_cursor', { mode: 'number' }).notNull(),
  chainHead: bigint('chain_head', { mode: 'number' }),
  finalizedBoundary: bigint('finalized_boundary', { mode: 'number' }),
  reorgsDetected: integer('reorgs_detected').notNull().default(0),
  lastReorgDepth: integer('last_reorg_depth'),
  updatedAt: now('updated_at'),
});

export const backfillChunks = pgTable(
  'backfill_chunks',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    chainId: integer('chain_id').notNull(),
    fromBlock: bigint('from_block', { mode: 'number' }).notNull(),
    toBlock: bigint('to_block', { mode: 'number' }).notNull(),
    status: chunkStatus('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lockedBy: text('locked_by'),
    lockedUntil: ts('locked_until'),
    lastError: text('last_error'),
    logsFound: integer('logs_found').notNull().default(0),
    updatedAt: now('updated_at'),
  },
  (t) => [
    uniqueIndex('backfill_chunks_range_uq').on(t.chainId, t.fromBlock, t.toBlock),
    index('backfill_chunks_claim_idx').on(t.chainId, t.status),
  ],
);

export const deposits = pgTable(
  'deposits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chainId: integer('chain_id').notNull(),
    tokenAddress: text('token_address').notNull(),
    tokenSymbol: text('token_symbol').notNull(),
    txHash: text('tx_hash').notNull(),
    logIndex: integer('log_index').notNull(),
    blockNumber: bigint('block_number', { mode: 'number' }).notNull(),
    blockHash: text('block_hash').notNull(),
    fromAddress: text('from_address').notNull(),
    toAddress: text('to_address').notNull(),
    amountBaseUnits: tokenAmount('amount_base_units').notNull(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    status: depositStatus('status').notNull().default('seen'),
    /** Which indexer path found it first: live | backfill. */
    source: text('source').notNull(),
    confirmations: integer('confirmations').notNull().default(0),
    workflowId: text('workflow_id').notNull(),
    dispatchAttempts: integer('dispatch_attempts').notNull().default(0),
    lastDispatchError: text('last_dispatch_error'),
    statusReason: text('status_reason'),
    firstSeenAt: now('first_seen_at'),
    confirmedAt: ts('confirmed_at'),
    dispatchedAt: ts('dispatched_at'),
    completedAt: ts('completed_at'),
    updatedAt: now('updated_at'),
  },
  (t) => [
    uniqueIndex('deposits_chain_tx_log_uq').on(t.chainId, t.txHash, t.logIndex),
    uniqueIndex('deposits_workflow_id_uq').on(t.workflowId),
    index('deposits_status_idx').on(t.status),
    index('deposits_block_hash_idx').on(t.chainId, t.blockHash),
    index('deposits_client_idx').on(t.clientId),
  ],
);

export const offrampRuns = pgTable('offramp_runs', {
  depositId: uuid('deposit_id')
    .primaryKey()
    .references(() => deposits.id),
  workflowId: text('workflow_id').notNull().unique(),
  step: offrampStep('step').notNull(),
  quoteId: text('quote_id'),
  /** IDR per 1 token, scaled 1e6 (integer). */
  rateScaled: numeric('rate_scaled', { precision: 38, scale: 0, mode: 'bigint' }),
  priceAsOf: ts('price_as_of'),
  priceSource: text('price_source'),
  grossIdr: idr('gross_idr'),
  feeIdr: idr('fee_idr'),
  idrAmount: idr('idr_amount'),
  exchangeOrderId: text('exchange_order_id'),
  payoutId: uuid('payout_id'),
  quoteAttempts: integer('quote_attempts').notNull().default(0),
  lastError: text('last_error'),
  attempts: integer('attempts').notNull().default(0),
  startedAt: now('started_at'),
  updatedAt: now('updated_at'),
});

/** Timeline of workflow step transitions (one row per transition), for the dashboard. */
export const offrampStepEvents = pgTable(
  'offramp_step_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    depositId: uuid('deposit_id')
      .notNull()
      .references(() => deposits.id),
    step: offrampStep('step').notNull(),
    kind: stepEventKind('kind').notNull(),
    attempt: integer('attempt').notNull().default(1),
    error: text('error'),
    data: jsonb('data'),
    createdAt: now('created_at'),
  },
  (t) => [index('offramp_step_events_deposit_idx').on(t.depositId, t.id)],
);

export const payouts = pgTable('payouts', {
  id: uuid('id').primaryKey().defaultRandom(),
  depositId: uuid('deposit_id')
    .notNull()
    .unique()
    .references(() => deposits.id),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  bankAccountId: uuid('bank_account_id')
    .notNull()
    .references(() => clientBankAccounts.id),
  amountIdr: idr('amount_idr').notNull(),
  status: payoutStatus('status').notNull().default('pending'),
  bifastRef: text('bifast_ref'),
  /** Restate awakeable id the workflow is waiting on. */
  awakeableId: text('awakeable_id'),
  failureReason: text('failure_reason'),
  createdAt: now('created_at'),
  updatedAt: now('updated_at'),
});

export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /** Deterministic per (deposit, purpose) so re-running a step cannot double-post. */
    journalId: text('journal_id').notNull(),
    account: ledgerAccount('account').notNull(),
    currency: text('currency').notNull(),
    debit: tokenAmount('debit').notNull().default(sql`0`),
    credit: tokenAmount('credit').notNull().default(sql`0`),
    depositId: uuid('deposit_id').references(() => deposits.id),
    memo: text('memo'),
    createdAt: now('created_at'),
  },
  (t) => [
    index('ledger_entries_journal_idx').on(t.journalId),
    index('ledger_entries_deposit_idx').on(t.depositId),
  ],
);

/** One row per posted journal; PK makes posting a journal idempotent. */
export const ledgerJournals = pgTable('ledger_journals', {
  id: text('id').primaryKey(),
  depositId: uuid('deposit_id').references(() => deposits.id),
  kind: text('kind').notNull(),
  createdAt: now('created_at'),
});

export const webhookEvents = pgTable('webhook_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  source: text('source').notNull(),
  externalId: text('external_id').notNull().unique(),
  payload: jsonb('payload').notNull(),
  signatureValid: boolean('signature_valid').notNull(),
  processedAt: ts('processed_at'),
  createdAt: now('created_at'),
});

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    entityId: text('entity_id').notNull(),
    data: jsonb('data'),
    createdAt: now('created_at'),
  },
  (t) => [index('audit_log_entity_idx').on(t.entity, t.entityId)],
);
