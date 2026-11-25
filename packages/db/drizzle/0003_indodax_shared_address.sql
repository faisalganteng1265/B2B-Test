ALTER TYPE "public"."ledger_account" ADD VALUE 'mopay_bank_idr';--> statement-breakpoint
ALTER TYPE "public"."ledger_account" ADD VALUE 'withdraw_fee_expense';--> statement-breakpoint
CREATE TABLE "client_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"chain_id" integer NOT NULL,
	"address" text NOT NULL,
	"label" text,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "treasury_sweeps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_request_id" text NOT NULL,
	"amount_idr" bigint NOT NULL,
	"fee_idr" bigint,
	"exchange_order_no" text,
	"status" text DEFAULT 'requested' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "treasury_sweeps_client_request_id_unique" UNIQUE("client_request_id")
);
--> statement-breakpoint
ALTER TABLE "deposit_addresses" ALTER COLUMN "client_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "deposits" ALTER COLUMN "client_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "deposit_addresses" ADD COLUMN "kind" text DEFAULT 'client' NOT NULL;--> statement-breakpoint
ALTER TABLE "offramp_runs" ADD COLUMN "exchange_fee_idr" bigint;--> statement-breakpoint
ALTER TABLE "client_wallets" ADD CONSTRAINT "client_wallets_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "client_wallets_chain_address_uq" ON "client_wallets" USING btree ("chain_id","address");--> statement-breakpoint
ALTER TABLE "deposit_addresses" ADD CONSTRAINT "deposit_addresses_kind_chk"
  CHECK ((kind = 'client' AND client_id IS NOT NULL) OR (kind = 'shared' AND client_id IS NULL));
--> statement-breakpoint
-- A deposit whose sender is not a registered client wallet can never be confirmed or dispatched.
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_unattributed_chk"
  CHECK (client_id IS NOT NULL OR status IN ('seen', 'orphaned', 'manual_review'));
