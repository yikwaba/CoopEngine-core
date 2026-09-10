import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { withTenant } from '@coopengine/db';
import { DB_POOL } from '../database/database.module';
import { enqueueNotification, outboundChannels } from '../notifications/enqueue';

export interface DividendAllocationPreview {
  memberId: string;
  memberNo: number;
  memberName: string;
  shareBalance: number;
  amount: number;
}

export interface DividendPreview {
  periodLabel: string;
  distributableAmount: number;
  totalShares: number;
  allocations: DividendAllocationPreview[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

@Injectable()
export class DividendsService {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  private requireOrg(organizationId: string | null): string {
    if (!organizationId) throw new ConflictException('No organization in context');
    return organizationId;
  }

  private validPeriod(periodLabel?: string): string {
    const value = periodLabel?.trim() || String(new Date().getUTCFullYear());
    if (!/^\d{4}$/.test(value)) {
      throw new BadRequestException('periodLabel must be a 4-digit year, e.g. 2026');
    }
    return value;
  }

  /** Preview: distribute `amount` pro-rata to members' share balances. */
  async preview(
    organizationId: string | null,
    periodLabel: string | undefined,
    amount: number,
  ): Promise<DividendPreview> {
    const orgId = this.requireOrg(organizationId);
    const period = this.validPeriod(periodLabel);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('distributableAmount must be greater than zero');
    }
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT sa.member_id, m.member_no,
                (m.first_name || ' ' || m.last_name) AS member_name,
                sa.current_balance
           FROM member_share_accounts sa
           JOIN members m ON m.id = sa.member_id
          WHERE sa.status = 'ACTIVE' AND sa.current_balance > 0
          ORDER BY m.member_no`,
      );
      const holders = rows.map((r) => ({
        memberId: r.member_id as string,
        memberNo: Number(r.member_no),
        memberName: r.member_name as string,
        shareBalance: Number(r.current_balance),
      }));
      const totalShares = round2(holders.reduce((a, h) => a + h.shareBalance, 0));
      if (holders.length === 0 || totalShares <= 0) {
        throw new BadRequestException('No members hold share capital — nothing to distribute');
      }
      const allocations = holders.map((h) => ({
        ...h,
        amount: round2((amount * h.shareBalance) / totalShares),
      }));
      // Absorb rounding drift into the largest allocation so the total is exact
      const drift = round2(amount - allocations.reduce((a, x) => a + x.amount, 0));
      if (drift !== 0 && allocations.length > 0) {
        let biggest = 0;
        for (let i = 1; i < allocations.length; i += 1) {
          const cur = allocations[i];
          const top = allocations[biggest];
          if (cur && top && cur.shareBalance > top.shareBalance) biggest = i;
        }
        const target = allocations[biggest];
        if (target) target.amount = round2(target.amount + drift);
      }
      return {
        periodLabel: period,
        distributableAmount: round2(amount),
        totalShares,
        allocations,
      };
    });
  }

  /**
   * Post a dividend run: one balanced journal — Dr Retained Earnings (3100)
   * with the total, Cr each member's savings account (2000) with their
   * allocation — plus allocations, savings credits and projections.
   * Idempotent per organization + period (409 on replay).
   */
  async post(
    organizationId: string | null,
    actorUserId: string,
    periodLabel: string | undefined,
    amount: number,
  ): Promise<{ runId: string; periodLabel: string; total: number; members: number; entryNo: number }> {
    const orgId = this.requireOrg(organizationId);
    const period = this.validPeriod(periodLabel);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('distributableAmount must be greater than zero');
    }
    const runId = randomUUID();
    let entryNo = 0;
    let total = 0;
    let members = 0;

    await withTenant(this.pool, orgId, async (c) => {
      const already = await c.query(
        `SELECT 1 FROM dividend_runs WHERE organization_id = $1 AND period_label = $2`,
        [orgId, period],
      );
      if (already.rows[0]) {
        throw new ConflictException(`Dividends already posted for ${period}`);
      }

      // Shares snapshot (same maths as the preview) inside the transaction
      const { rows } = await c.query(
        `SELECT sa.member_id, m.member_no,
                (m.first_name || ' ' || m.last_name) AS member_name,
                sa.current_balance
           FROM member_share_accounts sa
           JOIN members m ON m.id = sa.member_id
          WHERE sa.status = 'ACTIVE' AND sa.current_balance > 0
          ORDER BY m.member_no`,
      );
      const holders = rows.map((r) => ({
        memberId: r.member_id as string,
        memberNo: Number(r.member_no),
        shareBalance: Number(r.current_balance),
      }));
      const totalShares = round2(holders.reduce((a, h) => a + h.shareBalance, 0));
      if (holders.length === 0 || totalShares <= 0) {
        throw new BadRequestException('No members hold share capital — nothing to distribute');
      }
      const alloc = holders.map((h) => ({
        ...h,
        amount: round2((amount * h.shareBalance) / totalShares),
      }));
      const drift = round2(amount - alloc.reduce((a, x) => a + x.amount, 0));
      if (drift !== 0) {
        let biggest = 0;
        for (let i = 1; i < alloc.length; i += 1) {
          const cur = alloc[i];
          const top = alloc[biggest];
          if (cur && top && cur.shareBalance > top.shareBalance) biggest = i;
        }
        const target = alloc[biggest];
        if (target) target.amount = round2(target.amount + drift);
      }
      total = round2(alloc.reduce((a, x) => a + x.amount, 0));

      const periodRow = await c.query(
        `SELECT id FROM ledger_periods
          WHERE organization_id = $1 AND status = 'OPEN' ORDER BY start_date DESC LIMIT 1`,
        [orgId],
      );
      const p = periodRow.rows[0] as { id: string } | undefined;
      if (!p) throw new ConflictException('No OPEN ledger period');

      // Equity account for the distribution (created on first use)
      const equity = await c.query(
        `SELECT id FROM chart_of_accounts WHERE organization_id = $1 AND code = '3100'`,
        [orgId],
      );
      let equityId = (equity.rows[0] as { id: string } | undefined)?.id;
      if (!equityId) {
        equityId = randomUUID();
        await c.query(
          `INSERT INTO chart_of_accounts (id, organization_id, code, name, type)
           VALUES ($1, $2, '3100', 'Retained Earnings', 'EQUITY')`,
          [equityId, orgId],
        );
      }
      const liability = await c.query(
        `SELECT id, code FROM chart_of_accounts WHERE organization_id = $1 AND code = '2000'`,
        [orgId],
      );
      const cashId = (liability.rows[0] as { id: string } | undefined)?.id;
      if (!cashId) throw new BadRequestException('Unknown account code: 2000');

      const seq = await c.query(
        `UPDATE org_counters SET journal_seq = journal_seq + 1, updated_at = now()
          WHERE organization_id = $1 RETURNING journal_seq`,
        [orgId],
      );
      entryNo = Number((seq.rows[0] as { journal_seq: string | number }).journal_seq);
      const entryId = randomUUID();
      await c.query(
        `INSERT INTO journal_entries
           (id, organization_id, period_id, entry_date, description, source,
            source_type, source_id, status, entry_no, created_by, posted_by, posted_at)
         VALUES ($1, $2, $3, now()::date, $4, 'DIVIDEND', 'dividend_run', $5,
                 'POSTED', $6, $7, $7, now())`,
        [entryId, orgId, p.id, `Dividend distribution ${period}`, runId, entryNo, actorUserId],
      );

      await c.query(
        `INSERT INTO dividend_runs (id, organization_id, period_label, distributable_amount, status, journal_entry_id, member_count, created_by)
         VALUES ($1, $2, $3, $4, 'POSTED', $5, 0, $6)`,
        [runId, orgId, period, String(total), entryId, actorUserId],
      );

      // Dr 3100 total + Cr 2000 per member, all in one statement
      const values: string[] = [];
      const params: unknown[] = [];
      const pushLine = (accountId: string, debit: string, credit: string, memberId: string | null) => {
        const base = params.length;
        values.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`,
        );
        params.push(orgId, entryId, accountId, debit, credit, memberId);
      };
      pushLine(equityId, String(total), '0', null);
      for (const a of alloc) {
        if (a.amount > 0) pushLine(cashId, '0', String(a.amount), a.memberId);
      }
      await c.query(
        `INSERT INTO journal_lines (organization_id, journal_entry_id, account_id, debit, credit, member_id)
         VALUES ${values.join(', ')}`,
        params,
      );

      // Credit each member's savings account (opening one when needed)
      const productRow = await c.query(
        `SELECT id FROM savings_products
          WHERE organization_id = $1 AND status = 'ACTIVE'
          ORDER BY CASE WHEN code = 'REGULAR-SAVINGS' THEN 0 ELSE 1 END, code
          LIMIT 1`,
        [orgId],
      );
      const productId = (productRow.rows[0] as { id: string } | undefined)?.id;
      let credited = 0;
      for (const a of alloc) {
        if (a.amount <= 0) continue;
        const acc = await c.query(
          `SELECT id FROM member_savings_accounts
            WHERE organization_id = $1 AND member_id = $2 AND status = 'ACTIVE'
            ORDER BY opened_at LIMIT 1`,
          [orgId, a.memberId],
        );
        let accountId = (acc.rows[0] as { id: string } | undefined)?.id;
        if (!accountId) {
          if (!productId) throw new BadRequestException('No active savings product to credit');
          accountId = randomUUID();
          const seqNo = await c.query(
            `UPDATE org_counters SET savings_seq = savings_seq + 1, updated_at = now()
              WHERE organization_id = $1 RETURNING savings_seq`,
            [orgId],
          );
          const accountNo = Number((seqNo.rows[0] as { savings_seq: string | number }).savings_seq);
          await c.query(
            `INSERT INTO member_savings_accounts (id, organization_id, member_id, product_id, account_no, status)
             VALUES ($1, $2, $3, $4, $5, 'ACTIVE')`,
            [accountId, orgId, a.memberId, productId, accountNo],
          );
        }
        const bal = await c.query(
          `SELECT current_balance FROM member_savings_accounts WHERE id = $1`,
          [accountId],
        );
        const before = Number((bal.rows[0] as { current_balance: string }).current_balance);
        const after = round2(before + a.amount);
        await c.query(`UPDATE member_savings_accounts SET current_balance = $1 WHERE id = $2`, [
          String(after),
          accountId,
        ]);
        await c.query(
          `INSERT INTO savings_transactions (organization_id, account_id, journal_entry_id, type, signed_amount, running_balance)
           VALUES ($1, $2, $3, 'DIVIDEND', $4, $5)`,
          [orgId, accountId, entryId, String(a.amount), String(after)],
        );
        await enqueueNotification(c, {
          organizationId: orgId,
          memberId: a.memberId,
          type: 'DIVIDEND_PAID',
          title: `Dividend credited (${period})`,
          body: `Your ${period} dividend of ${a.amount.toFixed(2)} has been credited to your savings.`,
          channels: outboundChannels(),
          metadata: { period, amount: a.amount },
        });
        await c.query(
          `INSERT INTO dividend_allocations (id, organization_id, run_id, member_id, share_balance, amount)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [randomUUID(), orgId, runId, a.memberId, String(a.shareBalance), String(a.amount)],
        );
        credited += 1;
      }

      members = credited;
      await c.query(`UPDATE dividend_runs SET member_count = $1 WHERE id = $2`, [credited, runId]);
      await c.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1, $2, 'dividend.posted', 'dividend_run', $3, $4)`,
        [orgId, actorUserId, runId, JSON.stringify({ period, total, members: credited })],
      );
    });

    return { runId, periodLabel: period, total, members, entryNo };
  }

  /** Posted dividend runs, newest first. */
  async list(
    organizationId: string | null,
  ): Promise<
    {
      id: string;
      periodLabel: string;
      distributableAmount: number;
      memberCount: number;
      createdAt: Date;
    }[]
  > {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT id, period_label, distributable_amount, member_count, created_at
           FROM dividend_runs ORDER BY period_label DESC, created_at DESC`,
      );
      return rows.map((r) => ({
        id: r.id as string,
        periodLabel: r.period_label as string,
        distributableAmount: Number(r.distributable_amount),
        memberCount: Number(r.member_count),
        createdAt: r.created_at as Date,
      }));
    });
  }

  /** Allocations of a single run. */
  async getRun(
    organizationId: string | null,
    runId: string,
  ): Promise<{
    run: { id: string; periodLabel: string; distributableAmount: number; memberCount: number };
    allocations: {
      memberId: string;
      memberNo: number;
      memberName: string;
      shareBalance: number;
      amount: number;
    }[];
  }> {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const run = await c.query(
        `SELECT id, period_label, distributable_amount, member_count
           FROM dividend_runs WHERE id = $1`,
        [runId],
      );
      const r = run.rows[0] as
        | { id: string; period_label: string; distributable_amount: string; member_count: string | number }
        | undefined;
      if (!r) throw new NotFoundException('Dividend run not found');
      const { rows } = await c.query(
        `SELECT a.member_id, m.member_no, (m.first_name || ' ' || m.last_name) AS member_name,
                a.share_balance, a.amount
           FROM dividend_allocations a
           JOIN members m ON m.id = a.member_id
          WHERE a.run_id = $1
          ORDER BY m.member_no`,
        [runId],
      );
      return {
        run: {
          id: r.id,
          periodLabel: r.period_label,
          distributableAmount: Number(r.distributable_amount),
          memberCount: Number(r.member_count),
        },
        allocations: rows.map((x) => ({
          memberId: x.member_id as string,
          memberNo: Number(x.member_no),
          memberName: x.member_name as string,
          shareBalance: Number(x.share_balance),
          amount: Number(x.amount),
        })),
      };
    });
  }
}
