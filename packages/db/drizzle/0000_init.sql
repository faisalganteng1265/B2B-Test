CREATE TYPE "public"."block_status" AS ENUM('canonical', 'orphaned');--> statement-breakpoint
CREATE TYPE "public"."chunk_status" AS ENUM('pending', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."client_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."deposit_status" AS ENUM('seen', 'confirmed', 'dispatched', 'orphaned', 'completed', 'failed', 'manual_review');--> statement-breakpoint
CREATE TYPE "public"."ledger_account" AS ENUM('client_usdt_liability', 'exchange_usdt', 'exchange_idr', 'client_idr_payable', 'bank_out', 'fee_revenue');--> statement-breakpoint
CREATE TYPE "public"."offramp_step" AS ENUM('load-deposit', 'record-received', 'wait-exchange-credit', 'lock-quote', 'confirm-swap', 'record-swap', 'account-inquiry', 'create-payout', 'await-payout-result', 'finalize', 'completed', 'manual_review');--> statement-breakpoint
CREATE TYPE "public"."payout_status" AS ENUM('pending', 'success', 'failed');--> statement-breakpoint
CREATE TYPE "public"."step_event_kind" AS ENUM('started', 'succeeded', 'failed', 'retrying');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text NOT NULL,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backfill_chunks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"from_block" bigint NOT NULL,
	"to_block" bigint NOT NULL,
	"status" "chunk_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"locked_by" text,
	"locked_until" timestamp with time zone,
	"last_error" text,
	"logs_found" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chain_blocks" (
	"chain_id" integer NOT NULL,
	"number" bigint NOT NULL,
	"hash" text NOT NULL,
	"parent_hash" text NOT NULL,
	"timestamp" bigint NOT NULL,
	"status" "block_status" DEFAULT 'canonical' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chain_blocks_chain_id_hash_pk" PRIMARY KEY("chain_id","hash")
);
--> statement-breakpoint
CREATE TABLE "client_bank_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"bank_code" text NOT NULL,
	"account_number" text NOT NULL,
	"account_name" text NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"api_key_hash" text NOT NULL,
	"api_key_salt" text NOT NULL,
	"api_key_prefix" text NOT NULL,
	"status" "client_status" DEFAULT 'active' NOT NULL,
	"exchange_subaccount" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clients_api_key_hash_unique" UNIQUE("api_key_hash")
);
--> statement-breakpoint
CREATE TABLE "deposit_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"chain_id" integer NOT NULL,
	"address" text NOT NULL,
	"source" text DEFAULT 'mobee' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deposits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain_id" integer NOT NULL,
	"token_address" text NOT NULL,
	"token_symbol" text NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"block_number" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"from_address" text NOT NULL,
	"to_address" text NOT NULL,
	"amount_base_units" numeric(78, 0) NOT NULL,
	"client_id" uuid NOT NULL,
	"status" "deposit_status" DEFAULT 'seen' NOT NULL,
	"source" text NOT NULL,
	"confirmations" integer DEFAULT 0 NOT NULL,
	"workflow_id" text NOT NULL,
	"dispatch_attempts" integer DEFAULT 0 NOT NULL,
	"last_dispatch_error" text,
	"status_reason" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"dispatched_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "indexer_checkpoints" (
	"chain_id" integer PRIMARY KEY NOT NULL,
	"live_head_number" bigint NOT NULL,
	"live_head_hash" text NOT NULL,
	"finalized_cursor" bigint NOT NULL,
	"chain_head" bigint,
	"finalized_boundary" bigint,
	"reorgs_detected" integer DEFAULT 0 NOT NULL,
	"last_reorg_depth" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"journal_id" text NOT NULL,
	"account" "ledger_account" NOT NULL,
	"currency" text NOT NULL,
	"debit" numeric(78, 0) DEFAULT 0 NOT NULL,
	"credit" numeric(78, 0) DEFAULT 0 NOT NULL,
	"deposit_id" uuid,
	"memo" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_journals" (
	"id" text PRIMARY KEY NOT NULL,
	"deposit_id" uuid,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offramp_runs" (
	"deposit_id" uuid PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"step" "offramp_step" NOT NULL,
	"quote_id" text,
	"rate_scaled" numeric(38, 0),
	"price_as_of" timestamp with time zone,
	"price_source" text,
	"gross_idr" bigint,
	"fee_idr" bigint,
	"idr_amount" bigint,
	"exchange_order_id" text,
	"payout_id" uuid,
	"quote_attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offramp_runs_workflow_id_unique" UNIQUE("workflow_id")
);
--> statement-breakpoint
CREATE TABLE "offramp_step_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"deposit_id" uuid NOT NULL,
	"step" "offramp_step" NOT NULL,
	"kind" "step_event_kind" NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"error" text,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deposit_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"amount_idr" bigint NOT NULL,
	"status" "payout_status" DEFAULT 'pending' NOT NULL,
	"bifast_ref" text,
	"awakeable_id" text,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payouts_deposit_id_unique" UNIQUE("deposit_id"),
	CONSTRAINT "payouts_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"signature_valid" boolean NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_events_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
ALTER TABLE "client_bank_accounts" ADD CONSTRAINT "client_bank_accounts_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_addresses" ADD CONSTRAINT "deposit_addresses_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_deposit_id_deposits_id_fk" FOREIGN KEY ("deposit_id") REFERENCES "public"."deposits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_journals" ADD CONSTRAINT "ledger_journals_deposit_id_deposits_id_fk" FOREIGN KEY ("deposit_id") REFERENCES "public"."deposits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offramp_runs" ADD CONSTRAINT "offramp_runs_deposit_id_deposits_id_fk" FOREIGN KEY ("deposit_id") REFERENCES "public"."deposits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offramp_step_events" ADD CONSTRAINT "offramp_step_events_deposit_id_deposits_id_fk" FOREIGN KEY ("deposit_id") REFERENCES "public"."deposits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_deposit_id_deposits_id_fk" FOREIGN KEY ("deposit_id") REFERENCES "public"."deposits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_bank_account_id_client_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."client_bank_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "backfill_chunks_range_uq" ON "backfill_chunks" USING btree ("chain_id","from_block","to_block");--> statement-breakpoint
CREATE INDEX "backfill_chunks_claim_idx" ON "backfill_chunks" USING btree ("chain_id","status");--> statement-breakpoint
CREATE INDEX "chain_blocks_chain_number_idx" ON "chain_blocks" USING btree ("chain_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "chain_blocks_one_canonical_uq" ON "chain_blocks" USING btree ("chain_id","number") WHERE status = 'canonical';--> statement-breakpoint
CREATE UNIQUE INDEX "deposit_addresses_chain_address_uq" ON "deposit_addresses" USING btree ("chain_id","address");--> statement-breakpoint
CREATE UNIQUE INDEX "deposits_chain_tx_log_uq" ON "deposits" USING btree ("chain_id","tx_hash","log_index");--> statement-breakpoint
CREATE UNIQUE INDEX "deposits_workflow_id_uq" ON "deposits" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "deposits_status_idx" ON "deposits" USING btree ("status");--> statement-breakpoint
CREATE INDEX "deposits_block_hash_idx" ON "deposits" USING btree ("chain_id","block_hash");--> statement-breakpoint
CREATE INDEX "deposits_client_idx" ON "deposits" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_journal_idx" ON "ledger_entries" USING btree ("journal_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_deposit_idx" ON "ledger_entries" USING btree ("deposit_id");--> statement-breakpoint
CREATE INDEX "offramp_step_events_deposit_idx" ON "offramp_step_events" USING btree ("deposit_id","id");