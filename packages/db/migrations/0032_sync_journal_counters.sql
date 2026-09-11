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
