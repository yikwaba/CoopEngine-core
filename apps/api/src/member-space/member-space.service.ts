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

  /** Notifications addressed to this member. */
  async listMyNotifications(
    organizationId: string,
    memberId: string,
    limit = 50,
    offset = 0,
  ): Promise<{ items: unknown[]; total: number }> {
    return withTenant(this.pool, organizationId, async (c) => {
      const take = Math.min(Math.max(limit, 1), 200);
      const skip = Math.max(offset, 0);
      const total = await c.query(
        `SELECT count(*) AS n FROM notifications WHERE member_id = $1`,
        [memberId],
      );
      const rows = await c.query(
        `SELECT id, type, title, body, read_at, created_at
           FROM notifications WHERE member_id = $1
          ORDER BY created_at DESC LIMIT ${take} OFFSET ${skip}`,
        [memberId],
      );
      return {
        items: rows.rows.map((r) => ({
          id: r.id as string,
          type: r.type as string,
          title: r.title as string,
          body: r.body as string,
          readAt: (r.read_at as Date | null) ?? null,
          createdAt: r.created_at as Date,
        })),
        total: Number((total.rows[0] as { n: string | number }).n),
      };
    });
  }

  /** Mark one (or all) of this member's notifications as read. */
  async markNotificationRead(
    organizationId: string,
    memberId: string,
    notificationId?: string,
  ): Promise<{ updated: number }> {
    return withTenant(this.pool, organizationId, async (c) => {
      const res = notificationId
        ? await c.query(
            `UPDATE notifications SET read_at = now() WHERE id = $1 AND member_id = $2`,
            [notificationId, memberId],
          )
        : await c.query(
            `UPDATE notifications SET read_at = now() WHERE member_id = $1 AND read_at IS NULL`,
            [memberId],
          );
      return { updated: res.rowCount ?? 0 };
    });
  }

  /** Dividend payouts received by this member. */
  async myDividends(
    organizationId: string,
    memberId: string,
  ): Promise<{ periodLabel: string; amount: number; postedAt: Date }[]> {
    return withTenant(this.pool, organizationId, async (c) => {
      const { rows } = await c.query(
        `SELECT run.period_label, a.amount, run.created_at
           FROM dividend_allocations a
           JOIN dividend_runs run ON run.id = a.run_id
          WHERE a.member_id = $1
          ORDER BY run.period_label DESC`,
        [memberId],
      );
      return rows.map((r) => ({
        periodLabel: r.period_label as string,
        amount: Number(r.amount),
        postedAt: r.created_at as Date,
      }));
    });
  }

  /** Guarantor requests addressed to this member (their own consent queue). */
  async myGuarantorRequests(
    organizationId: string,
    memberId: string,
  ): Promise<
    {
      id: string;
      loanId: string;
      borrowerName: string;
      principal: number;
      termMonths: number;
      loanStatus: string;
      status: string;
      requestedAt: Date;
    }[]
  > {
    return withTenant(this.pool, organizationId, async (c) => {
      const { rows } = await c.query(
        `SELECT g.id, g.loan_id, g.status, g.created_at,
                l.principal, l.term_months, l.status AS loan_status,
                (b.first_name || ' ' || b.last_name) AS borrower_name
           FROM loan_guarantors g
           JOIN loans l ON l.id = g.loan_id
           JOIN members b ON b.id = l.member_id
          WHERE g.member_id = $1
          ORDER BY g.created_at DESC`,
        [memberId],
      );
      return rows.map((r) => ({
        id: r.id as string,
        loanId: r.loan_id as string,
        borrowerName: r.borrower_name as string,
        principal: Number(r.principal),
        termMonths: Number(r.term_months),
        loanStatus: r.loan_status as string,
        status: r.status as string,
        requestedAt: r.created_at as Date,
      }));
    });
  }

  /** Accept or decline a guarantor request (own requests only, PENDING loans). */
  async respondGuarantor(
    organizationId: string,
    memberId: string,
    requestId: string,
    accept: boolean,
  ): Promise<{ id: string; status: string }> {
    return withTenant(this.pool, organizationId, async (c) => {
      const { rows } = await c.query(
        `SELECT g.id, g.status, g.loan_id, l.status AS loan_status
           FROM loan_guarantors g
           JOIN loans l ON l.id = g.loan_id
          WHERE g.id = $1 AND g.member_id = $2`,
        [requestId, memberId],
      );
      const g = rows[0] as
        | { id: string; status: string; loan_id: string; loan_status: string }
        | undefined;
      if (!g) throw new NotFoundException('Guarantor request not found');
      if (g.loan_status !== 'PENDING') {
        throw new ConflictException('This loan is no longer awaiting guarantors');
      }
      const status = accept ? 'APPROVED' : 'REJECTED';
      await c.query(`UPDATE loan_guarantors SET status = $1 WHERE id = $2`, [status, requestId]);
      await c.query(
        `INSERT INTO audit_logs (organization_id, action, entity_type, entity_id, metadata)
         VALUES ($1, 'loan.guarantor.responded', 'loan', $2, $3)`,
        [organizationId, g.loan_id, JSON.stringify({ guarantorId: requestId, memberId, status })],
      );
      return { id: requestId, status };
    });
  }

  /** ACTIVE loan products a member may apply for. */
  async loanProducts(
    organizationId: string,
  ): Promise<
    {
      id: string;
      code: string;
      name: string;
      interestRatePa: number;
      interestMethod: string;
      multiplier: number;
      minPrincipal: number;
      maxPrincipal: number | null;
    }[]
  > {
    return withTenant(this.pool, organizationId, async (c) => {
      const { rows } = await c.query(
        `SELECT id, code, name, interest_rate_pa, interest_method, multiplier,
                min_principal, max_principal
           FROM loan_products WHERE status = 'ACTIVE' ORDER BY code`,
      );
      return rows.map((r) => ({
        id: r.id as string,
        code: r.code as string,
        name: r.name as string,
        interestRatePa: Number(r.interest_rate_pa),
        interestMethod: r.interest_method as string,
        multiplier: Number(r.multiplier),
        minPrincipal: Number(r.min_principal),
        maxPrincipal: r.max_principal === null ? null : Number(r.max_principal),
      }));
    });
  }

  /** Member-initiated loan application (creates a PENDING loan). */
  async applyForLoan(
    organizationId: string,
    memberId: string,
    input: { loanProductId: string; principal: number; termMonths: number },
  ): Promise<{ id: string; status: string }> {
    if (!Number.isFinite(input.principal) || input.principal <= 0) {
      throw new BadRequestException('Invalid principal');
    }
    if (!Number.isInteger(input.termMonths) || input.termMonths < 1 || input.termMonths > 60) {
      throw new BadRequestException('termMonths must be 1..60');
    }
    return withTenant(this.pool, organizationId, async (c) => {
      const member = await c.query(`SELECT status FROM members WHERE id = $1`, [memberId]);
      const m = member.rows[0] as { status: string } | undefined;
      if (!m) throw new NotFoundException('Member not found');
      if (m.status !== 'ACTIVE') throw new ConflictException('Member is not active');

      const open = await c.query(
        `SELECT 1 FROM loans
          WHERE member_id = $1 AND status IN ('PENDING','APPROVED','DISBURSED','DEFAULTED')`,
        [memberId],
      );
      if (open.rows.length > 0) throw new ConflictException('You already have an open loan');

      const prod = await c.query(
        `SELECT id, interest_rate_pa, interest_method, multiplier, min_principal, max_principal, status
           FROM loan_products WHERE id = $1`,
        [input.loanProductId],
      );
      const p = prod.rows[0] as
        | {
            id: string; interest_rate_pa: string; interest_method: string; multiplier: string;
            min_principal: string; max_principal: string | null; status: string;
          }
        | undefined;
      if (!p) throw new NotFoundException('Loan product not found');
      if (p.status !== 'ACTIVE') throw new ConflictException('Loan product is not available');
      if (input.principal < Number(p.min_principal)) {
        throw new BadRequestException(`Minimum principal is ${Number(p.min_principal)}`);
      }
      if (p.max_principal !== null && input.principal > Number(p.max_principal)) {
        throw new BadRequestException(`Maximum principal is ${Number(p.max_principal)}`);
      }

      const savings = await c.query(
        `SELECT coalesce(sum(current_balance), 0) AS total
           FROM member_savings_accounts WHERE member_id = $1 AND status = 'ACTIVE'`,
        [memberId],
      );
      const savingsTotal = Number((savings.rows[0] as { total: string }).total);
      const cap = savingsTotal * Number(p.multiplier);
      if (input.principal > cap) {
        throw new BadRequestException(
          `Principal exceeds ${Number(p.multiplier)}x your savings (max ${cap.toFixed(2)})`,
        );
      }

      const id = randomUUID();
      await c.query(
        `INSERT INTO loans (id, organization_id, member_id, loan_product_id, principal,
                            term_months, interest_rate_pa, interest_method, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING')`,
        [id, organizationId, memberId, p.id, String(input.principal), input.termMonths,
         p.interest_rate_pa, p.interest_method],
      );
      await c.query(
        `INSERT INTO audit_logs (organization_id, action, entity_type, entity_id, metadata)
         VALUES ($1, 'loan.applied', 'loan', $2, $3)`,
        [organizationId, id, JSON.stringify({ via: 'member-self-service', ...input })],
      );
      return { id, status: 'PENDING' };
    });
  }

  /** The member's own loans with next due installment. */
  async myLoans(
    organizationId: string,
    memberId: string,
  ): Promise<
    {
      id: string;
      productCode: string;
      productName: string;
      principal: number;
      outstandingPrincipal: number;
      termMonths: number;
      status: string;
      appliedAt: Date;
      nextDueDate: string | null;
      nextDueAmount: number;
    }[]
  > {
    return withTenant(this.pool, organizationId, async (c) => {
      const { rows } = await c.query(
        `SELECT l.id, l.principal, l.outstanding_principal, l.term_months, l.status, l.created_at,
                p.code AS product_code, p.name AS product_name,
                (SELECT min(r.due_date) FROM loan_repayments r
                  WHERE r.loan_id = l.id AND r.status <> 'PAID') AS next_due_date,
                (SELECT (r.principal_due - coalesce(r.paid_principal, 0))
                       + (r.interest_due - coalesce(r.paid_interest, 0))
                   FROM loan_repayments r
                  WHERE r.loan_id = l.id AND r.status <> 'PAID'
                  ORDER BY r.seq LIMIT 1) AS next_due_amount
           FROM loans l
           JOIN loan_products p ON p.id = l.loan_product_id
          WHERE l.member_id = $1
          ORDER BY l.created_at DESC`,
        [memberId],
      );
      return rows.map((r) => ({
        id: r.id as string,
        productCode: r.product_code as string,
        productName: r.product_name as string,
        principal: Number(r.principal),
        outstandingPrincipal: Number(r.outstanding_principal),
        termMonths: Number(r.term_months),
        status: r.status as string,
        appliedAt: r.created_at as Date,
        nextDueDate: (r.next_due_date as string | null) ?? null,
        nextDueAmount: r.next_due_amount === null ? 0 : Number(r.next_due_amount),
      }));
    });
  }
}
