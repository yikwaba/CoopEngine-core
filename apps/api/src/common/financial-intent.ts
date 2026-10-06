import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { withTenant } from '@coopengine/db';

/** Receipt and financial effect share the caller's tenant transaction and commit. */
export async function financialIntent<T>(
  pool: Pool, orgId: string, action: string, key: string | undefined,
  payload: Record<string, unknown>, work: (c: PoolClient, journalKey?: string) => Promise<T>,
  existingClient?: PoolClient,
): Promise<T> {
  const run = async (c: PoolClient): Promise<T> => {
    if (!key) return work(c);
    if (typeof key !== 'string' || key.length<16 || key.length>100 || !key.trim()) {
      throw new BadRequestException('idempotencyKey must contain 16 to 100 characters');
    }
    // Internal source references retain their historical journal links and refusal semantics.
    // Serialize them before the precheck so concurrent provider/request retries cannot race.
    if (key.startsWith('pay:') || key.startsWith('withdrawal-request:')) {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${orgId}:source:${key}`]);
      const posted=await c.query('SELECT id FROM journal_entries WHERE organization_id=$1 AND idempotency_key=$2',[orgId,key]);
      if (posted.rowCount) throw new ConflictException('idempotencyKey has already been used');
      return work(c,key);
    }
    const fingerprint=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const claimed=await c.query(
      `INSERT INTO financial_write_receipts (organization_id,action,intent_key,fingerprint)
       VALUES ($1,$2,$3,$4) ON CONFLICT (organization_id,action,intent_key) DO NOTHING RETURNING id`,
      [orgId,action,key,fingerprint],
    );
    const receipt=await c.query(
      `SELECT id,fingerprint,response FROM financial_write_receipts
        WHERE organization_id=$1 AND action=$2 AND intent_key=$3 FOR UPDATE`,[orgId,action,key],
    );
    const row=receipt.rows[0];
    if (!row || row.fingerprint!==fingerprint) throw new ConflictException('This payment key was already used with different details');
    if (row.response!==null) return row.response as T;
    if (!claimed.rowCount) throw new ConflictException('Payment receipt is incomplete; reconciliation is required');
    // Old journal-only keys cannot safely reconstruct the original response/payload.
    const legacy=await c.query('SELECT id FROM journal_entries WHERE organization_id=$1 AND idempotency_key=$2',[orgId,key]);
    if (legacy.rowCount) throw new ConflictException('A historical payment already uses this key; review its journal');
    const journalKey='intent:'+createHash('sha256').update(`${orgId}:${action}:${key}`).digest('hex');
    const response=await work(c,journalKey);
    await c.query('UPDATE financial_write_receipts SET response=$1::jsonb,completed_at=now() WHERE organization_id=$2 AND id=$3',
      [JSON.stringify(response),orgId,row.id]);
    return response;
  };
  return existingClient ? run(existingClient) : withTenant(pool,orgId,run);
}

/** An explicit step is a new approval intent; legacy retries stay bound to the actor's first decision. */
export function approvalStepKey(entityId: string, actorUserId: string, expectedStepNo?: number): string {
  if (expectedStepNo !== undefined) {
    if (!Number.isSafeInteger(expectedStepNo) || expectedStepNo < 1) throw new BadRequestException('expectedStepNo must be a positive integer');
    return `approval-step:${entityId}:${expectedStepNo}`;
  }
  return 'approval-actor:'+createHash('sha256').update(JSON.stringify([entityId,actorUserId])).digest('hex');
}
