import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { withTenant } from '@coopengine/db';
import { DB_POOL } from '../database/database.module';

export interface ShareAccountRow {
  id: string;
  memberId: string;
  currentBalance: number;
  status: string;
  openedAt: Date;
}

export interface ShareTxnRow {
  id: string;
  type: string;
  signedAmount: number;
  runningBalance: number;
  description: string;
  createdAt: Date;
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

@Injectable()
export class SharesService {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  private requireOrg(organizationId: string | null): string {
    if (!organizationId) {
      throw new ForbiddenException('Organization context required');
    }
    return organizationId;
  }

  private async getAccountTx(
    c: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
    orgId: string,
    memberId: string,
  ): Promise<ShareAccountRow> {
    const { rows } = await c.query(
      `SELECT id, member_id, current_balance, status, opened_at
         FROM member_share_accounts
        WHERE organization_id = $1 AND member_id = $2`,
      [orgId, memberId],
    );
    if (!rows[0]) throw new NotFoundException('Share account not found');
    return this.mapAccount(rows[0] as Record<string, unknown>);
  }

  async getAccount(
    organizationId: string | null,
    memberId: string,
  ): Promise<ShareAccountRow> {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT id, member_id, current_balance, status, opened_at
           FROM member_share_accounts
          WHERE organization_id = $1 AND member_id = $2`,
        [orgId, memberId],
      );
      if (!rows[0]) throw new NotFoundException('Share account not found');
      return this.mapAccount(rows[0] as Record<string, unknown>);
    });
  }

  /**
   * Redeem share capital: Dr Member Share Capital (3000) / Cr Cash (1000).
   * Redemption cannot exceed the member's share balance.
   */
  async redeem(
    organizationId: string | null,
    actorUserId: string,
    memberId: string,
    amount: number,
    description?: string,
    idempotencyKey?: string,
  ): Promise<ShareAccountRow> {
    const orgId = this.requireOrg(organizationId);
    const value = round2(amount);
    if (value <= 0) throw new BadRequestException('Invalid redemption amount');
    await withTenant(this.pool, orgId, async (c) => {
      const member = await c.query(
        `SELECT id, status FROM members WHERE organization_id = $1 AND id = $2`,
        [orgId, memberId],
      );
      const m = member.rows[0] as { id: string; status: string } | undefined;
      if (!m) throw new NotFoundException('Member not found');
      if (m.status !== 'ACTIVE') {
        throw new ConflictException('Only ACTIVE members can redeem shares');
      }
      if (idempotencyKey) {
        const dup = await c.query(
          `SELECT 1 FROM journal_entries
            WHERE organization_id = $1 AND idempotency_key = $2 LIMIT 1`,
          [orgId, idempotencyKey],
        );
        if (dup.rows[0]) {
          throw new ConflictException('idempotencyKey has already been used');
        }
      }
      const existing = await c.query(
        `SELECT id, current_balance FROM member_share_accounts
          WHERE organization_id = $1 AND member_id = $2`,
        [orgId, memberId],
      );
      const account = existing.rows[0] as
        | { id: string; current_balance: string }
        | undefined;
      if (!account) throw new ConflictException('Member has no share account');
      const balanceBefore = Number(account.current_balance);
      if (value > balanceBefore) {
        throw new BadRequestException(
          `Insufficient share balance (available ${balanceBefore})`,
        );
      }
      const accountId = account.id;

      const period = await c.query(
        `SELECT id FROM ledger_periods
          WHERE organization_id = $1 AND status = 'OPEN'
            AND now()::date BETWEEN start_date AND end_date
          ORDER BY start_date DESC LIMIT 1`,
        [orgId],
      );
      const periodId = (period.rows[0] as { id: string } | undefined)?.id;
      if (!periodId) {
        throw new ConflictException('No OPEN accounting period for today — cannot post');
      }
      const seq = await c.query(
        `UPDATE org_counters SET journal_seq = journal_seq + 1, updated_at = now()
          WHERE organization_id = $1 RETURNING journal_seq`,
        [orgId],
      );
      const entryNo = Number(
        (seq.rows[0] as { journal_seq: string | number }).journal_seq,
      );
      const entryId = randomUUID();
      await c.query(
        `INSERT INTO journal_entries
           (id, organization_id, period_id, entry_date, description, source,
            source_type, source_id, status, entry_no, idempotency_key, created_by, posted_by, posted_at)
         VALUES ($1, $2, $3, now()::date, $4, 'SHARE_REDEMPTION', 'share_account', $5,
                 'POSTED', $6, $7, $8, $8, now())`,
        [
          entryId,
          orgId,
          periodId,
          description ?? `Share redemption ${String(value)}`,
          accountId,
          entryNo,
          idempotencyKey ?? null,
          actorUserId,
        ],
      );
      const accRes = await c.query(
        `SELECT id, code FROM chart_of_accounts
          WHERE organization_id = $1 AND code = ANY($2::varchar[])`,
        [orgId, ['1000', '3000']],
      );
      const idByCode = new Map<string, string>();
      for (const r of accRes.rows as { id: string; code: string }[]) {
        idByCode.set(r.code, r.id);
      }
      const missing = ['1000', '3000'].find((code) => !idByCode.has(code));
      if (missing) throw new BadRequestException(`Unknown account code: ${missing}`);
      // Dr 3000 (equity down) / Cr 1000 (cash out)
      await c.query(
        `INSERT INTO journal_lines (organization_id, journal_entry_id, account_id, debit, credit, member_id)
         VALUES ($1, $2, $3, $4, '0', $5),
                ($1, $2, $6, '0', $4, $5)`,
        [
          orgId,
          entryId,
          idByCode.get('3000'),
          String(value),
          memberId,
          idByCode.get('1000'),
        ],
      );
      const balance = round2(balanceBefore - value);
      await c.query(
        `UPDATE member_share_accounts SET current_balance = $1
          WHERE organization_id = $2 AND id = $3`,
        [String(balance), orgId, accountId],
      );
      await c.query(
        `INSERT INTO share_transactions (organization_id, account_id, journal_entry_id, type, signed_amount, running_balance)
         VALUES ($1, $2, $3, 'REDEMPTION', $4, $5)`,
        [orgId, accountId, entryId, String(-value), String(balance)],
      );
      await c.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1, $2, 'journal.auto.posted', 'journal_entry', $3, $4)`,
        [
          orgId,
          actorUserId,
          entryId,
          JSON.stringify({ source: 'SHARE_REDEMPTION', entryNo, value }),
        ],
      );
    });
    return this.getAccount(orgId, memberId);
  }

  /** Purchase share capital: Dr Cash / Cr Member Share Capital (3000). */
  async purchase(
    organizationId: string | null,
    actorUserId: string,
    memberId: string,
    amount: number,
    description?: string,
    idempotencyKey?: string,
  ): Promise<ShareAccountRow> {
    const orgId = this.requireOrg(organizationId);
    const value = round2(amount);
    if (value <= 0) throw new BadRequestException('Invalid purchase amount');
    await withTenant(this.pool, orgId, async (c) => {
      const member = await c.query(
        `SELECT id, status FROM members WHERE organization_id = $1 AND id = $2`,
        [orgId, memberId],
      );
      const m = member.rows[0] as { id: string; status: string } | undefined;
      if (!m) throw new NotFoundException('Member not found');
      if (m.status !== 'ACTIVE') {
        throw new ConflictException('Only ACTIVE members can buy shares');
      }
      if (idempotencyKey) {
        const dup = await c.query(
          `SELECT 1 FROM journal_entries
            WHERE organization_id = $1 AND idempotency_key = $2 LIMIT 1`,
          [orgId, idempotencyKey],
        );
        if (dup.rows[0]) {
          throw new ConflictException('idempotencyKey has already been used');
        }
      }
      // Auto-open the share account on first purchase
      const existing = await c.query(
        `SELECT id, current_balance FROM member_share_accounts
          WHERE organization_id = $1 AND member_id = $2`,
        [orgId, memberId],
      );
      let accountId: string;
      let balanceBefore = 0;
      if (existing.rows[0]) {
        accountId = (existing.rows[0] as { id: string }).id;
        balanceBefore = Number(
          (existing.rows[0] as { current_balance: string }).current_balance,
        );
      } else {
        const ins = await c.query(
          `INSERT INTO member_share_accounts (organization_id, member_id)
           VALUES ($1, $2) RETURNING id`,
          [orgId, memberId],
        );
        accountId = (ins.rows[0] as { id: string }).id;
      }

      const period = await c.query(
        `SELECT id FROM ledger_periods
          WHERE organization_id = $1 AND status = 'OPEN'
            AND now()::date BETWEEN start_date AND end_date
          ORDER BY start_date DESC LIMIT 1`,
        [orgId],
      );
      const periodId = (period.rows[0] as { id: string } | undefined)?.id;
      if (!periodId) {
        throw new ConflictException('No OPEN accounting period for today — cannot post');
      }
      const seq = await c.query(
        `UPDATE org_counters SET journal_seq = journal_seq + 1, updated_at = now()
          WHERE organization_id = $1 RETURNING journal_seq`,
        [orgId],
      );
      const entryNo = Number(
        (seq.rows[0] as { journal_seq: string | number }).journal_seq,
      );
      const entryId = randomUUID();
      await c.query(
        `INSERT INTO journal_entries
           (id, organization_id, period_id, entry_date, description, source,
            source_type, source_id, status, entry_no, idempotency_key, created_by, posted_by, posted_at)
         VALUES ($1, $2, $3, now()::date, $4, 'SHARE_PURCHASE', 'share_account', $5,
                 'POSTED', $6, $7, $8, $8, now())`,
        [
          entryId,
          orgId,
          periodId,
          description ?? `Share purchase ${String(value)}`,
          accountId,
          entryNo,
          idempotencyKey ?? null,
          actorUserId,
        ],
      );
      const accRes = await c.query(
        `SELECT id, code FROM chart_of_accounts
          WHERE organization_id = $1 AND code = ANY($2::varchar[])`,
        [orgId, ['1000', '3000']],
      );
      const idByCode = new Map<string, string>();
      for (const r of accRes.rows as { id: string; code: string }[]) {
        idByCode.set(r.code, r.id);
      }
      const missing = ['1000', '3000'].find((code) => !idByCode.has(code));
      if (missing) throw new BadRequestException(`Unknown account code: ${missing}`);
      await c.query(
        `INSERT INTO journal_lines (organization_id, journal_entry_id, account_id, debit, credit, member_id)
         VALUES ($1, $2, $3, $4, '0', $5),
                ($1, $2, $6, '0', $4, $5)`,
        [
          orgId,
          entryId,
          idByCode.get('1000'),
          String(value),
          memberId,
          idByCode.get('3000'),
        ],
      );
      const balance = round2(balanceBefore + value);
      await c.query(
        `UPDATE member_share_accounts SET current_balance = $1
          WHERE organization_id = $2 AND id = $3`,
        [String(balance), orgId, accountId],
      );
      await c.query(
        `INSERT INTO share_transactions (organization_id, account_id, journal_entry_id, type, signed_amount, running_balance)
         VALUES ($1, $2, $3, 'PURCHASE', $4, $5)`,
        [orgId, accountId, entryId, String(value), String(balance)],
      );
      await c.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1, $2, 'journal.auto.posted', 'journal_entry', $3, $4)`,
        [
          orgId,
          actorUserId,
          entryId,
          JSON.stringify({ entryNo, source: 'SHARE_PURCHASE', accountId }),
        ],
      );
    });
    return this.getAccount(orgId, memberId);
  }

  async statement(
    organizationId: string | null,
    memberId: string,
    limit?: number,
  ): Promise<ShareTxnRow[]> {
    const orgId = this.requireOrg(organizationId);
    const account = await this.getAccount(orgId, memberId);
    const n = Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : 50;
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT t.id, t.type, t.signed_amount, t.running_balance,
                je.description, t.created_at
           FROM share_transactions t
           JOIN journal_entries je ON je.id = t.journal_entry_id
          WHERE t.organization_id = $1 AND t.account_id = $2
          ORDER BY t.created_at DESC, t.id DESC
          LIMIT $3`,
        [orgId, account.id, Math.min(Math.max(n, 1), 500)],
      );
      return rows.map((r: Record<string, unknown>) => ({
        id: r.id as string,
        type: r.type as string,
        signedAmount: Number(r.signed_amount),
        runningBalance: Number(r.running_balance),
        description: r.description as string,
        createdAt: r.created_at as Date,
      }));
    });
  }

  private mapAccount(row: Record<string, unknown>): ShareAccountRow {
    return {
      id: row.id as string,
      memberId: row.member_id as string,
      currentBalance: Number(row.current_balance),
      status: row.status as string,
      openedAt: row.opened_at as Date,
    };
  }
}
