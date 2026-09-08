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
];

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
} finally {
  await pool.end();
}
