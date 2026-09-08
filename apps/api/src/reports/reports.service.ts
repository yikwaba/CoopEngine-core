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

  /** Audit trail (system table, NOT RLS-scoped — org filter is explicit). */
  async auditLogs(
    organizationId: string | null,
    limit = 100,
    action?: string,
  ): Promise<AuditLogRow[]> {
    const orgId = this.requireOrg(organizationId);
    const n = Math.min(Math.max(Number.isFinite(Number(limit)) ? Number(limit) : 100, 1), 500);
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
         LIMIT $${params.length + 1}`,
      [...params, n],
    );
    return rows.map((r: Record<string, unknown>) => ({
      id: r.id as string,
      actorEmail: (r.actor_email as string | null) ?? null,
      action: r.action as string,
      entityType: (r.entity_type as string | null) ?? null,
      entityId: (r.entity_id as string | null) ?? null,
      metadata:
        (r.metadata as Record<string, unknown> | null) ?? null,
      createdAt: r.created_at as Date,
    }));
  }
}
