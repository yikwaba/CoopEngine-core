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


  /** Consolidated member statement across savings, shares, loans, dividends. */
  async memberStatement(
    organizationId: string | null,
    memberId: string,
  ): Promise<{
    member: { id: string; memberNo: number; name: string };
    savingsTransactions: { type: string; signedAmount: number; createdAt: Date }[];
    shareTransactions: { type: string; signedAmount: number; createdAt: Date }[];
    loanRepayments: {
      loanId: string;
      seq: number;
      dueDate: string;
      status: string;
      paidAmount: number;
    }[];
    dividends: { periodLabel: string; amount: number }[];
  }> {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const member = await c.query(
        `SELECT id, member_no, (first_name || ' ' || last_name) AS name
           FROM members WHERE id = $1`,
        [memberId],
      );
      const m = member.rows[0] as { id: string; member_no: number; name: string } | undefined;
      if (!m) throw new NotFoundException('Member not found');

      const savings = await c.query(
        `SELECT t.type, t.signed_amount, t.created_at
           FROM savings_transactions t
           JOIN member_savings_accounts a ON a.id = t.account_id
          WHERE a.member_id = $1
          ORDER BY t.created_at`,
        [memberId],
      );
      const shares = await c.query(
        `SELECT t.type, t.signed_amount, t.created_at
           FROM share_transactions t
           JOIN member_share_accounts a ON a.id = t.account_id
          WHERE a.member_id = $1
          ORDER BY t.created_at`,
        [memberId],
      );
      const repayments = await c.query(
        `SELECT r.loan_id, r.seq, r.due_date, r.status,
                (coalesce(r.paid_principal, 0) + coalesce(r.paid_interest, 0)) AS paid_amount
           FROM loan_repayments r
           JOIN loans l ON l.id = r.loan_id
          WHERE l.member_id = $1
          ORDER BY r.due_date`,
        [memberId],
      );
      const dividends = await c.query(
        `SELECT run.period_label, a.amount
           FROM dividend_allocations a
           JOIN dividend_runs run ON run.id = a.run_id
          WHERE a.member_id = $1
          ORDER BY run.period_label`,
        [memberId],
      );

      return {
        member: { id: m.id, memberNo: Number(m.member_no), name: m.name },
        savingsTransactions: savings.rows.map((r) => ({
          type: r.type as string,
          signedAmount: Number(r.signed_amount),
          createdAt: r.created_at as Date,
        })),
        shareTransactions: shares.rows.map((r) => ({
          type: r.type as string,
          signedAmount: Number(r.signed_amount),
          createdAt: r.created_at as Date,
        })),
        loanRepayments: repayments.rows.map((r) => ({
          loanId: r.loan_id as string,
          seq: Number(r.seq),
          dueDate: r.due_date as string,
          status: r.status as string,
          paidAmount: Number(r.paid_amount),
        })),
        dividends: dividends.rows.map((r) => ({
          periodLabel: r.period_label as string,
          amount: Number(r.amount),
        })),
      };
    });
  }


  /** One-click board pack: membership, books, collections, dividends, ledger. */
  async boardPack(
    organizationId: string | null,
  ): Promise<{
    membership: { active: number; pending: number; suspended: number; exited: number };
    savings: { accounts: number; totalBalance: number };
    shares: { holders: number; totalBalance: number };
    loans: { open: number; disbursedTotal: number; outstanding: number };
    collections: { count: number; total: number };
    dividends: { runs: number; totalDistributed: number };
    ledger: { entries: number; net: number };
  }> {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const one = async <T>(sql: string): Promise<T> => (await c.query(sql)).rows[0] as T;

      const members = await one<{ active: string; pending: string; suspended: string; exited: string }>(
        `SELECT count(*) FILTER (WHERE status = 'ACTIVE') AS active,
                count(*) FILTER (WHERE status = 'PENDING') AS pending,
                count(*) FILTER (WHERE status = 'SUSPENDED') AS suspended,
                count(*) FILTER (WHERE status = 'EXITED') AS exited
           FROM members`,
      );
      const savings = await one<{ accounts: string; total: string }>(
        `SELECT count(*) AS accounts, coalesce(sum(current_balance), 0) AS total
           FROM member_savings_accounts WHERE status = 'ACTIVE'`,
      );
      const shares = await one<{ holders: string; total: string }>(
        `SELECT count(*) AS holders, coalesce(sum(current_balance), 0) AS total
           FROM member_share_accounts WHERE status = 'ACTIVE'`,
      );
      const loans = await one<{ open: string; disbursed: string; outstanding: string }>(
        `SELECT count(*) FILTER (WHERE status IN ('DISBURSED','DEFAULTED')) AS open,
                coalesce(sum(principal) FILTER (WHERE disbursed_at IS NOT NULL), 0) AS disbursed,
                coalesce(sum(outstanding_principal) FILTER (WHERE status IN ('DISBURSED','DEFAULTED')), 0) AS outstanding
           FROM loans`,
      );
      const collections = await one<{ count: string; total: string }>(
        `SELECT count(*) AS count, coalesce(sum(amount), 0) AS total FROM payment_notifications
          WHERE status = 'POSTED'`,
      );
      const dividends = await one<{ runs: string; total: string }>(
        `SELECT count(*) AS runs, coalesce(sum(distributable_amount), 0) AS total FROM dividend_runs`,
      );
      const ledger = await one<{ entries: string; net: string }>(
        `SELECT (SELECT count(*) FROM journal_entries WHERE status = 'POSTED') AS entries,
                (SELECT coalesce(sum(debit - credit), 0) FROM journal_lines) AS net`,
      );

      return {
        membership: {
          active: Number(members.active),
          pending: Number(members.pending),
          suspended: Number(members.suspended),
          exited: Number(members.exited),
        },
        savings: { accounts: Number(savings.accounts), totalBalance: Number(savings.total) },
        shares: { holders: Number(shares.holders), totalBalance: Number(shares.total) },
        loans: {
          open: Number(loans.open),
          disbursedTotal: Number(loans.disbursed),
          outstanding: Number(loans.outstanding),
        },
        collections: { count: Number(collections.count), total: Number(collections.total) },
        dividends: { runs: Number(dividends.runs), totalDistributed: Number(dividends.total) },
        ledger: { entries: Number(ledger.entries), net: Number(ledger.net) },
      };
    });
  }

  /** Portfolio analytics: monthly disbursements/collections + PAR by product. */
  async portfolioAnalytics(
    organizationId: string | null,
    months = 6,
  ): Promise<{
    months: { month: string; disbursed: number; collected: number }[];
    parByProduct: {
      productCode: string;
      productName: string;
      loans: number;
      outstanding: number;
      par30: number;
      par90: number;
    }[];
    totals: { outstanding: number; par30: number; par90: number };
  }> {
    const orgId = this.requireOrg(organizationId);
    const span = Math.min(Math.max(Math.trunc(months) || 6, 1), 24);
    return withTenant(this.pool, orgId, async (c) => {
      const disb = await c.query(
        `SELECT to_char(date_trunc('month', disbursed_at), 'YYYY-MM') AS month,
                coalesce(sum(principal), 0) AS total
           FROM loans
          WHERE disbursed_at IS NOT NULL
            AND disbursed_at >= date_trunc('month', now()) - ($1::int - 1) * interval '1 month'
          GROUP BY 1 ORDER BY 1`,
        [span],
      );
      const coll = await c.query(
        `SELECT to_char(date_trunc('month', entry_date), 'YYYY-MM') AS month,
                coalesce(sum(debit), 0) AS total
           FROM journal_entries e
           JOIN journal_lines l ON l.journal_entry_id = e.id
          WHERE e.source = 'LOAN_REPAYMENT'
            AND e.entry_date >= date_trunc('month', now()) - ($1::int - 1) * interval '1 month'
          GROUP BY 1 ORDER BY 1`,
        [span],
      );
      const disbMap = new Map<string, number>();
      for (const r of disb.rows as { month: string; total: string }[]) {
        disbMap.set(r.month, Number(r.total));
      }
      const collMap = new Map<string, number>();
      for (const r of coll.rows as { month: string; total: string }[]) {
        collMap.set(r.month, Number(r.total));
      }
      const monthKeys: string[] = [];
      const now = new Date();
      for (let i = span - 1; i >= 0; i -= 1) {
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
        monthKeys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
      }
      const par = await c.query(
        `SELECT p.code, p.name,
                count(l.id) AS loans,
                coalesce(sum(l.outstanding_principal), 0) AS outstanding,
                coalesce(sum(l.outstanding_principal) FILTER (WHERE overdue.days_late >= 30), 0) AS par30,
                coalesce(sum(l.outstanding_principal) FILTER (WHERE overdue.days_late >= 90), 0) AS par90
           FROM loan_products p
           JOIN loans l ON l.loan_product_id = p.id AND l.status IN ('DISBURSED','DEFAULTED')
           LEFT JOIN LATERAL (
             SELECT max((now()::date - r.due_date)) AS days_late
               FROM loan_repayments r
              WHERE r.loan_id = l.id AND r.status <> 'PAID' AND r.due_date < now()::date
           ) AS overdue ON true
          GROUP BY p.code, p.name
          ORDER BY p.code`,
      );
      const parByProduct = (par.rows as Record<string, unknown>[]).map((r) => ({
        productCode: r.code as string,
        productName: r.name as string,
        loans: Number(r.loans),
        outstanding: Number(r.outstanding),
        par30: Number(r.par30),
        par90: Number(r.par90),
      }));
      return {
        months: monthKeys.map((m) => ({
          month: m,
          disbursed: disbMap.get(m) ?? 0,
          collected: collMap.get(m) ?? 0,
        })),
        parByProduct,
        totals: {
          outstanding: parByProduct.reduce((a, x) => a + x.outstanding, 0),
          par30: parByProduct.reduce((a, x) => a + x.par30, 0),
          par90: parByProduct.reduce((a, x) => a + x.par90, 0),
        },
      };
    });
  }

  /**
   * CSV export of a report. `kind` maps to an existing report query; rows are
   * flattened into RFC-4180-ish CSV with quote/escape handling.
   */
  async exportCsv(
    organizationId: string | null,
    kind:
      | 'savings-book'
      | 'loan-book'
      | 'contribution-schedule'
      | 'audit-logs'
      | 'member-statement'
      | 'board-pack',
    memberId?: string,
  ): Promise<string> {
    const orgId = this.requireOrg(organizationId);
    const escape = (v: unknown): string => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = (rows: unknown[][]): string =>
      rows.map((r) => r.map(escape).join(',')).join('\n') + '\n';

    if (kind === 'board-pack') {
      const pack = await this.boardPack(orgId);
      const rows: unknown[][] = [
        ['section', 'metric', 'value'],
        ['membership', 'active', pack.membership.active],
        ['membership', 'pending', pack.membership.pending],
        ['membership', 'suspended', pack.membership.suspended],
        ['membership', 'exited', pack.membership.exited],
        ['savings', 'accounts', pack.savings.accounts],
        ['savings', 'totalBalance', pack.savings.totalBalance.toFixed(2)],
        ['shares', 'holders', pack.shares.holders],
        ['shares', 'totalBalance', pack.shares.totalBalance.toFixed(2)],
        ['loans', 'open', pack.loans.open],
        ['loans', 'disbursedTotal', pack.loans.disbursedTotal.toFixed(2)],
        ['loans', 'outstanding', pack.loans.outstanding.toFixed(2)],
        ['collections', 'count', pack.collections.count],
        ['collections', 'total', pack.collections.total.toFixed(2)],
        ['dividends', 'runs', pack.dividends.runs],
        ['dividends', 'totalDistributed', pack.dividends.totalDistributed.toFixed(2)],
        ['ledger', 'entries', pack.ledger.entries],
        ['ledger', 'net', pack.ledger.net.toFixed(2)],
      ];
      return csv(rows);
    }

    if (kind === 'member-statement') {
      if (!memberId) throw new BadRequestException('memberId is required for member-statement');
      const statement = await this.memberStatement(orgId, memberId);
      const rows: unknown[][] = [
        ['section', 'date', 'description', 'amount'],
        ...statement.savingsTransactions.map((t) => [
          'savings',
          new Date(t.createdAt).toISOString().slice(0, 10),
          t.type,
          t.signedAmount.toFixed(2),
        ]),
        ...statement.shareTransactions.map((t) => [
          'shares',
          new Date(t.createdAt).toISOString().slice(0, 10),
          t.type,
          t.signedAmount.toFixed(2),
        ]),
        ...statement.loanRepayments.map((r) => [
          'loan',
          r.dueDate,
          `installment ${r.seq} (${r.status})`,
          r.paidAmount.toFixed(2),
        ]),
        ...statement.dividends.map((d) => [
          'dividend',
          d.periodLabel,
          'dividend allocation',
          d.amount.toFixed(2),
        ]),
      ];
      return csv(rows);
    }

    if (kind === 'savings-book') {
      const data = await this.savingsBook(orgId);
      const rows = data.rows.map((r) => [
        r.memberNo,
        r.memberName,
        r.accountNo,
        r.productCode,
        r.balance.toFixed(2),
        r.status,
      ]);
      return csv([['memberNo', 'memberName', 'accountNo', 'productCode', 'balance', 'status'], ...rows]);
    }
    if (kind === 'loan-book') {
      const data = await this.loanBook(orgId);
      const rows = data.rows.map((r) => [
        r.memberNo,
        r.memberName,
        r.productCode,
        r.principal.toFixed(2),
        r.outstandingPrincipal.toFixed(2),
        r.status,
        r.disbursedAt ? new Date(r.disbursedAt).toISOString().slice(0, 10) : '',
      ]);
      return csv([['memberNo', 'memberName', 'productCode', 'principal', 'outstandingPrincipal', 'status', 'disbursedAt'], ...rows]);
    }
    if (kind === 'contribution-schedule') {
      const data = await this.contributionSchedule(orgId);
      const rows = data.rows.map((r) => [r.memberNo, r.member, r.period, r.contributed.toFixed(2)]);
      return csv([['memberNo', 'member', 'period', 'contributed'], ...rows]);
    }
    const data = await this.auditLogs(orgId, 500);
    const rows = data.items.map((r) => [
      new Date(r.createdAt).toISOString(),
      r.actorEmail ?? 'system',
      r.action,
      r.entityType ?? '',
      r.entityId ?? '',
      r.metadata ? JSON.stringify(r.metadata) : '',
    ]);
    return csv([['createdAt', 'actor', 'action', 'entityType', 'entityId', 'metadata'], ...rows]);
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
