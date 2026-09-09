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
        TEST_DATABASE_URL,
    },
  });
  const after = await pool.query(`SELECT count(*)::int AS n FROM roles`);
  if ((after.rows[0] as { n: number }).n === 0) {
    throw new Error('RBAC seed failed to restore roles');
  }
}

// Admin credentials: local runs read the rotated password from the root-only
// file; CI (fresh seed) falls back to the seed.mjs default.
export const ADMIN_PASSWORD: string = (() => {
  try {
    return require('fs').readFileSync('/root/coopengine/admin-password', 'utf8').trim();
  } catch {
    return 'AdminDev123!';
  }
})();

// DB URL for local runs: env wins, else read the root-only api.env (rotated
// dev password); final fallback matches a fresh CI seed but CI always sets env.
export const TEST_DATABASE_URL: string = (() => {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const m = require('fs')
      .readFileSync('/root/coopengine/api.env', 'utf8')
      .match(/DATABASE_URL=(\S+)/);
    if (m) return m[1];
  } catch {}
  return TEST_DATABASE_URL;
})();
