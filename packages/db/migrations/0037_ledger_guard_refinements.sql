-- Refinements to migration 0036's immutability guards, after the test suite caught two mistakes:
--
--   1. entry_no/posted_by/posted_at are assigned at posting, and the reversal path assigns them in a
--      second statement — so "posted entries never change" was too strict. They may be SET ONCE
--      (from empty to a value); changing them afterwards is still refused.
--   2. the guards now name the offending field, so a refusal is diagnosable without reading source.
--   3. teardown and maintenance need a deliberate, explicit escape: `SET LOCAL app.maintenance = 'on'`.
--      No product code path sets it; tests and ops purge scripts do, and the act is visible in the
--      session. Ordinary application paths cannot purge the ledger or the audit trail.

CREATE OR REPLACE FUNCTION app_ledger_maintenance() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.maintenance', true), 'off') = 'on'
$$;

CREATE OR REPLACE FUNCTION app_guard_journal_entry_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF app_ledger_maintenance() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'journal entries cannot be deleted (entry %)', OLD.id
      USING ERRCODE = 'check_violation', HINT = 'Reverse the entry instead of deleting it.';
  END IF;

  -- frozen: what the entry means (reported by name)
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'posting a journal entry: organization_id is frozen (entry %)', OLD.id USING ERRCODE='check_violation';
  ELSIF NEW.period_id IS DISTINCT FROM OLD.period_id THEN
    RAISE EXCEPTION 'posting a journal entry: period_id is frozen (entry %)', OLD.id USING ERRCODE='check_violation';
  ELSIF NEW.entry_date IS DISTINCT FROM OLD.entry_date THEN
    RAISE EXCEPTION 'posting a journal entry: entry_date is frozen (entry %)', OLD.id USING ERRCODE='check_violation';
  ELSIF NEW.description IS DISTINCT FROM OLD.description THEN
    RAISE EXCEPTION 'posting a journal entry: description is frozen (entry %)', OLD.id USING ERRCODE='check_violation';
  ELSIF NEW.source IS DISTINCT FROM OLD.source THEN
    RAISE EXCEPTION 'posting a journal entry: source is frozen (entry %)', OLD.id USING ERRCODE='check_violation';
  ELSIF NEW.source_type IS DISTINCT FROM OLD.source_type THEN
    RAISE EXCEPTION 'posting a journal entry: source_type is frozen (entry %)', OLD.id USING ERRCODE='check_violation';
  ELSIF NEW.source_id IS DISTINCT FROM OLD.source_id THEN
    RAISE EXCEPTION 'posting a journal entry: source_id is frozen (entry %)', OLD.id USING ERRCODE='check_violation';
  ELSIF NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
    RAISE EXCEPTION 'posting a journal entry: idempotency_key is frozen (entry %)', OLD.id USING ERRCODE='check_violation';
  ELSIF NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'posting a journal entry: created_by is frozen (entry %)', OLD.id USING ERRCODE='check_violation';
  ELSIF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'posting a journal entry: created_at is frozen (entry %)', OLD.id USING ERRCODE='check_violation';
  ELSIF NEW.reversal_of_entry_id IS DISTINCT FROM OLD.reversal_of_entry_id THEN
    RAISE EXCEPTION 'posting a journal entry: reversal_of_entry_id is frozen (entry %)', OLD.id USING ERRCODE='check_violation';
  END IF;

  -- the entry number may be set once (at posting); after that it is fixed
  IF OLD.entry_no IS NOT NULL AND NEW.entry_no IS DISTINCT FROM OLD.entry_no THEN
    RAISE EXCEPTION 'the entry number of a posted entry cannot change (entry %, % -> %)', OLD.id, OLD.entry_no, NEW.entry_no
      USING ERRCODE = 'check_violation';
  END IF;

  -- posting provenance may be recorded once; after that it is fixed
  IF OLD.posted_at IS NOT NULL AND (NEW.posted_at IS DISTINCT FROM OLD.posted_at OR NEW.posted_by IS DISTINCT FROM OLD.posted_by) THEN
    RAISE EXCEPTION 'posting provenance of a posted entry cannot change (entry %)', OLD.id USING ERRCODE='check_violation';
  END IF;

  -- a reversed entry is final, and a posted entry may only become REVERSED
  IF OLD.status = 'REVERSED' AND NEW.status IS DISTINCT FROM 'REVERSED' THEN
    RAISE EXCEPTION 'a reversed entry is final (entry %)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'POSTED' AND NEW.status NOT IN ('POSTED', 'REVERSED') THEN
    RAISE EXCEPTION 'a posted entry may only become REVERSED (entry %)', OLD.id USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app_forbid_journal_line_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF app_ledger_maintenance() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'journal lines are append-only (attempted % on line %)', TG_OP, COALESCE(OLD.id::text, '?')
    USING ERRCODE = 'check_violation',
          HINT = 'Correct a posted entry by posting a linked reversal, never by editing it.';
END $$;

CREATE OR REPLACE FUNCTION app_forbid_audit_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF app_ledger_maintenance() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'the audit trail is append-only (attempted % on audit_logs)', TG_OP
    USING ERRCODE = 'check_violation';
END $$;

-- privileges: the triggers are the policy, so ordinary DML may stay granted (it will be refused by
-- the guard); TRUNCATE bypasses row triggers, so it stays revoked.
GRANT UPDATE, DELETE ON journal_entries TO coopengine;
GRANT DELETE ON audit_logs TO coopengine;
REVOKE TRUNCATE ON journal_lines, journal_entries, audit_logs FROM coopengine;
REVOKE TRUNCATE ON journal_lines, journal_entries, audit_logs FROM PUBLIC;
