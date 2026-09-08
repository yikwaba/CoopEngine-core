/**
 * Tenant-aware PostgreSQL client helpers.
 *
 * RLS strategy (Technical Implementation Plan §4, ADR-0003):
 * every tenant-scoped transaction sets the transaction-local GUC
 * `app.tenant_id` BEFORE any statement, so RLS policies evaluate against it.
 * Connections from the pool never leak tenant context between requests.
 */
import { Pool, PoolClient } from 'pg';
import { TENANT_GUC } from './schema';

export const DEFAULT_DATABASE_URL =
  'postgres://coopengine:coopengine@127.0.0.1:5432/coopengine';

export function createPool(connectionString: string | undefined): Pool {
  return new Pool({
    connectionString: connectionString ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    max: 10,
  });
}

/**
 * Run `fn` inside a transaction with the tenant GUC set to `organizationId`.
 * The GUC is transaction-local (`set_config(..., true)`), so it cannot leak
 * into later pooled connections.
 */
export async function withTenant<T>(
  pool: Pool,
  organizationId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config($1, $2, true)`, [
      TENANT_GUC,
      organizationId,
    ]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Returns the current tenant id from the GUC (null when unset). */
export async function currentTenantId(client: PoolClient): Promise<string | null> {
  const res = await client.query(
    `SELECT current_setting('app.tenant_id', true) AS tenant_id`,
  );
  return (res.rows[0]?.tenant_id as string | null) ?? null;
}
