/**
 * Cross-tenant isolation integration tests (real PostgreSQL).
 *
 * Proves the RLS strategy from Technical Implementation Plan §4 and the
 * PRD §20 acceptance criterion: "Two cooperatives with identical member
 * numbers cannot access, infer, export or reference each other's records,
 * including guessed UUIDs."
 *
 * Prerequisites: local Postgres running with the `coopengine` role/db and
 * migrations applied + `db:force-rls` executed.
 *
 * Run: pnpm --filter @coopengine/db test:integration
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createPool, withTenant } from '../src/client';

const pool: Pool = createPool(process.env.DATABASE_URL);

/**
 * Slugs this suite owns. Cleanup is deliberately scoped to them.
 *
 * This file used to run `TRUNCATE TABLE organizations CASCADE`, which deletes
 * EVERY cooperative in whatever database it is pointed at. In CI that is a
 * throwaway Postgres, but the same command run locally against the development
 * database wiped a working demo tenant — and against a shared or production
 * database it would destroy real customers. Scope cleanup to our own rows.
 */
const TEST_SLUGS = ['alpha-coop', 'beta-coop'];

async function clearTestOrgs(): Promise<void> {
  // FORCE RLS is on, so an unscoped DELETE silently matches nothing (and that is
  // the point of the strategy). Find our own rows using the internal-scan policy,
  // then delete each one inside its own tenant context.
  const client = await pool.connect();
  let ids: string[] = [];
  try {
    await client.query(`SELECT set_config('app.internal_scan', 'on', false)`);
    const found = await client.query(
      `SELECT id FROM organizations WHERE slug = ANY($1::text[])`,
      [TEST_SLUGS],
    );
    ids = found.rows.map((r) => (r as { id: string }).id);
    await client.query(`SELECT set_config('app.internal_scan', 'off', false)`);
  } finally {
    client.release();
  }
  for (const id of ids) {
    await withTenant(pool, id, async (c) => {
      await c.query('DELETE FROM organizations WHERE id = $1', [id]);
    });
  }
}

beforeAll(async () => {
  // Clean slate for THIS suite only — never for other tenants.
  await clearTestOrgs();
  const rls = await pool.query(
    `SELECT c.relname, c.relforcerowsecurity
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname IN ('organizations','branches','organization_settings')`,
  );
  const unprotected = rls.rows.filter((r) => !r.relforcerowsecurity);
  if (unprotected.length > 0) {
    throw new Error(
      `FORCE RLS not enabled for: ${unprotected.map((r) => r.relname).join(', ')}. ` +
        'Run `pnpm --filter @coopengine/db db:force-rls` first.',
    );
  }
});

afterAll(async () => {
  await clearTestOrgs();
  await pool.end();
});

describe('tenant isolation (RLS)', () => {
  it('two cooperatives cannot see each other’s records, including guessed UUIDs', async () => {
    const orgA = randomUUID();
    const orgB = randomUUID();

    // Tenant A onboarding: org row + head office + one branch
    await withTenant(pool, orgA, async (c) => {
      await c.query(
        `INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)`,
        [orgA, 'Cooperative Alpha', 'alpha-coop'],
      );
      await c.query(
        `INSERT INTO organization_settings (organization_id) VALUES ($1)`,
        [orgA],
      );
      await c.query(
        `INSERT INTO branches (organization_id, name, code, is_headquarters)
         VALUES ($1, $2, $3, true), ($1, $4, $5, false)`,
        [orgA, 'Alpha Head Office', 'HQA', 'Alpha Annex', 'ANX'],
      );
      const justInserted = await c.query(
        `SELECT count(*)::int AS n FROM branches WHERE organization_id = $1`,
        [orgA],
      );
      expect((justInserted.rows[0] as { n: number }).n).toBe(2);
    });

    // Tenant B onboarding: org row + one branch
    await withTenant(pool, orgB, async (c) => {
      await c.query(
        `INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)`,
        [orgB, 'Cooperative Beta', 'beta-coop'],
      );
      await c.query(
        `INSERT INTO organization_settings (organization_id) VALUES ($1)`,
        [orgB],
      );
      await c.query(
        `INSERT INTO branches (organization_id, name, code, is_headquarters)
         VALUES ($1, $2, $3, true)`,
        [orgB, 'Beta Head Office', 'HQB'],
      );
    });

    // Tenant A sees exactly its own branches
    await withTenant(pool, orgA, async (c) => {
      const { rows } = await c.query(
        `SELECT id, code FROM branches WHERE organization_id = $1 ORDER BY code`,
        [orgA],
      );
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => (r as { code: string }).code).sort()).toEqual(['ANX', 'HQA']);
    });

    // Tenant B sees exactly its own branch
    await withTenant(pool, orgB, async (c) => {
      const { rows } = await c.query(
        `SELECT id, code FROM branches WHERE organization_id = $1 ORDER BY code`,
        [orgB],
      );
      expect(rows).toHaveLength(1);
      expect(rows.map((r) => r.code)).toEqual(['HQB']);
    });

    // Tenant A cannot read tenant B's org row by guessed UUID
    await withTenant(pool, orgA, async (c) => {
      const { rows } = await c.query(
        `SELECT id, slug FROM organizations WHERE id = $1`,
        [orgB],
      );
      expect(rows).toHaveLength(0);
    });

    // Tenant B cannot read tenant A's settings row by guessed UUID
    await withTenant(pool, orgB, async (c) => {
      const { rows } = await c.query(
        `SELECT organization_id, currency FROM organization_settings WHERE organization_id = $1`,
        [orgA],
      );
      expect(rows).toHaveLength(0);
    });

    // A non-existent/foreign tenant context sees nothing
    // (deterministic equivalent of "no tenant context": the policy must
    // deny every row for any tenant UUID that does not own them)
    const NULL_TENANT = '00000000-0000-0000-0000-000000000000';
    await withTenant(pool, NULL_TENANT, async (c) => {
      const branches = await c.query(
        `SELECT count(*)::int AS n FROM branches`,
      );
      expect(branches.rows[0].n).toBe(0);
      const orgs = await c.query(
        `SELECT count(*)::int AS n FROM organizations`,
      );
      expect(orgs.rows[0].n).toBe(0);
    });

    // Full-table scan inside tenant A sees only tenant A rows
    await withTenant(pool, orgA, async (c) => {
      const { rows } = await c.query(`SELECT count(*)::int AS n FROM branches`);
      expect(rows[0].n).toBe(2);
    });
  });
});
