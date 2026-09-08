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
       l.approved_at, l.disbursed_at, l.created_at, p.code AS product_code
  FROM loans l JOIN loan_products p ON p.id = l.loan_product_id`;

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
  ): Promise<LoanRow[]> {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const params: unknown[] = [orgId];
      let where = `l.organization_id = $1`;
      if (status) {
        params.push(status);
        where += ` AND l.status = $${params.length}`;
      }
      const { rows } = await c.query(
        `${selectLoan} WHERE ${where} ORDER BY l.created_at DESC LIMIT 200`,
        params,
      );
      return rows.map((r) => this.mapLoan(r as Record<string, unknown>));
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
          `SELECT l.id, l.member_id, l.principal FROM loans l
            WHERE l.organization_id = $1 AND l.id = $2`,
          [orgId, loanId],
        );
        const principal = Number(
          (loan.rows[0] as { principal: string }).principal,
        );
        await this.postDisbursement(
          c,
          orgId,
          actorUserId,
          loanId,
          (loan.rows[0] as { member_id: string }).member_id,
          principal,
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
      approvedAt: (row.approved_at as Date | null) ?? null,
      disbursedAt: (row.disbursed_at as Date | null) ?? null,
      createdAt: row.created_at as Date,
    };
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
