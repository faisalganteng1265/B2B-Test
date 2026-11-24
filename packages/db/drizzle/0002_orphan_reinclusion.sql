-- A tx dropped by a reorg is often re-included in the new canonical branch with the same
-- (tx_hash, log_index). Allow ONLY orphaned -> seen, so it must wait for finality again.
-- orphaned -> confirmed / dispatched stays illegal.
CREATE OR REPLACE FUNCTION deposits_transition_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT (
    (OLD.status = 'seen'          AND NEW.status IN ('confirmed', 'orphaned', 'manual_review')) OR
    (OLD.status = 'orphaned'      AND NEW.status = 'seen') OR
    (OLD.status = 'confirmed'     AND NEW.status IN ('dispatched', 'manual_review')) OR
    (OLD.status = 'dispatched'    AND NEW.status IN ('completed', 'failed', 'manual_review')) OR
    (OLD.status = 'manual_review' AND NEW.status IN ('dispatched', 'completed', 'failed'))
  ) THEN
    RAISE EXCEPTION 'illegal deposit transition % -> % (deposit %)', OLD.status, NEW.status, OLD.id;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
