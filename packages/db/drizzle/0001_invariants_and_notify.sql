-- Ledger invariants -----------------------------------------------------------
-- Each entry is one-sided and non-negative.
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_one_sided_chk"
  CHECK (debit >= 0 AND credit >= 0 AND (debit = 0) <> (credit = 0));
--> statement-breakpoint

-- Every journal must balance per currency. Deferred to COMMIT so a journal can be
-- inserted as several rows inside one transaction.
CREATE OR REPLACE FUNCTION ledger_check_balance() RETURNS trigger AS $$
DECLARE
  bad record;
BEGIN
  SELECT currency, sum(debit) AS d, sum(credit) AS c INTO bad
    FROM ledger_entries WHERE journal_id = NEW.journal_id
    GROUP BY currency HAVING sum(debit) <> sum(credit) LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'unbalanced journal % (%: debit % credit %)', NEW.journal_id, bad.currency, bad.d, bad.c;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_balance_trg AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_balance();
--> statement-breakpoint

-- Ledger is append-only.
CREATE OR REPLACE FUNCTION ledger_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only';
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER ledger_append_only_trg BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint

-- Deposit state machine guard (defense in depth) -------------------------------
-- seen -> confirmed -> dispatched -> completed | failed | manual_review
-- seen -> orphaned ; confirmed/dispatched -> manual_review (reorg incident)
-- orphaned is terminal: a reorged deposit can never be confirmed or dispatched.
CREATE OR REPLACE FUNCTION deposits_transition_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT (
    (OLD.status = 'seen'          AND NEW.status IN ('confirmed', 'orphaned', 'manual_review')) OR
    (OLD.status = 'confirmed'     AND NEW.status IN ('dispatched', 'manual_review')) OR
    (OLD.status = 'dispatched'    AND NEW.status IN ('completed', 'failed', 'manual_review')) OR
    (OLD.status = 'manual_review' AND NEW.status IN ('dispatched', 'completed', 'failed'))
  ) THEN
    RAISE EXCEPTION 'illegal deposit transition % -> % (deposit %)', OLD.status, NEW.status, OLD.id;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER deposits_transition_guard_trg BEFORE UPDATE OF status ON deposits
  FOR EACH ROW EXECUTE FUNCTION deposits_transition_guard();
--> statement-breakpoint

-- Realtime notifications for SSE (LISTEN mopay_events) -------------------------
CREATE OR REPLACE FUNCTION mopay_notify() RETURNS trigger AS $$
DECLARE
  payload json;
BEGIN
  IF TG_TABLE_NAME = 'deposits' THEN
    payload := json_build_object('type', 'deposit', 'id', NEW.id, 'status', NEW.status);
  ELSIF TG_TABLE_NAME = 'offramp_runs' THEN
    payload := json_build_object('type', 'run', 'id', NEW.deposit_id, 'step', NEW.step);
  ELSIF TG_TABLE_NAME = 'payouts' THEN
    payload := json_build_object('type', 'payout', 'id', NEW.deposit_id, 'status', NEW.status);
  ELSIF TG_TABLE_NAME = 'indexer_checkpoints' THEN
    payload := json_build_object('type', 'indexer', 'chainId', NEW.chain_id);
  ELSE
    payload := json_build_object('type', TG_TABLE_NAME);
  END IF;
  PERFORM pg_notify('mopay_events', payload::text);
  RETURN NULL;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER deposits_notify_trg AFTER INSERT OR UPDATE ON deposits
  FOR EACH ROW EXECUTE FUNCTION mopay_notify();
--> statement-breakpoint
CREATE TRIGGER offramp_runs_notify_trg AFTER INSERT OR UPDATE ON offramp_runs
  FOR EACH ROW EXECUTE FUNCTION mopay_notify();
--> statement-breakpoint
CREATE TRIGGER payouts_notify_trg AFTER INSERT OR UPDATE ON payouts
  FOR EACH ROW EXECUTE FUNCTION mopay_notify();
--> statement-breakpoint
CREATE TRIGGER indexer_checkpoints_notify_trg AFTER INSERT OR UPDATE ON indexer_checkpoints
  FOR EACH ROW EXECUTE FUNCTION mopay_notify();
