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
import { CreateLoanDto } from './dto/loans.dto';

export type LoanStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'DISBURSED'
  | 'COMPLETED'
  | 'DEFAULTED';

export interface LoanProductRow {
  id: string;
  code: string;
  name: string;
  interestRatePa: number;
  interestMethod: string;
  multiplier: number;
  status: string;
}

export interface LoanRow {
  id: string;
  memberId: string;
  productCode: string;
  principal: number;
  termMonths: number;
  interestRatePa: number;
  interestMethod: string;
  status: LoanStatus;
  outstandingPrincipal: number;
  rejectionReason: string | null;
  memberNo?: number;
  memberName?: string | null;
  approvedAt: Date | null;
  disbursedAt: Date | null;
  createdAt: Date;
}

export interface GuarantorRow {
  id: string;
  loanId: string;
  memberId: string;
  status: string;
}

const MIN_GUARANTORS = 2;
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

const ALLOWED_TRANSITIONS: Partial<Record<LoanStatus, LoanStatus[]>> = {
  PENDING: ['APPROVED', 'REJECTED'],
  APPROVED: ['DISBURSED', 'REJECTED'],
  REJECTED: [],
  DISBURSED: ['COMPLETED'],
  COMPLETED: [],
  DEFAULTED: [],
};

const selectLoan = `SELECT l.id, l.member_id, l.principal, l.term_months, l.interest_rate_pa,
       l.interest_method, l.status, l.outstanding_principal, l.rejection_reason,
       l.approved_at, l.disbursed_at, l.created_at, p.code AS product_code,
       m.member_no, m.first_name || ' ' || m.last_name AS member_name
  FROM loans l
  JOIN loan_products p ON p.id = l.loan_product_id
  LEFT JOIN members m ON m.id = l.member_id`;

@Injectable()
export class LoansService {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  private requireOrg(organizationId: string | null): string {
    if (!organizationId) {
      throw new ForbiddenException('Organization context required');
    }
    return organizationId;
  }

  async listProducts(organizationId: string | null): Promise<LoanProductRow[]> {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT id, code, name, interest_rate_pa, interest_method, multiplier, status
           FROM loan_products WHERE organization_id = $1 ORDER BY code`,
        [orgId],
      );
      return rows.map((r: Record<string, unknown>) => ({
        id: r.id as string,
        code: r.code as string,
        name: r.name as string,
        interestRatePa: Number(r.interest_rate_pa),
        interestMethod: r.interest_method as string,
        multiplier: Number(r.multiplier),
        status: r.status as string,
      }));
    });
  }

  async apply(
    organizationId: string | null,
    actorUserId: string,
    dto: CreateLoanDto,
  ): Promise<LoanRow> {
    const orgId = this.requireOrg(organizationId);
    const principal = round2(dto.principal);
    if (principal <= 0) throw new BadRequestException('Invalid principal');
    if (!Number.isInteger(dto.termMonths) || dto.termMonths < 1 || dto.termMonths > 60) {
      throw new BadRequestException('termMonths must be 1..60');
    }
    const guarantorIds = [...new Set(dto.guarantorIds ?? [])];
    if (guarantorIds.length < MIN_GUARANTORS) {
      throw new BadRequestException(
        `At least ${MIN_GUARANTORS} guarantors are required`,
      );
    }

    const loanId = randomUUID();
    await withTenant(this.pool, orgId, async (c) => {
      const member = await c.query(
        `SELECT id, status FROM members WHERE organization_id = $1 AND id = $2`,
        [orgId, dto.memberId],
      );
      const m = member.rows[0] as { id: string; status: string } | undefined;
      if (!m) throw new NotFoundException('Member not found');
      if (m.status !== 'ACTIVE') {
        throw new ConflictException('Only ACTIVE members can apply for loans');
      }

      const product = await c.query(
        `SELECT id, code, name, interest_rate_pa, interest_method, multiplier, status
           FROM loan_products WHERE organization_id = $1 AND id = $2`,
        [orgId, dto.productId],
      );
      const p = product.rows[0] as
        | { id: string; interest_rate_pa: string; interest_method: string; multiplier: string; status: string }
        | undefined;
      if (!p) throw new NotFoundException('Loan product not found');
      if (p.status !== 'ACTIVE') {
        throw new ConflictException('Loan product is not active');
      }

      // 3x multiplier guard (PRD FR-014): principal <= savings * multiplier
      const savings = await c.query(
        `SELECT COALESCE(SUM(current_balance), 0)::numeric AS total
           FROM member_savings_accounts
          WHERE organization_id = $1 AND member_id = $2 AND status = 'ACTIVE'`,
        [orgId, dto.memberId],
      );
      const savingsTotal = Number(
        (savings.rows[0] as { total: string }).total,
      );
      const maxLoan = round2(savingsTotal * Number(p.multiplier));
      if (principal > maxLoan) {
        throw new BadRequestException(
          `Principal ${principal} exceeds the ${p.multiplier}x savings limit of ${maxLoan}`,
        );
      }

      // Guarantors: distinct ACTIVE members, excluding the borrower
      if (guarantorIds.includes(dto.memberId)) {
        throw new BadRequestException('A member cannot guarantee their own loan');
      }
      const g = await c.query(
        `SELECT id FROM members
          WHERE organization_id = $1 AND id = ANY($2::uuid[]) AND status = 'ACTIVE'`,
        [orgId, guarantorIds],
      );
      const foundIds = new Set(
        (g.rows as { id: string }[]).map((r) => r.id),
      );
      const missing = guarantorIds.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        throw new BadRequestException(
          'Guarantors must be ACTIVE members of this cooperative',
        );
      }

      await c.query(
        `INSERT INTO loans (id, organization_id, member_id, loan_product_id, principal,
                            term_months, interest_rate_pa, interest_method, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING', $9)`,
        [
          loanId,
          orgId,
          dto.memberId,
          p.id,
          String(principal),
          dto.termMonths,
          p.interest_rate_pa,
          p.interest_method,
          actorUserId,
        ],
      );
      const values: string[] = [];
      const params: unknown[] = [];
      guarantorIds.forEach((memberId) => {
        const base = params.length;
        values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
        params.push(randomUUID(), orgId, loanId, memberId);
      });
      await c.query(
        `INSERT INTO loan_guarantors (id, organization_id, loan_id, member_id)
         VALUES ${values.join(', ')}`,
        params,
      );
      await c.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1, $2, 'loan.applied', 'loan', $3, $4)`,
        [orgId, actorUserId, loanId, JSON.stringify({ principal, termMonths: dto.termMonths })],
      );
    });
    return this.getLoan(orgId, loanId);
  }

  async list(
    organizationId: string | null,
    status?: string,
    limit?: number,
    offset?: number,
  ): Promise<{ items: LoanRow[]; total: number }> {
    const orgId = this.requireOrg(organizationId);
    const pageLimit = Math.min(Math.max(limit ?? 200, 1), 500);
    const pageOffset = Math.max(offset ?? 0, 0);
    return withTenant(this.pool, orgId, async (c) => {
      const params: unknown[] = [orgId, pageLimit, pageOffset];
      let where = `l.organization_id = $1`;
      if (status) {
        params.splice(params.length - 2, 0, status);
        where += ` AND l.status = $2`;
      }
      const { rows } = await c.query(
        `${selectLoan} WHERE ${where} ORDER BY l.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      const count = await c.query(
        `SELECT count(*)::int AS n FROM loans l WHERE l.organization_id = $1 ${status ? 'AND l.status = $2' : ''}`,
        status ? [orgId, status] : [orgId],
      );
      return {
        total: (count.rows[0] as { n: number }).n,
        items: rows.map((r) => this.mapLoan(r as Record<string, unknown>)),
      };
    });
  }

  async getLoan(organizationId: string | null, loanId: string): Promise<LoanRow> {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `${selectLoan} WHERE l.organization_id = $1 AND l.id = $2`,
        [orgId, loanId],
      );
      if (!rows[0]) throw new NotFoundException('Loan not found');
      return this.mapLoan(rows[0] as Record<string, unknown>);
    });
  }

  async listGuarantors(
    organizationId: string | null,
    loanId: string,
  ): Promise<GuarantorRow[]> {
    const orgId = this.requireOrg(organizationId);
    await this.getLoan(orgId, loanId);
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT id, loan_id, member_id, status FROM loan_guarantors
          WHERE organization_id = $1 AND loan_id = $2`,
        [orgId, loanId],
      );
      return rows as GuarantorRow[];
    });
  }

  /** Attach a guarantor to a PENDING loan (staff, with consent recorded). */
  async addGuarantor(
    organizationId: string | null,
    actorUserId: string,
    loanId: string,
    memberId: string,
  ): Promise<{ id: string }> {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const loan = await c.query(
        `SELECT id, status FROM loans WHERE organization_id = $1 AND id = $2`,
        [orgId, loanId],
      );
      const l = loan.rows[0] as { id: string; status: string } | undefined;
      if (!l) throw new NotFoundException('Loan not found');
      if (l.status !== 'PENDING') {
        throw new ConflictException('Guarantors can only be added while the loan is PENDING');
      }
      const member = await c.query(
        `SELECT id, status FROM members WHERE organization_id = $1 AND id = $2`,
        [orgId, memberId],
      );
      const m = member.rows[0] as { id: string; status: string } | undefined;
      if (!m) throw new NotFoundException('Guarantor member not found');
      if (m.status !== 'ACTIVE') throw new ConflictException('Guarantor must be an ACTIVE member');
      const dup = await c.query(
        `SELECT 1 FROM loan_guarantors WHERE organization_id = $1 AND loan_id = $2 AND member_id = $3`,
        [orgId, loanId, memberId],
      );
      if (dup.rows.length > 0) throw new ConflictException('Member is already a guarantor');
      const count = await c.query(
        `SELECT count(*) AS n FROM loan_guarantors WHERE organization_id = $1 AND loan_id = $2`,
        [orgId, loanId],
      );
      if (Number(count.rows[0].n) >= 5) throw new ConflictException('Guarantor limit reached');
      const id = randomUUID();
      await c.query(
        `INSERT INTO loan_guarantors (id, organization_id, loan_id, member_id, status)
         VALUES ($1, $2, $3, $4, 'PENDING')`,
        [id, orgId, loanId, memberId],
      );
      await c.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1, $2, 'loan.guarantor.added', 'loan', $3, $4)`,
        [orgId, actorUserId, loanId, JSON.stringify({ memberId })],
      );
      return { id };
    });
  }

  async transition(
    organizationId: string | null,
    actorUserId: string,
    loanId: string,
    target: Extract<LoanStatus, 'APPROVED' | 'REJECTED' | 'DISBURSED'>,
    reason?: string,
  ): Promise<LoanRow> {
    const orgId = this.requireOrg(organizationId);
    if (target === 'REJECTED' && !reason?.trim()) {
      throw new BadRequestException('A rejection reason is required');
    }
    await withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT l.id, l.status, l.member_id FROM loans l
          WHERE l.organization_id = $1 AND l.id = $2`,
        [orgId, loanId],
      );
      const current = rows[0] as
        | { id: string; status: LoanStatus; member_id: string }
        | undefined;
      if (!current) throw new NotFoundException('Loan not found');
      const allowed = ALLOWED_TRANSITIONS[current.status] ?? [];
      if (!allowed.includes(target)) {
        throw new ConflictException(
          `Invalid transition ${current.status} -> ${target}`,
        );
      }

      if (target === 'APPROVED') {
        const g = await c.query(
          `SELECT count(*) AS n FROM loan_guarantors
            WHERE organization_id = $1 AND loan_id = $2`,
          [orgId, loanId],
        );
        if (Number(g.rows[0].n) < MIN_GUARANTORS) {
          throw new ConflictException(
            `At least ${MIN_GUARANTORS} guarantors are required before approval`,
          );
        }
        await c.query(
          `UPDATE loans SET status = 'APPROVED', approved_by = $1, approved_at = now()
            WHERE id = $2`,
          [actorUserId, loanId],
        );
        await c.query(
          `UPDATE loan_guarantors SET status = 'APPROVED'
            WHERE organization_id = $1 AND loan_id = $2`,
          [orgId, loanId],
        );
      } else if (target === 'REJECTED') {
        await c.query(
          `UPDATE loans SET status = 'REJECTED', rejection_reason = $1, approved_by = $2
            WHERE id = $3`,
          [reason, actorUserId, loanId],
        );
      } else if (target === 'DISBURSED') {
        // Disburse: update loan + post the balanced journal atomically.
        const loan = await c.query(
          `SELECT l.id, l.member_id, l.principal, l.term_months,
                  l.interest_rate_pa, l.interest_method
             FROM loans l
            WHERE l.organization_id = $1 AND l.id = $2`,
          [orgId, loanId],
        );
        const loanRow = loan.rows[0] as {
          member_id: string;
          principal: string;
          term_months: number | string;
          interest_rate_pa: string;
          interest_method: string;
        };
        const principal = Number(loanRow.principal);
        await this.postDisbursement(
          c,
          orgId,
          actorUserId,
          loanId,
          loanRow.member_id,
          principal,
        );
        await this.generateSchedule(
          c,
          orgId,
          loanId,
          Number(loanRow.term_months),
          principal,
          Number(loanRow.interest_rate_pa),
          loanRow.interest_method,
        );
        await c.query(
          `UPDATE loans
              SET status = 'DISBURSED', disbursed_by = $1, disbursed_at = now(),
                  outstanding_principal = $2
            WHERE id = $3`,
          [actorUserId, String(principal), loanId],
        );
      }
      await c.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1, $2, $3, 'loan', $4, $5)`,
        [
          orgId,
          actorUserId,
          `loan.status.${target.toLowerCase()}`,
          loanId,
          JSON.stringify({ from: current.status, to: target, reason: reason ?? null }),
        ],
      );
      void current;
    });
    return this.getLoan(orgId, loanId);
  }

  // ------------------------------------------------------------- helpers

  /**
   * Flat-interest schedule (interest = principal * ratePa/100 * months/12).
   * Monthly installments of equal size; the last one absorbs rounding.
   */
  private async generateSchedule(
    c: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
    orgId: string,
    loanId: string,
    termMonths: number,
    principal: number,
    interestRatePa: number,
    interestMethod: string,
  ): Promise<void> {
    if (interestMethod !== 'FLAT') {
      throw new BadRequestException(
        `Schedule generation only supports FLAT interest (got ${interestMethod})`,
      );
    }
    const totalInterest = round2((principal * interestRatePa * termMonths) / 1200);
    const basePrincipal = Math.floor((principal * 100) / termMonths) / 100;
    const baseInterest = Math.floor((totalInterest * 100) / termMonths) / 100;
    const values: string[] = [];
    const params: unknown[] = [];
    let remainingP = principal;
    let remainingI = totalInterest;
    const today = new Date();
    for (let seq = 1; seq <= termMonths; seq += 1) {
      const last = seq === termMonths;
      const p = last ? round2(remainingP) : Math.min(basePrincipal, round2(remainingP));
      const i = last ? round2(remainingI) : Math.min(baseInterest, round2(remainingI));
      remainingP = round2(remainingP - p);
      remainingI = round2(remainingI - i);
      const due = new Date(today);
      due.setUTCMonth(due.getUTCMonth() + seq);
      const base = params.length;
      values.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::date, $${base + 6}, $${base + 7})`,
      );
      params.push(
        randomUUID(),
        orgId,
        loanId,
        seq,
        due.toISOString().slice(0, 10),
        String(p),
        String(i),
      );
    }
    await c.query(
      `INSERT INTO loan_repayments (id, organization_id, loan_id, seq, due_date, principal_due, interest_due)
       VALUES ${values.join(', ')}`,
      params,
    );
  }

  async listSchedule(
    organizationId: string | null,
    loanId: string,
  ): Promise<
    {
      seq: number;
      dueDate: string;
      principalDue: number;
      interestDue: number;
      paidPrincipal: number;
      paidInterest: number;
      status: string;
    }[]
  > {
    const orgId = this.requireOrg(organizationId);
    await this.getLoan(orgId, loanId);
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT seq, due_date, principal_due, interest_due,
                paid_principal, paid_interest
           FROM loan_repayments
          WHERE organization_id = $1 AND loan_id = $2
          ORDER BY seq`,
        [orgId, loanId],
      );
      const today = new Date().toISOString().slice(0, 10);
      return rows.map((r: Record<string, unknown>) => {
        const paidPrincipal = Number(r.paid_principal);
        const paidInterest = Number(r.paid_interest);
        const principalDue = Number(r.principal_due);
        const interestDue = Number(r.interest_due);
        let status = 'PENDING';
        if (paidPrincipal >= principalDue && paidInterest >= interestDue) {
          status = 'PAID';
        } else if (paidPrincipal > 0 || paidInterest > 0) {
          status = 'PARTIAL';
        } else if ((r.due_date as Date).toISOString().slice(0, 10) < today) {
          status = 'OVERDUE';
        }
        return {
          seq: Number(r.seq),
          dueDate: (r.due_date as Date).toISOString().slice(0, 10),
          principalDue,
          interestDue,
          paidPrincipal,
          paidInterest,
          status,
        };
      });
    });
  }

  /**
   * Capture a loan repayment. Allocation follows the decision-log order
   * (penalties -> fees -> interest -> principal) across the schedule in due
   * order; posts the balanced journal Dr Cash / Cr Loan Receivables (principal
   * part) + Cr Loan Interest Income (interest part) in the same transaction.
   */
  async captureRepayment(
    organizationId: string | null,
    actorUserId: string,
    loanId: string,
    amount: number,
    description?: string,
    idempotencyKey?: string,
  ): Promise<{ loan: LoanRow }> {
    const orgId = this.requireOrg(organizationId);
    const value = round2(amount);
    if (value <= 0) throw new BadRequestException('Invalid repayment amount');
    await withTenant(this.pool, orgId, async (c) => {
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
      const loan = await c.query(
        `SELECT l.id, l.member_id, l.status, l.outstanding_principal
           FROM loans l WHERE l.organization_id = $1 AND l.id = $2 FOR UPDATE`,
        [orgId, loanId],
      );
      const loanRow = loan.rows[0] as
        | { id: string; member_id: string; status: string; outstanding_principal: string }
        | undefined;
      if (!loanRow) throw new NotFoundException('Loan not found');
      if (loanRow.status !== 'DISBURSED') {
        throw new ConflictException('Loan is not in repayment (DISBURSED) state');
      }

      const schedule = await c.query(
        `SELECT id, principal_due, interest_due, paid_principal, paid_interest
           FROM loan_repayments
          WHERE organization_id = $1 AND loan_id = $2
            AND (paid_principal < principal_due OR paid_interest < interest_due)
          ORDER BY seq
          FOR UPDATE`,
        [orgId, loanId],
      );
      const rows = schedule.rows as {
        id: string;
        principal_due: string;
        interest_due: string;
        paid_principal: string;
        paid_interest: string;
      }[];
      if (rows.length === 0) {
        throw new ConflictException('Loan has no outstanding installments');
      }
      const totalRemaining = round2(
        rows.reduce(
          (acc, r) =>
            acc +
            Number(r.principal_due) +
            Number(r.interest_due) -
            Number(r.paid_principal) -
            Number(r.paid_interest),
          0,
        ),
      );
      if (value > totalRemaining) {
        throw new BadRequestException(
          `Repayment ${value} exceeds the outstanding balance of ${totalRemaining}`,
        );
      }

      // Allocate: interest before principal within each installment in due order
      let remaining = value;
      let principalPortion = 0;
      let interestPortion = 0;
      for (const row of rows) {
        if (remaining <= 0) break;
        const remInterest = round2(
          Number(row.interest_due) - Number(row.paid_interest),
        );
        const takeInterest = Math.min(remInterest, remaining);
        const remPrincipal = round2(
          Number(row.principal_due) - Number(row.paid_principal),
        );
        const takePrincipal = Math.min(remPrincipal, remaining - takeInterest);
        if (takeInterest > 0 || takePrincipal > 0) {
          const newPaidInterest = round2(Number(row.paid_interest) + takeInterest);
          const newPaidPrincipal = round2(Number(row.paid_principal) + takePrincipal);
          const done =
            newPaidInterest >= Number(row.interest_due) &&
            newPaidPrincipal >= Number(row.principal_due);
          await c.query(
            `UPDATE loan_repayments
                SET paid_interest = $1, paid_principal = $2,
                    status = $3
              WHERE organization_id = $4 AND id = $5`,
            [
              String(newPaidInterest),
              String(newPaidPrincipal),
              done ? 'PAID' : 'PARTIAL',
              orgId,
              row.id,
            ],
          );
          interestPortion = round2(interestPortion + takeInterest);
          principalPortion = round2(principalPortion + takePrincipal);
          remaining = round2(remaining - takeInterest - takePrincipal);
        }
      }

      // Journal: Dr Cash / Cr Loan Receivables (principal) + Cr Interest Income
      const entryId = randomUUID();
      await this.postRepaymentJournal(
        c,
        orgId,
        actorUserId,
        loanId,
        loanRow.member_id,
        value,
        principalPortion,
        interestPortion,
        idempotencyKey ?? null,
        description,
      );

      const outstanding = round2(
        Number(loanRow.outstanding_principal) - principalPortion,
      );
      await c.query(
        `UPDATE loans
            SET outstanding_principal = $1,
                status = CASE WHEN $1::numeric <= 0 THEN 'COMPLETED' ELSE status END
          WHERE organization_id = $2 AND id = $3`,
        [String(outstanding), orgId, loanId],
      );
      await c.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1, $2, 'loan.repayment', 'loan', $3, $4)`,
        [
          orgId,
          actorUserId,
          loanId,
          JSON.stringify({
            amount: value,
            principal: principalPortion,
            interest: interestPortion,
            outstanding,
          }),
        ],
      );
    });
    const loan = await this.getLoan(orgId, loanId);
    return { loan };
  }

  private async postRepaymentJournal(
    c: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
    orgId: string,
    actorUserId: string,
    loanId: string,
    memberId: string,
    amount: number,
    principalPortion: number,
    interestPortion: number,
    idempotencyKey: string | null,
    description: string | undefined,
  ): Promise<void> {
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
       VALUES ($1, $2, $3, now()::date, $4, 'LOAN_REPAYMENT', 'loan', $5,
               'POSTED', $6, $7, $8, $8, now())`,
      [
        entryId,
        orgId,
        periodId,
        description ?? `Loan repayment ${String(amount)}`,
        loanId,
        entryNo,
        idempotencyKey,
        actorUserId,
      ],
    );
    const accRes = await c.query(
      `SELECT id, code FROM chart_of_accounts
        WHERE organization_id = $1 AND code = ANY($2::varchar[])`,
      [orgId, ['1000', '1020', '4000']],
    );
    const idByCode = new Map<string, string>();
    for (const r of accRes.rows as { id: string; code: string }[]) {
      idByCode.set(r.code, r.id);
    }
    const missing = ['1000', '1020', '4000'].find((code) => !idByCode.has(code));
    if (missing) throw new BadRequestException(`Unknown account code: ${missing}`);
    // Lines: 1 debit + up to 2 credits (interest credit only when > 0)
    const creditClauses: string[] = [];
    const params: unknown[] = [orgId, entryId, idByCode.get('1000'), String(round2(amount)), memberId];
    if (principalPortion > 0) {
      creditClauses.push(
        `($1, $2, $${params.length + 1}, '0', $${params.length + 2}, $5)`,
      );
      params.push(idByCode.get('1020'), String(round2(principalPortion)));
    }
    if (interestPortion > 0) {
      creditClauses.push(
        `($1, $2, $${params.length + 1}, '0', $${params.length + 2}, $5)`,
      );
      params.push(idByCode.get('4000'), String(round2(interestPortion)));
    }
    if (creditClauses.length === 0) {
      throw new BadRequestException('Nothing to post — both portions are zero');
    }
    await c.query(
      `INSERT INTO journal_lines (organization_id, journal_entry_id, account_id, debit, credit, member_id)
       VALUES ($1, $2, $3, $4, '0', $5), ${creditClauses.join(', ')}`,
      params,
    );
    await c.query(
      `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, $2, 'journal.auto.posted', 'journal_entry', $3, $4)`,
      [
        orgId,
        actorUserId,
        entryId,
        JSON.stringify({ entryNo, source: 'LOAN_REPAYMENT', loanId }),
      ],
    );
  }

  // ------------------------------------------------------------- helpers

  private mapLoan(row: Record<string, unknown>): LoanRow {
    return {
      id: row.id as string,
      memberId: row.member_id as string,
      productCode: row.product_code as string,
      principal: Number(row.principal),
      termMonths: Number(row.term_months),
      interestRatePa: Number(row.interest_rate_pa),
      interestMethod: row.interest_method as string,
      status: row.status as LoanStatus,
      outstandingPrincipal: Number(row.outstanding_principal),
      rejectionReason: (row.rejection_reason as string | null) ?? null,
      memberNo: row.member_no === null || row.member_no === undefined ? undefined : Number(row.member_no),
      memberName: (row.member_name as string | null | undefined) ?? null,
      approvedAt: (row.approved_at as Date | null) ?? null,
      disbursedAt: (row.disbursed_at as Date | null) ?? null,
      createdAt: row.created_at as Date,
    };
  }

  /** Repayment events for a loan (journal-sourced, principal/interest split). */
  async repaymentsHistory(
    organizationId: string | null,
    loanId: string,
  ): Promise<
    {
      entryNo: number;
      entryDate: string;
      description: string;
      principalPortion: number;
      interestPortion: number;
      postedAt: Date;
    }[]
  > {
    const orgId = this.requireOrg(organizationId);
    await this.getLoan(orgId, loanId); // 404 if not this tenant's loan
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT je.entry_no, je.entry_date, je.description, je.posted_at,
                COALESCE(SUM(CASE WHEN a.code = '1020' THEN jl.credit ELSE 0 END), 0)::numeric AS principal_portion,
                COALESCE(SUM(CASE WHEN a.code = '4000' THEN jl.credit ELSE 0 END), 0)::numeric AS interest_portion
           FROM journal_entries je
           JOIN journal_lines jl ON jl.journal_entry_id = je.id
           JOIN chart_of_accounts a ON a.id = jl.account_id
          WHERE je.organization_id = $1
            AND je.source = 'LOAN_REPAYMENT'
            AND je.source_id = $2
          GROUP BY je.id
          ORDER BY je.posted_at ASC`,
        [orgId, loanId],
      );
      return rows.map((r: Record<string, unknown>) => ({
        entryNo: Number(r.entry_no),
        entryDate: (r.entry_date as Date).toISOString().slice(0, 10),
        description: r.description as string,
        principalPortion: Number(r.principal_portion),
        interestPortion: Number(r.interest_portion),
        postedAt: r.posted_at as Date,
      }));
    });
  }

  /**
   * Disbursement journal: Dr Loan Receivables (1020) / Cr Cash at Bank (1000),
   * POSTED immediately with a sequential number, member-linked lines.
   */
  private async postDisbursement(
    c: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
    orgId: string,
    actorUserId: string,
    loanId: string,
    memberId: string,
    principal: number,
  ): Promise<void> {
    const period = await c.query(
      `SELECT id FROM ledger_periods
        WHERE organization_id = $1 AND status = 'OPEN'
          AND now()::date BETWEEN start_date AND end_date
        ORDER BY start_date DESC LIMIT 1`,
      [orgId],
    );
    const periodId = (period.rows[0] as { id: string } | undefined)?.id;
    if (!periodId) {
      throw new ConflictException('No OPEN accounting period for today — cannot disburse');
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
          source_type, source_id, status, entry_no, created_by, posted_by, posted_at)
       VALUES ($1, $2, $3, now()::date, $4, 'LOAN_DISBURSEMENT', 'loan', $5,
               'POSTED', $6, $7, $7, now())`,
      [
        entryId,
        orgId,
        periodId,
        `Loan disbursement ${String(principal)}`,
        loanId,
        entryNo,
        actorUserId,
      ],
    );
    const accRes = await c.query(
      `SELECT id, code FROM chart_of_accounts
        WHERE organization_id = $1 AND code = ANY($2::varchar[])`,
      [orgId, ['1020', '1000']],
    );
    const idByCode = new Map<string, string>();
    for (const r of accRes.rows as { id: string; code: string }[]) {
      idByCode.set(r.code, r.id);
    }
    const missing = ['1020', '1000'].find((code) => !idByCode.has(code));
    if (missing) {
      throw new BadRequestException(`Unknown account code: ${missing}`);
    }
    await c.query(
      `INSERT INTO journal_lines (organization_id, journal_entry_id, account_id, debit, credit, member_id)
       VALUES ($1, $2, $3, $4, '0', $5),
              ($1, $2, $6, '0', $4, $5)`,
      [
        orgId,
        entryId,
        idByCode.get('1020'),
        String(round2(principal)),
        memberId,
        idByCode.get('1000'),
      ],
    );
    await c.query(
      `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, $2, 'journal.auto.posted', 'journal_entry', $3, $4)`,
      [
        orgId,
        actorUserId,
        entryId,
        JSON.stringify({ entryNo, source: 'LOAN_DISBURSEMENT', loanId }),
      ],
    );
  }
}
