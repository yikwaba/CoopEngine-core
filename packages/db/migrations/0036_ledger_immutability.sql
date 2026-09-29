-- Posted financial records become structurally immutable.
--
-- The PRD (business rules) and the master prompt (§16, §25) require that posted journals are
-- append-only and that corrections happen only through a linked reversal. Application discipline
-- alone was not enough — an unscoped DELETE once ran against live data — so the rule lives in the
-- database now.
--
-- The lifecycle the application legitimately needs is preserved:
--   entry_no is assigned at posting, status moves DRAFT -> SUBMITTED -> POSTED, and a posted entry
--   may become REVERSED (never anything else). Every other field is frozen, and REVERSED is final.

-- 1. Journal lines are append-only: no edits, no deletions.
CREATE OR REPLACE FUNCTION app_forbid_journal_line_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'journal lines are append-only (attempted % on journal_lines %)', TG_OP, COALESCE(OLD.id::text, '?')
    USING ERRCODE = 'check_violation',
          HINT = 'Correct a posted entry by posting a linked reversal, never by editing it.';
END $$;

DROP TRIGGER IF EXISTS trg_journal_lines_immutable ON journal_lines;
CREATE TRIGGER trg_journal_lines_immutable
  BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION app_forbid_journal_line_change();

-- 2. Journal entries: frozen except for the documented lifecycle.
CREATE OR REPLACE FUNCTION app_guard_journal_entry_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'journal entries cannot be deleted (entry %)', OLD.id
      USING ERRCODE = 'check_violation',
            HINT = 'Reverse the entry instead of deleting it.';
  END IF;

  -- what the entry means must never change
  IF NEW.organization_id   IS DISTINCT FROM OLD.organization_id
     OR NEW.period_id      IS DISTINCT FROM OLD.period_id
     OR NEW.entry_date     IS DISTINCT FROM OLD.entry_date
     OR NEW.description    IS DISTINCT FROM OLD.description
     OR NEW.source         IS DISTINCT FROM OLD.source
     OR NEW.source_type    IS DISTINCT FROM OLD.source_type
     OR NEW.source_id      IS DISTINCT FROM OLD.source_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.created_by     IS DISTINCT FROM OLD.created_by
     OR NEW.reversal_of_entry_id IS DISTINCT FROM OLD.reversal_of_entry_id
     OR NEW.created_at     IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'posted journal entries are immutable except for the posting lifecycle (entry %)', OLD.id
      USING ERRCODE = 'check_violation',
            HINT = 'Correct a posted entry by posting a linked reversal.';
  END IF;

  -- a reversed entry is final
  IF OLD.status = 'REVERSED' AND NEW.status IS DISTINCT FROM 'REVERSED' THEN
    RAISE EXCEPTION 'a reversed entry is final (entry %)', OLD.id USING ERRCODE = 'check_violation';
  END IF;

  -- out of POSTED the only permitted destination is REVERSED
  IF OLD.status = 'POSTED' AND NEW.status NOT IN ('POSTED', 'REVERSED') THEN
    RAISE EXCEPTION 'a posted entry may only become REVERSED (entry %)', OLD.id USING ERRCODE = 'check_violation';
  END IF;

  -- the entry number is allocated once, at posting
  IF OLD.status = 'POSTED' AND NEW.entry_no IS DISTINCT FROM OLD.entry_no THEN
    RAISE EXCEPTION 'the entry number of a posted entry cannot change (entry %)', OLD.id USING ERRCODE = 'check_violation';
  END IF;

  -- who posted it, and when, are set at posting and then fixed
  IF OLD.status = 'POSTED' AND (NEW.posted_by IS DISTINCT FROM OLD.posted_by OR NEW.posted_at IS DISTINCT FROM OLD.posted_at) THEN
    RAISE EXCEPTION 'posting provenance of a posted entry cannot change (entry %)', OLD.id USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_journal_entries_immutable ON journal_entries;
CREATE TRIGGER trg_journal_entries_immutable
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION app_guard_journal_entry_change();

-- 3. The audit trail cannot be rewritten by anyone using the application role.
CREATE OR REPLACE FUNCTION app_forbid_audit_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'the audit trail is append-only (attempted % on audit_logs)', TG_OP
    USING ERRCODE = 'check_violation';
END $$;

DROP TRIGGER IF EXISTS trg_audit_logs_immutable ON audit_logs;
CREATE TRIGGER trg_audit_logs_immutable
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION app_forbid_audit_change();

-- 4. Remove the privileges that would bypass the triggers (TRUNCATE does not fire row triggers).
REVOKE UPDATE, DELETE, TRUNCATE ON journal_lines FROM coopengine;
REVOKE DELETE, TRUNCATE ON journal_entries FROM coopengine;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM coopengine;
REVOKE UPDATE, DELETE, TRUNCATE ON journal_lines, journal_entries, audit_logs FROM PUBLIC;
