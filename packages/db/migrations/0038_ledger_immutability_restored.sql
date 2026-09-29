-- Posted financial records are structurally immutable (restored, and unified with the other agent's
-- hardening).
--
-- History: migration 0036/0037 introduced these guards; a parallel branch that was merged afterwards
-- deleted them and added search_path pinning for the balance trigger instead. Both intents are served
-- here: the immutability rules are restored, and the guard functions are hardened the same way the
-- balance trigger was — with an explicit search_path, so the maintenance check cannot be shadowed.
--
-- The documented lifecycle is preserved: entry_no/posted_by/posted_at are assigned once at posting,
-- a posted entry may only become REVERSED, and a reversed entry is final. Deliberate maintenance
-- (test teardown, ops purge) opts in explicitly with `SET LOCAL app.maintenance = 'on'`.

CREATE OR REPLACE FUNCTION app_ledger_maintenance() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('app.maintenance', true), 'off') = 'on' $$;

CREATE OR REPLACE FUNCTION app_forbid_journal_line_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF app_ledger_maintenance() THEN RETURN COALESCE(NEW, OLD); END IF;
  RAISE EXCEPTION 'journal lines are append-only (attempted % on line %)', TG_OP, COALESCE(OLD.id::text, '?')
    USING ERRCODE = 'check_violation',
          HINT = 'Correct a posted entry by posting a linked reversal, never by editing it.';
END $$;

CREATE OR REPLACE FUNCTION app_guard_journal_entry_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF app_ledger_maintenance() THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'journal entries cannot be deleted (entry %)', OLD.id
      USING ERRCODE = 'check_violation', HINT = 'Reverse the entry instead of deleting it.';
  END IF;
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
  IF OLD.entry_no IS NOT NULL AND NEW.entry_no IS DISTINCT FROM OLD.entry_no THEN
    RAISE EXCEPTION 'the entry number of a posted entry cannot change (entry %, % -> %)', OLD.id, OLD.entry_no, NEW.entry_no USING ERRCODE='check_violation';
  END IF;
  IF OLD.posted_at IS NOT NULL AND (NEW.posted_at IS DISTINCT FROM OLD.posted_at OR NEW.posted_by IS DISTINCT FROM OLD.posted_by) THEN
    RAISE EXCEPTION 'posting provenance of a posted entry cannot change (entry %)', OLD.id USING ERRCODE='check_violation';
  END IF;
  IF OLD.status = 'REVERSED' AND NEW.status IS DISTINCT FROM 'REVERSED' THEN
    RAISE EXCEPTION 'a reversed entry is final (entry %)', OLD.id USING ERRCODE='check_violation';
  END IF;
  IF OLD.status = 'POSTED' AND NEW.status NOT IN ('POSTED', 'REVERSED') THEN
    RAISE EXCEPTION 'a posted entry may only become REVERSED (entry %)', OLD.id USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app_forbid_audit_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF app_ledger_maintenance() THEN RETURN COALESCE(NEW, OLD); END IF;
  RAISE EXCEPTION 'the audit trail is append-only (attempted % on audit_logs)', TG_OP USING ERRCODE='check_violation';
END $$;

-- the other agent's hardening, applied to these guards too: an explicit search_path means the
-- maintenance check cannot be shadowed by a hostile or careless search_path
ALTER FUNCTION app_ledger_maintenance()           SET search_path = pg_catalog, public;
ALTER FUNCTION app_forbid_journal_line_change()   SET search_path = pg_catalog, public;
ALTER FUNCTION app_guard_journal_entry_change()   SET search_path = pg_catalog, public;
ALTER FUNCTION app_forbid_audit_change()          SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS trg_journal_lines_immutable ON journal_lines;
CREATE TRIGGER trg_journal_lines_immutable BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION app_forbid_journal_line_change();

DROP TRIGGER IF EXISTS trg_journal_entries_immutable ON journal_entries;
CREATE TRIGGER trg_journal_entries_immutable BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION app_guard_journal_entry_change();

DROP TRIGGER IF EXISTS trg_audit_logs_immutable ON audit_logs;
CREATE TRIGGER trg_audit_logs_immutable BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION app_forbid_audit_change();
