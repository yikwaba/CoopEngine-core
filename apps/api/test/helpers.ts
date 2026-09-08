/**
 * Shared integration-test helpers.
 * Guards: RBAC seed data must exist before auth tests run.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Pool } from 'pg';

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Ensures role templates exist (roles table non-empty). If empty, re-runs
 * the DB seed so auth tests are repeatable even after destructive manual
 * cleanup (e.g. `TRUNCATE ... CASCADE`).
 */
export async function ensureRbacSeeded(pool: Pool): Promise<void> {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM roles`);
  if ((rows[0] as { n: number }).n > 0) return;
  const seedPath = join(REPO_ROOT, 'packages', 'db', 'scripts', 'seed.mjs');
  await execFileAsync(process.execPath, [seedPath], {
    env: {
      ...process.env,
      DATABASE_URL:
        process.env.DATABASE_URL ??
        'postgres://coopengine:coopengine@127.0.0.1:5432/coopengine',
    },
  });
  const after = await pool.query(`SELECT count(*)::int AS n FROM roles`);
  if ((after.rows[0] as { n: number }).n === 0) {
    throw new Error('RBAC seed failed to restore roles');
  }
}
