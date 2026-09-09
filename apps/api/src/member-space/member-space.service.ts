import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { withTenant } from '@coopengine/db';
import { DB_POOL } from '../database/database.module';

export interface MemberDashboard {
  member: {
    id: string;
    memberNo: number;
    firstName: string;
    lastName: string;
    email: string | null;
    status: string;
  };
  savingsTotal: number;
  shareBalance: number;
  loansOutstandingTotal: number;
  nextDue: { dueDate: string | null; amount: number } | null;
  recentTransactions: {
    type: string;
    signedAmount: number;
    runningBalance: number;
    description: string;
    createdAt: Date;
  }[];
}

@Injectable()
export class MemberSpaceService {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async me(organizationId: string, memberId: string): Promise<MemberDashboard['member']> {
    return withTenant(this.pool, organizationId, async (c) => {
      const { rows } = await c.query(
        `SELECT id, member_no, first_name, last_name, email, status
           FROM members WHERE organization_id = $1 AND id = $2`,
        [organizationId, memberId],
      );
      if (!rows[0]) throw new NotFoundException('Member not found');
      const m = rows[0] as Record<string, unknown>;
      return {
        id: m.id as string,
        memberNo: Number(m.member_no),
        firstName: m.first_name as string,
        lastName: m.last_name as string,
        email: (m.email as string | null) ?? null,
        status: m.status as string,
      };
    });
  }

  /** The member's ACTIVE virtual (collection) account, or null. */
  async virtualAccount(
    organizationId: string,
    memberId: string,
  ): Promise<{
    id: string;
    provider: string;
    accountNumber: string;
    accountName: string;
    bankName: string;
    status: string;
    createdAt: Date;
  } | null> {
    return withTenant(this.pool, organizationId, async (c) => {
      const { rows } = await c.query(
        `SELECT id, provider, account_number, account_name, bank_name, status, created_at
           FROM member_virtual_accounts
          WHERE organization_id = $1 AND member_id = $2 AND status = 'ACTIVE'
          ORDER BY created_at DESC LIMIT 1`,
        [organizationId, memberId],
      );
      if (!rows[0]) return null;
      const r = rows[0] as Record<string, unknown>;
      return {
        id: r.id as string,
        provider: r.provider as string,
        accountNumber: r.account_number as string,
        accountName: r.account_name as string,
        bankName: r.bank_name as string,
        status: r.status as string,
        createdAt: r.created_at as Date,
      };
    });
  }

  /** The member's inbound funding history (own account only). */
  async myPayments(
    organizationId: string,
    memberId: string,
    limit = 20,
  ): Promise<
    {
      id: string;
      paymentReference: string;
      amount: number;
      paidAt: Date;
      status: string;
    }[]
  > {
    const n = Math.min(Math.max(limit, 1), 100);
    return withTenant(this.pool, organizationId, async (c) => {
      const { rows } = await c.query(
        `SELECT id, payment_reference, amount, paid_at, status
           FROM payment_notifications
          WHERE organization_id = $1 AND member_id = $2
          ORDER BY paid_at DESC LIMIT $3`,
        [organizationId, memberId, n],
      );
      return rows.map((r: Record<string, unknown>) => ({
        id: r.id as string,
        paymentReference: r.payment_reference as string,
        amount: Number(r.amount),
        paidAt: r.paid_at as Date,
        status: r.status as string,
      }));
    });
  }
  async dashboard(
    organizationId: string,
    memberId: string,
  ): Promise<MemberDashboard> {
    return withTenant(this.pool, organizationId, async (c) => {
      const memberRow = await c.query(
        `SELECT id, member_no, first_name, last_name, email, status
           FROM members WHERE organization_id = $1 AND id = $2`,
        [organizationId, memberId],
      );
      if (!memberRow.rows[0]) throw new NotFoundException('Member not found');
      const m = memberRow.rows[0] as Record<string, unknown>;
      const member = {
        id: m.id as string,
        memberNo: Number(m.member_no),
        firstName: m.first_name as string,
        lastName: m.last_name as string,
        email: (m.email as string | null) ?? null,
        status: m.status as string,
      };

      const savings = await c.query(
        `SELECT COALESCE(SUM(current_balance), 0)::numeric AS total
           FROM member_savings_accounts
          WHERE organization_id = $1 AND member_id = $2 AND status = 'ACTIVE'`,
        [organizationId, memberId],
      );
      const savingsTotal = Number(
        (savings.rows[0] as { total: string }).total,
      );

      const shares = await c.query(
        `SELECT COALESCE(SUM(current_balance), 0)::numeric AS total
           FROM member_share_accounts
          WHERE organization_id = $1 AND member_id = $2 AND status = 'ACTIVE'`,
        [organizationId, memberId],
      );
      const shareBalance = Number((shares.rows[0] as { total: string }).total);

      const loans = await c.query(
        `SELECT COALESCE(SUM(outstanding_principal), 0)::numeric AS total
           FROM loans
          WHERE organization_id = $1 AND member_id = $2
            AND status IN ('APPROVED', 'DISBURSED', 'DEFAULTED')`,
        [organizationId, memberId],
      );
      const loansOutstandingTotal = Number(
        (loans.rows[0] as { total: string }).total,
      );

      // Earliest unpaid installment across the member's active loans
      const due = await c.query(
        `SELECT lr.due_date,
                (lr.principal_due + lr.interest_due - lr.paid_principal - lr.paid_interest) AS amount
           FROM loan_repayments lr
           JOIN loans l ON l.id = lr.loan_id
          WHERE l.organization_id = $1 AND l.member_id = $2
            AND l.status IN ('DISBURSED', 'DEFAULTED')
            AND (lr.paid_principal < lr.principal_due OR lr.paid_interest < lr.interest_due)
          ORDER BY lr.due_date ASC
          LIMIT 1`,
        [organizationId, memberId],
      );
      const dueRow = due.rows[0] as
        | { due_date: Date; amount: string }
        | undefined;
      const nextDue = dueRow
        ? {
            dueDate: (dueRow.due_date as Date).toISOString().slice(0, 10),
            amount: Number(dueRow.amount),
          }
        : null;

      const txns = await c.query(
        `SELECT t.type, t.signed_amount, t.running_balance, je.description, t.created_at
           FROM savings_transactions t
           JOIN member_savings_accounts a ON a.id = t.account_id
           JOIN journal_entries je ON je.id = t.journal_entry_id
          WHERE a.organization_id = $1 AND a.member_id = $2
          ORDER BY t.created_at DESC
          LIMIT 8`,
        [organizationId, memberId],
      );
      const recentTransactions = txns.rows.map((r: Record<string, unknown>) => ({
        type: r.type as string,
        signedAmount: Number(r.signed_amount),
        runningBalance: Number(r.running_balance),
        description: r.description as string,
        createdAt: r.created_at as Date,
      }));

      return {
        member,
        savingsTotal,
        shareBalance,
        loansOutstandingTotal,
        nextDue,
        recentTransactions,
      };
    });
  }
}
