#!/usr/bin/env node
/**
 * Force Row-Level Security on tenant-owned tables.
 *
 * Table owners bypass RLS unless FORCE is set. Local dev connects as the
 * table owner (`coopengine`), so without FORCE the isolation tests would be
 * meaningless. Supabase production applies the same discipline: the app
 * connects as a non-owner role and every table has FORCE RLS.
 *
 * Idempotent — safe to run repeatedly.
 *
 * Usage: DATABASE_URL=... node scripts/force-rls.mjs
 */
import pg from 'pg';

const { Pool } = pg;

const TABLES = [
  'organizations',
  'organization_settings',
  'branches',
  'members',
  'next_of_kin',
  'org_counters',
  'import_batches',
  'chart_of_accounts',
  'ledger_periods',
  'journal_entries',
  'journal_lines',
  'savings_products',
  'member_savings_accounts',
  'savings_transactions',
  'loan_products',
  'loans',
  'loan_guarantors',
  'loan_repayments',
  'member_share_accounts',
  'share_transactions',
  'payroll_batches',
  'member_otps',
];

const BALANCED_JOURNAL_SQL = `
CREATE OR REPLACE FUNCTION assert_balanced_journal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  bad bigint;
BEGIN
  SELECT count(*)
    INTO bad
    FROM (
      SELECT jl.journal_entry_id
        FROM journal_lines jl
       GROUP BY jl.journal_entry_id
      HAVING count(*) < 2
          OR sum(jl.debit) <> sum(jl.credit)
          OR sum(jl.debit) <= 0
    ) unbalanced;
  IF bad > 0 THEN
    RAISE EXCEPTION 'journal_imbalance: every entry needs >= 2 lines with equal nonzero debits and credits';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_journal_lines_balanced ON journal_lines;
CREATE TRIGGER trg_journal_lines_balanced
AFTER INSERT OR UPDATE OR DELETE ON journal_lines
FOR EACH STATEMENT
EXECUTE FUNCTION assert_balanced_journal();
`;

const url =
  process.env.DATABASE_URL ??
  'postgres://coopengine:coopengine@127.0.0.1:5432/coopengine';

const pool = new Pool({ connectionString: url });

try {
  for (const table of TABLES) {
    await pool.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    console.log(`FORCE RLS: ${table}`);
  }
  const check = await pool.query(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY($1)`,
    [TABLES],
  );
  for (const row of check.rows) {
    console.log(
      `state: ${row.relname} rls=${row.relrowsecurity} force=${row.relforcerowsecurity}`,
    );
  }
  await pool.query(BALANCED_JOURNAL_SQL);
  const trg = await pool.query(
    `SELECT tgname FROM pg_trigger WHERE tgname = 'trg_journal_lines_balanced'`,
  );
  console.log(
    `balanced-journal trigger: ${trg.rows.length > 0 ? 'installed' : 'MISSING'}`,
  );
} finally {
  await pool.end();
}
