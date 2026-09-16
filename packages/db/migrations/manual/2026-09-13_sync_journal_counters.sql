-- Co-opEngine — one-off data repair (NOT a drizzle-managed migration).
-- Applied to the development database on 13 Sep 2026 while fixing the journal-numbering
-- fault: the opening-balance import allocated entry numbers without advancing
-- org_counters.journal_seq, so the next deposit or repayment collided with a number the
-- batch already held. The permanent fix is in code (opening-balances.service.ts now uses
-- the same atomic allocator as every other money path); this statement reconciles
-- cooperatives that were migrated before that fix, and is safe to re-run.
--
-- Kept out of the numbered sequence on purpose: it carries no schema change and was applied
-- by hand, so drizzle-kit must not treat it as a journaled migration.

-- Reconcile org_counters.journal_seq with the highest entry number actually used.
--
-- The opening-balance migration allocated journal numbers with max(entry_no)+1 and
-- never advanced org_counters, so any organisation that imported balances could have
-- a counter behind its entries — and the next money operation would collide with an
-- existing journal entry (unique constraint on organization_id + entry_no).
--
-- Forward-only and idempotent: GREATEST() means it can never lower a counter.
UPDATE org_counters c
   SET journal_seq = GREATEST(
         c.journal_seq,
         COALESCE(
           (SELECT MAX(e.entry_no) FROM journal_entries e
             WHERE e.organization_id = c.organization_id),
           0
         )
       ),
       updated_at = now()
 WHERE c.journal_seq < COALESCE(
         (SELECT MAX(e.entry_no) FROM journal_entries e
           WHERE e.organization_id = c.organization_id),
         0
       );
