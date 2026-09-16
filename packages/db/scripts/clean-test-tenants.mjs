#!/usr/bin/env node
/**
 * Remove test-suite cooperatives from a NON-production database.
 *
 *   node scripts/clean-test-tenants.mjs                 # dry run
 *   node scripts/clean-test-tenants.mjs --apply         # delete them
 *   node scripts/clean-test-tenants.mjs --keep=sunrise,other
 *
 * Every integration spec onboards cooperatives with generated slugs and logins ending in
 * @coopengine.test, and deletes its users but not its cooperatives — so a development database
 * accumulates hundreds of them, which the admin console then faithfully lists.
 *
 * A cooperative is removed only when EVERY user attached to it is a test account. A single real
 * user anywhere in it keeps it, so this cannot swallow a cooperative somebody is using. The
 * per-cooperative user check runs in tenant scope, because user_roles is row-level secured: a
 * cross-tenant join silently reports "no users" and would make every cooperative look abandoned.
 */
import { Pool } from 'pg';
import { withTenant } from '@coopengine/db';

const TEST_EMAIL = '%@coopengine.test';
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const keep = new Set(
  ['sunrise', ...args.filter((a) => a.startsWith('--keep=')).flatMap((a) => a.slice(7).split(','))]
    .map((s) => s.trim())
    .filter(Boolean),
);

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}
if (/supabase|pooler|amazonaws/.test(url)) {
  console.error('refusing: DATABASE_URL looks like a hosted database');
  process.exit(2);
}

const pool = new Pool({ connectionString: url });

async function withScan(runner) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.internal_scan', 'on', true)`);
    const result = await runner(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const orgs = await withScan(async (client) => {
  const { rows } = await client.query(
    `SELECT id, slug, name, status FROM organizations ORDER BY created_at`,
  );
  return rows;
});

console.log(`database : ${(await pool.query('SELECT current_database() AS db')).rows[0].db}`);
console.log(`protected: ${[...keep].join(', ') || '(none)'}`);
console.log(`cooperatives: ${orgs.length}\n`);

const doomed = [];
const survivors = [];
let kept = 0;

for (const org of orgs) {
  if (keep.has(org.slug)) {
    kept += 1;
    continue;
  }
  const counts = await withTenant(pool, org.id, async (client) => {
    const { rows } = await client.query(
      `SELECT
         count(*) FILTER (WHERE u.email LIKE $1) AS test_users,
         count(*) FILTER (WHERE u.email NOT LIKE $1) AS real_users,
         (SELECT count(*) FROM members m WHERE m.organization_id = $2) AS members
       FROM user_roles ur JOIN users u ON u.id = ur.user_id
      WHERE ur.organization_id = $2`,
      [TEST_EMAIL, org.id],
    );
    return rows[0];
  });

  const testUsers = Number(counts.test_users);
  const realUsers = Number(counts.real_users);
  const users = testUsers + realUsers;

  // Two shapes of test residue: a cooperative whose users were all test accounts, and one whose
  // users were deleted while the cooperative remained (the specs delete users first). A real
  // cooperative has at least one real staff user, so both are safe to remove.
  const orphaned = users === 0;
  const allTest = users > 0 && realUsers === 0;
  if (orphaned || allTest) {
    doomed.push({ ...org, members: Number(counts.members), because: orphaned ? 'no users left' : 'test accounts only' });
  } else {
    kept += 1;
    survivors.push({ ...org, members: Number(counts.members), users });
  }
}

console.log(`test cooperatives to remove: ${doomed.length}   cooperating kept: ${kept}\n`);
for (const org of doomed.slice(0, 12)) {
  console.log(
    `  ${org.slug.padEnd(22)} ${org.status.padEnd(8)} members=${String(org.members).padEnd(4)} ${org.because.padEnd(18)} ${org.name}`,
  );
}
if (doomed.length > 12) console.log(`  … and ${doomed.length - 12} more`);

console.log(`\ncooperatives that will be KEPT (${survivors.length}):`);
for (const org of survivors) {
  console.log(
    `  ${org.slug.padEnd(22)} ${org.status.padEnd(8)} members=${String(org.members).padEnd(4)} users=${org.users}  ${org.name}`,
  );
}

if (!apply) {
  console.log('\ndry run — nothing deleted. Re-run with --apply to remove them.');
  await pool.end();
  process.exit(0);
}

let removed = 0;
for (const org of doomed) {
  await withTenant(pool, org.id, (client) =>
    client.query(`DELETE FROM organizations WHERE id = $1`, [org.id]),
  );
  await withScan((client) => client.query(`DELETE FROM org_lookups WHERE slug = $1`, [org.slug]));
  removed += 1;
}
const remaining = await withScan(async (client) => {
  const { rows } = await client.query(`SELECT count(*)::int AS n FROM organizations`);
  return rows[0].n;
});
console.log(`\nremoved ${removed}. cooperatives remaining: ${remaining}`);
await pool.end();
