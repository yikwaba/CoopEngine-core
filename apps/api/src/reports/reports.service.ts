import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { withTenant } from '@coopengine/db';
import { DB_POOL } from '../database/database.module';

export interface Member360 {
  member: {
    id: string;
    memberNo: number;
    firstName: string;
    lastName: string;
    email: string | null;
    status: string;
    joinedAt: Date | null;
  };
  savings: {
    accountId: string;
    accountNo: number;
    productCode: string;
    balance: number;
    status: string;
  }[];
  savingsTotal: number;
  shareBalance: number;
  loans: {
    id: string;
    productCode: string;
    principal: number;
    outstandingPrincipal: number;
    status: string;
  }[];
  loansOutstandingTotal: number;
}

export interface SavingsBookRow {
  memberId: string;
  memberNo: number;
  memberName: string;
  accountNo: number;
  productCode: string;
  balance: number;
  status: string;
}

export interface LoanBookRow {
  loanId: string;
  memberId: string;
  memberNo: number;
  memberName: string;
  productCode: string;
  principal: number;
  outstandingPrincipal: number;
  interestRatePa: number;
  status: string;
  disbursedAt: Date | null;
}

export interface AuditLogRow {
  id: string;
  actorEmail: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

@Injectable()
export class ReportsService {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  private requireOrg(organizationId: string | null): string {
    if (!organizationId) {
      throw new ForbiddenException('Organization context required');
    }
    return organizationId;
  }

  async member360(
    organizationId: string | null,
    memberId: string,
  ): Promise<Member360> {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const member = await c.query(
        `SELECT id, member_no, first_name, last_name, email, status, joined_at
           FROM members WHERE organization_id = $1 AND id = $2`,
        [orgId, memberId],
      );
      if (!member.rows[0]) throw new NotFoundException('Member not found');
      const m = member.rows[0] as Record<string, unknown>;

      const savings = await c.query(
        `SELECT a.id AS account_id, a.account_no, a.current_balance, a.status,
                p.code AS product_code
           FROM member_savings_accounts a
           JOIN savings_products p ON p.id = a.product_id
          WHERE a.organization_id = $1 AND a.member_id = $2
          ORDER BY a.account_no`,
        [orgId, memberId],
      );
      const savingsRows = savings.rows.map((r: Record<string, unknown>) => ({
        accountId: r.account_id as string,
        accountNo: Number(r.account_no),
        productCode: r.product_code as string,
        balance: Number(r.current_balance),
        status: r.status as string,
      }));

      const shares = await c.query(
        `SELECT current_balance FROM member_share_accounts
          WHERE organization_id = $1 AND member_id = $2`,
        [orgId, memberId],
      );
      const shareBalance = shares.rows[0]
        ? Number((shares.rows[0] as { current_balance: string }).current_balance)
        : 0;

      const loans = await c.query(
        `SELECT l.id, l.principal, l.outstanding_principal, l.status,
                p.code AS product_code
           FROM loans l
           JOIN loan_products p ON p.id = l.loan_product_id
          WHERE l.organization_id = $1 AND l.member_id = $2
            AND l.status IN ('APPROVED', 'DISBURSED', 'DEFAULTED')
          ORDER BY l.created_at DESC`,
        [orgId, memberId],
      );
      const loanRows = loans.rows.map((r: Record<string, unknown>) => ({
        id: r.id as string,
        productCode: r.product_code as string,
        principal: Number(r.principal),
        outstandingPrincipal: Number(r.outstanding_principal),
        status: r.status as string,
      }));

      return {
        member: {
          id: m.id as string,
          memberNo: Number(m.member_no),
          firstName: m.first_name as string,
          lastName: m.last_name as string,
          email: (m.email as string | null) ?? null,
          status: m.status as string,
          joinedAt: (m.joined_at as Date | null) ?? null,
        },
        savings: savingsRows,
        savingsTotal: savingsRows.reduce((a, r) => a + r.balance, 0),
        shareBalance,
        loans: loanRows,
        loansOutstandingTotal: loanRows.reduce(
          (a, r) => a + r.outstandingPrincipal,
          0,
        ),
      };
    });
  }

  async savingsBook(organizationId: string | null): Promise<{
    totalMembers: number;
    totalBalance: number;
    rows: SavingsBookRow[];
  }> {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT a.member_id, m.member_no,
                CONCAT(m.first_name, ' ', m.last_name) AS member_name,
                a.account_no, p.code AS product_code, a.current_balance, a.status
           FROM member_savings_accounts a
           JOIN members m ON m.id = a.member_id
           JOIN savings_products p ON p.id = a.product_id
          WHERE a.organization_id = $1
          ORDER BY m.member_no, a.account_no`,
        [orgId],
      );
      const out = rows.map((r: Record<string, unknown>) => ({
        memberId: r.member_id as string,
        memberNo: Number(r.member_no),
        memberName: r.member_name as string,
        accountNo: Number(r.account_no),
        productCode: r.product_code as string,
        balance: Number(r.current_balance),
        status: r.status as string,
      }));
      return {
        totalMembers: new Set(out.map((r) => r.memberId)).size,
        totalBalance: Math.round(out.reduce((a, r) => a + r.balance, 0) * 100) / 100,
        rows: out,
      };
    });
  }

  async loanBook(organizationId: string | null): Promise<{
    outstandingTotal: number;
    disbursedCount: number;
    rows: LoanBookRow[];
  }> {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT l.id AS loan_id, l.member_id, m.member_no,
                CONCAT(m.first_name, ' ', m.last_name) AS member_name,
                p.code AS product_code, l.principal, l.outstanding_principal,
                l.interest_rate_pa, l.status, l.disbursed_at
           FROM loans l
           JOIN members m ON m.id = l.member_id
           JOIN loan_products p ON p.id = l.loan_product_id
          WHERE l.organization_id = $1
            AND l.status IN ('APPROVED', 'DISBURSED', 'DEFAULTED')
          ORDER BY l.created_at DESC`,
        [orgId],
      );
      const out = rows.map((r: Record<string, unknown>) => ({
        loanId: r.loan_id as string,
        memberId: r.member_id as string,
        memberNo: Number(r.member_no),
        memberName: r.member_name as string,
        productCode: r.product_code as string,
        principal: Number(r.principal),
        outstandingPrincipal: Number(r.outstanding_principal),
        interestRatePa: Number(r.interest_rate_pa),
        status: r.status as string,
        disbursedAt: (r.disbursed_at as Date | null) ?? null,
      }));
      return {
        outstandingTotal:
          Math.round(out.reduce((a, r) => a + r.outstandingPrincipal, 0) * 100) / 100,
        disbursedCount: out.filter((r) => r.status === 'DISBURSED').length,
        rows: out,
      };
    });
  }

  /**
   * Savings reconciliation: projection (member_savings_accounts.current_balance)
   * vs the ledger truth (sum of 2000-side lines of POSTED savings entries).
   */
  async savingsReconciliation(organizationId: string | null): Promise<{
    checked: number;
    matched: number;
    mismatches: {
      accountId: string;
      memberNo: number;
      projected: number;
      ledger: number;
      diff: number;
    }[];
  }> {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT a.id AS account_id, m.member_no, a.current_balance AS projected,
                COALESCE((
                  SELECT SUM(CASE WHEN jl.credit > 0 THEN jl.credit ELSE -jl.debit END)
                    FROM journal_lines jl
                    JOIN journal_entries je ON je.id = jl.journal_entry_id
                   WHERE je.organization_id = a.organization_id
                     AND je.status = 'POSTED'
                     AND jl.member_id = a.member_id
                     AND jl.account_id = (
                       SELECT id FROM chart_of_accounts ca
                        WHERE ca.organization_id = a.organization_id AND ca.code = '2000'
                     )
                ), 0) AS ledger
           FROM member_savings_accounts a
           JOIN members m ON m.id = a.member_id
          WHERE a.organization_id = $1`,
        [orgId],
      );
      const mismatches: {
        accountId: string;
        memberNo: number;
        projected: number;
        ledger: number;
        diff: number;
      }[] = [];
      for (const r of rows as {
        account_id: string;
        member_no: number;
        projected: string;
        ledger: string;
      }[]) {
        const projected = Number(r.projected);
        const ledger = Number(r.ledger);
        if (Math.abs(projected - ledger) > 0.004) {
          mismatches.push({
            accountId: r.account_id,
            memberNo: Number(r.member_no),
            projected,
            ledger,
            diff: Math.round((projected - ledger) * 100) / 100,
          });
        }
      }
      return {
        checked: rows.length,
        matched: rows.length - mismatches.length,
        mismatches,
      };
    });
  }

  /**
   * Contribution schedule: member DEPOSIT totals per calendar month
   * (defaults to the last 6 months).
   */
  async contributionSchedule(
    organizationId: string | null,
    months = 6,
  ): Promise<{
    periodFrom: string;
    periodTo: string;
    totalContributed: number;
    rows: { memberNo: number; member: string; period: string; contributed: number }[];
  }> {
    const orgId = this.requireOrg(organizationId);
    const n = Math.min(Math.max(months, 1), 24);
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT m.member_no,
                m.first_name || ' ' || m.last_name AS member,
                to_char(t.created_at, 'YYYY-MM') AS period,
                COALESCE(SUM(t.signed_amount), 0)::numeric AS contributed
           FROM savings_transactions t
           JOIN member_savings_accounts a ON a.id = t.account_id
           JOIN members m ON m.id = a.member_id
          WHERE a.organization_id = $1
            AND t.type = 'DEPOSIT'
            AND t.created_at >= date_trunc('month', now()) - ($2 * interval '1 month')
          GROUP BY m.member_no, m.first_name, m.last_name, period
          ORDER BY period DESC, m.member_no`,
        [orgId, n],
      );
      const data = rows.map((r: Record<string, unknown>) => ({
        memberNo: Number(r.member_no),
        member: r.member as string,
        period: r.period as string,
        contributed: Number(r.contributed),
      }));
      return {
        periodFrom: `${data.at(-1)?.period ?? '—'}`,
        periodTo: `${data[0]?.period ?? '—'}`,
        totalContributed: Math.round(data.reduce((a, d) => a + d.contributed, 0) * 100) / 100,
        rows: data,
      };
    });
  }

  /**
   * Loan book aging: buckets based on the member's EARLIEST unpaid
   * installment (days past due; <= 0 days = CURRENT).
   */
  async loansAging(organizationId: string | null): Promise<{
    buckets: { bucket: string; count: number; outstanding: number }[];
    rows: {
      loanId: string;
      memberNo: number;
      member: string;
      outstanding: number;
      daysPastDue: number;
      bucket: string;
      nextDueDate: string | null;
    }[];
  }> {
    const orgId = this.requireOrg(organizationId);
    const BUCKETS = ['CURRENT', '1-30', '31-60', '61-90', '90+'] as const;
    const bucketFor = (days: number): string => {
      if (days <= 0) return 'CURRENT';
      if (days <= 30) return '1-30';
      if (days <= 60) return '31-60';
      if (days <= 90) return '61-90';
      return '90+';
    };
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT l.id AS loan_id, m.member_no, m.first_name || ' ' || m.last_name AS member,
                l.outstanding_principal AS outstanding,
                lr.due_date AS next_due,
                GREATEST(0, (now()::date - lr.due_date))::int AS days_past_due
           FROM loans l
           JOIN members m ON m.id = l.member_id
           LEFT JOIN LATERAL (
             SELECT due_date FROM loan_repayments
              WHERE loan_id = l.id
                AND (paid_principal < principal_due OR paid_interest < interest_due)
              ORDER BY due_date ASC LIMIT 1
           ) lr ON true
          WHERE l.organization_id = $1
            AND l.status IN ('DISBURSED', 'DEFAULTED')
          ORDER BY days_past_due DESC`,
        [orgId],
      );
      const data = rows.map((r: Record<string, unknown>) => {
        const daysPastDue = Number(r.days_past_due ?? 0);
        return {
          loanId: r.loan_id as string,
          memberNo: Number(r.member_no),
          member: r.member as string,
          outstanding: Number(r.outstanding),
          daysPastDue,
          bucket: bucketFor(daysPastDue),
          nextDueDate: r.next_due
            ? (r.next_due as Date).toISOString().slice(0, 10)
            : null,
        };
      });
      const buckets = BUCKETS.map((bucket) => {
        const inBucket = data.filter((d) => d.bucket === bucket);
        return {
          bucket,
          count: inBucket.length,
          outstanding: Math.round(
            inBucket.reduce((a, d) => a + d.outstanding, 0) * 100,
          ) / 100,
        };
      }).filter((b) => b.count > 0 || b.bucket === 'CURRENT');
      return { buckets, rows: data };
    });
  }

  /** Members who exited, with payout metadata from the audit trail. */
  async exitedMembers(organizationId: string | null): Promise<{
    count: number;
    totalPaidOut: number;
    rows: {
      memberId: string;
      memberNo: number;
      member: string;
      exitedAt: Date;
      payout: number;
      closedAccounts: number;
      actor: string | null;
    }[];
  }> {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT a.entity_id AS member_id, m.member_no,
                m.first_name || ' ' || m.last_name AS member,
                a.created_at AS exited_at,
                COALESCE((a.metadata->>'payout')::numeric, 0) AS payout,
                COALESCE((a.metadata->>'closedAccounts')::int, 0) AS closed_accounts,
                u.email AS actor
           FROM audit_logs a
           JOIN members m ON m.id = a.entity_id
           LEFT JOIN users u ON u.id = a.actor_user_id
          WHERE a.organization_id = $1 AND a.action = 'member.status.exited'
          ORDER BY a.created_at DESC
          LIMIT 500`,
        [orgId],
      );
      const data = rows.map((r: Record<string, unknown>) => ({
        memberId: r.member_id as string,
        memberNo: Number(r.member_no),
        member: r.member as string,
        exitedAt: r.exited_at as Date,
        payout: Number(r.payout),
        closedAccounts: Number(r.closed_accounts),
        actor: (r.actor as string | null) ?? null,
      }));
      return {
        count: data.length,
        totalPaidOut:
          Math.round(data.reduce((a, d) => a + d.payout, 0) * 100) / 100,
        rows: data,
      };
    });
  }

  /**
   * Savings interest preview (accrual stub — informative only, never posts):
   * one month of interest on current balances at each product's rate.
   */
  async savingsInterestPreview(organizationId: string | null): Promise<{
    rows: {
      memberNo: number;
      member: string;
      productCode: string;
      productName: string;
      ratePa: number;
      balance: number;
      monthlyEstimate: number;
    }[];
    totalBalance: number;
    totalMonthlyEstimate: number;
  }> {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT m.member_no, m.first_name || ' ' || m.last_name AS member,
                p.code AS product_code, p.name AS product_name,
                p.interest_rate_pa::numeric AS rate_pa,
                a.current_balance::numeric AS balance,
                round((a.current_balance * p.interest_rate_pa / 100 / 12)::numeric, 2) AS monthly_estimate
           FROM member_savings_accounts a
           JOIN members m ON m.id = a.member_id
           JOIN savings_products p ON p.id = a.product_id
          WHERE a.organization_id = $1 AND a.status = 'ACTIVE'
          ORDER BY m.member_no`,
        [orgId],
      );
      const data = rows.map((r: Record<string, unknown>) => ({
        memberNo: Number(r.member_no),
        member: r.member as string,
        productCode: r.product_code as string,
        productName: r.product_name as string,
        ratePa: Number(r.rate_pa),
        balance: Number(r.balance),
        monthlyEstimate: Number(r.monthly_estimate),
      }));
      return {
        rows: data,
        totalBalance: Math.round(data.reduce((a, d) => a + d.balance, 0) * 100) / 100,
        totalMonthlyEstimate:
          Math.round(data.reduce((a, d) => a + d.monthlyEstimate, 0) * 100) / 100,
      };
    });
  }

  /** Audit trail (system table, NOT RLS-scoped — org filter is explicit). */
  async auditLogs(
    organizationId: string | null,
    limit = 100,
    action?: string,
    offset = 0,
  ): Promise<{ items: AuditLogRow[]; total: number }> {
    const orgId = this.requireOrg(organizationId);
    const n = Math.min(Math.max(Number.isFinite(Number(limit)) ? Number(limit) : 100, 1), 500);
    const off = Math.max(offset, 0);
    const params: unknown[] = [orgId];
    let filter = `WHERE al.organization_id = $1`;
    if (action) {
      params.push(action);
      filter += ` AND al.action = $${params.length}`;
    }
    const { rows } = await this.pool.query(
      `SELECT al.id, al.action, al.entity_type, al.entity_id, al.metadata, al.created_at,
              u.email AS actor_email
         FROM audit_logs al
         LEFT JOIN users u ON u.id = al.actor_user_id
         ${filter}
         ORDER BY al.created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, n, off],
    );
    const count = await this.pool.query(
      `SELECT count(*)::int AS n FROM audit_logs WHERE organization_id = $1 ${action ? 'AND action = $2' : ''}`,
      action ? [orgId, action] : [orgId],
    );
    return {
      total: (count.rows[0] as { n: number }).n,
      items: rows.map((r: Record<string, unknown>) => ({
        id: r.id as string,
        actorEmail: (r.actor_email as string | null) ?? null,
        action: r.action as string,
        entityType: (r.entity_type as string | null) ?? null,
        entityId: (r.entity_id as string | null) ?? null,
        metadata:
          (r.metadata as Record<string, unknown> | null) ?? null,
        createdAt: r.created_at as Date,
      })),
    };
  }
}
