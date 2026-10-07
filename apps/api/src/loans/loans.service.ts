import { financialIntent } from '../common/financial-intent';
import { flatLoanInstallments, loanCeiling, moneyDecimal, moneyKobo } from '../common/money';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { withTenant } from '@coopengine/db';
import { enqueueNotification, outboundChannels } from '../notifications/enqueue';
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
    if (!dto.idempotencyKey) throw new BadRequestException('idempotencyKey is required for loan application retries');
    return financialIntent(this.pool, orgId, 'loans.apply', dto.idempotencyKey,
      { actorUserId, memberId: dto.memberId, productId: dto.productId, principal: dto.principal,
        termMonths: dto.termMonths, guarantorIds: dto.guarantorIds }, async (c) => {
      const principalKobo = moneyKobo(dto.principal);
      const principal = moneyDecimal(principalKobo);
      if (principalKobo <= 0n) throw new BadRequestException('Invalid principal');
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
      const maxLoanKobo = loanCeiling((savings.rows[0] as { total: string }).total, p.multiplier);
      if (principalKobo > maxLoanKobo) {
        throw new BadRequestException(
          `Principal ${principal} exceeds the ${p.multiplier}x savings limit of ${moneyDecimal(maxLoanKobo)}`,
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
      const result = await c.query(`${selectLoan} WHERE l.organization_id=$1 AND l.id=$2`, [orgId, loanId]);
      return this.mapLoan(result.rows[0] as Record<string, unknown>);
    });
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
    return financialIntent(this.pool,orgId,`loans.${target.toLowerCase()}`,`entity:${loanId}`,
      {actorUserId,loanId,target,reason:reason?.trim()??null},async (c) => {
      const { rows } = await c.query(
        `SELECT l.id, l.status, l.member_id FROM loans l
          WHERE l.organization_id = $1 AND l.id = $2 FOR UPDATE`,
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
            WHERE organization_id = $1 AND loan_id = $2 AND status <> 'REJECTED'`,
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
          [reason?.trim(), actorUserId, loanId],
        );
      } else if (target === 'DISBURSED') {
        // Disburse: update loan + post the balanced journal atomically.
        const loan = await c.query(
          `SELECT l.id, l.member_id, l.principal, l.term_months,
                  l.interest_rate_pa, l.interest_method
             FROM loans l
            WHERE l.organization_id = $1 AND l.id = $2 FOR UPDATE`,
          [orgId, loanId],
        );
        const loanRow = loan.rows[0] as {
          member_id: string;
          principal: string;
          term_months: number | string;
          interest_rate_pa: string;
          interest_method: string;
        };
        const principal = moneyDecimal(moneyKobo(loanRow.principal));
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
          loanRow.interest_rate_pa,
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
      if (target === 'APPROVED' || target === 'DISBURSED') {
        await enqueueNotification(c, {
          organizationId: orgId,
          memberId: current.member_id,
          type: target === 'APPROVED' ? 'LOAN_APPROVED' : 'LOAN_DISBURSED',
          title: target === 'APPROVED' ? 'Loan approved' : 'Loan disbursed',
          body:
            target === 'APPROVED'
              ? 'Your loan application has been approved and is awaiting disbursement.'
              : 'Your loan has been disbursed. Check your schedule for repayment dates.',
          channels: outboundChannels(),
          metadata: {
            loanId,
            status: target,
            amount: Number((current as { principal?: unknown }).principal ?? 0),
          },
        });
      }
      const result=await c.query(`${selectLoan} WHERE l.organization_id=$1 AND l.id=$2`,[orgId,loanId]);
      return this.mapLoan(result.rows[0]);
    });

  }


  /**
   * Restructure a loan: replace UNPAID installments with a fresh schedule over
   * the remaining outstanding principal, keeping payment history intact.
   */
  async restructure(
    organizationId: string | null,
    actorUserId: string,
    loanId: string,
    newTermMonths: number,
    reason: string,
  ): Promise<{ loanId: string; outstanding: number; newTermMonths: number; schedule: unknown }> {
    const orgId = this.requireOrg(organizationId);
    if (!Number.isInteger(newTermMonths) || newTermMonths < 1 || newTermMonths > 60) {
      throw new BadRequestException('newTermMonths must be 1..60');
    }
    if (!reason?.trim() || reason.trim().length < 5) {
      throw new BadRequestException('A restructuring reason is required');
    }
    let outstandingValue = 0;
    await withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT id, status, outstanding_principal, interest_rate_pa, interest_method
           FROM loans WHERE id = $1`,
        [loanId],
      );
      const l = rows[0] as
        | {
            id: string;
            status: string;
            outstanding_principal: string;
            interest_rate_pa: string;
            interest_method: string;
          }
        | undefined;
      if (!l) throw new NotFoundException('Loan not found');
      if (!['DISBURSED', 'DEFAULTED'].includes(l.status)) {
        throw new ConflictException('Only disbursed or defaulted loans can be restructured');
      }
      const outstanding = moneyDecimal(moneyKobo(l.outstanding_principal));
      outstandingValue = Number(outstanding); // Legacy response boundary only; never feeds arithmetic.
      if (moneyKobo(outstanding) <= 0n) throw new ConflictException('Loan has no outstanding balance');

      const paid = await c.query(
        `SELECT coalesce(max(seq), 0) AS max_seq, count(*) AS paid_count
           FROM loan_repayments WHERE loan_id = $1 AND status = 'PAID'`,
        [loanId],
      );
      const maxSeq = Number((paid.rows[0] as { max_seq: string | number }).max_seq);
      const removed = await c.query(
        `DELETE FROM loan_repayments WHERE loan_id = $1 AND status <> 'PAID'`,
        [loanId],
      );

      await this.generateSchedule(
        c,
        orgId,
        loanId,
        newTermMonths,
        outstanding,
        l.interest_rate_pa,
        l.interest_method,
        maxSeq,
      );
      await c.query(
        `UPDATE loans SET status = 'DISBURSED', term_months = $2 WHERE id = $1`,
        [loanId, maxSeq + newTermMonths],
      );
      await c.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1, $2, 'loan.restructured', 'loan', $3, $4)`,
        [
          orgId,
          actorUserId,
          loanId,
          JSON.stringify({
            outstanding,
            newTermMonths,
            paidInstallments: maxSeq,
            replacedInstallments: removed.rowCount ?? 0,
            reason: reason.trim(),
          }),
        ],
      );
    });
    const schedule = await this.listSchedule(orgId, loanId);
    return { loanId, outstanding: outstandingValue, newTermMonths, schedule };
  }

  /** Overdue installments (arrears list) with aging buckets and contact info. */
  async arrears(
    organizationId: string | null,
  ): Promise<{
    buckets: { bucket: string; count: number; amount: number }[];
    rows: {
      loanId: string;
      memberNo: number;
      member: string;
      phone: string | null;
      seq: number;
      dueDate: string;
      daysLate: number;
      amount: number;
      loanStatus: string;
    }[];
    total: number;
  }> {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT l.id AS loan_id, m.member_no, (m.first_name || ' ' || m.last_name) AS member,
                m.phone, r.seq, r.due_date, (now()::date - r.due_date) AS days_late,
                (r.principal_due - coalesce(r.paid_principal, 0))
                  + (r.interest_due - coalesce(r.paid_interest, 0)) AS amount,
                l.status AS loan_status
           FROM loan_repayments r
           JOIN loans l ON l.id = r.loan_id
           JOIN members m ON m.id = l.member_id
          WHERE r.status <> 'PAID' AND r.due_date < now()::date
          ORDER BY r.due_date`,
      );
      const list = rows.map((r) => ({
        loanId: r.loan_id as string,
        memberNo: Number(r.member_no),
        member: r.member as string,
        phone: (r.phone as string | null) ?? null,
        seq: Number(r.seq),
        dueDate: r.due_date as string,
        daysLate: Number(r.days_late),
        amount: Number(r.amount),
        loanStatus: r.loan_status as string,
      }));
      const mk = (label: string, min: number, max: number | null) => {
        const sel = list.filter(
          (x) => x.daysLate > min && (max === null || x.daysLate <= max),
        );
        return {
          bucket: label,
          count: sel.length,
          amount: round2(sel.reduce((a, x) => a + x.amount, 0)),
        };
      };
      return {
        buckets: [
          mk('1-30', 0, 30),
          mk('31-60', 30, 60),
          mk('61-90', 60, 90),
          mk('90+', 90, null),
        ],
        rows: list,
        total: round2(list.reduce((a, x) => a + x.amount, 0)),
      };
    });
  }

  /**
   * Arrears automation: mark DISBURSED loans as DEFAULTED once any unpaid
   * installment is more than `daysLate` past due (default 90).
   */
  async markDefaults(
    organizationId: string | null,
    actorUserId: string,
    daysLate = 90,
  ): Promise<{ defaulted: number; loanIds: string[] }> {
    const orgId = this.requireOrg(organizationId);
    const threshold = Math.min(Math.max(Math.trunc(daysLate) || 90, 31), 365);
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT DISTINCT l.id
           FROM loans l
           JOIN loan_repayments r ON r.loan_id = l.id
          WHERE l.status = 'DISBURSED' AND r.status <> 'PAID'
            AND (now()::date - r.due_date) > $1`,
        [threshold],
      );
      const ids = rows.map((r) => (r as { id: string }).id);
      for (const id of ids) {
        await c.query(`UPDATE loans SET status = 'DEFAULTED' WHERE id = $1`, [id]);
        await c.query(
          `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
           VALUES ($1, $2, 'loan.status.defaulted', 'loan', $3, $4)`,
          [orgId, actorUserId, id, JSON.stringify({ reason: `auto: arrears over ${threshold} days` })],
        );
      }
      return { defaulted: ids.length, loanIds: ids };
    });
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
    principal: string,
    interestRatePa: string,
    interestMethod: string,
    seqOffset = 0,
  ): Promise<void> {
    if (interestMethod !== 'FLAT') {
      throw new BadRequestException(
        `Schedule generation only supports FLAT interest (got ${interestMethod})`,
      );
    }
    const installments=flatLoanInstallments(principal,interestRatePa,termMonths);
    const values: string[] = [];
    const params: unknown[] = [];
    const today = new Date();
    for (let step = 1; step <= termMonths; step += 1) {
      const seq = step + seqOffset;
      const {principal:p,interest:i}=installments[step-1]!;
      const due = new Date(today);
      due.setUTCMonth(due.getUTCMonth() + step);
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
    amount: string | number,
    description?: string,
    idempotencyKey?: string,
    existingClient?: PoolClient,
  ): Promise<{ loan: LoanRow }> {
    const orgId = this.requireOrg(organizationId);
    const value = moneyKobo(amount);
    if (value <= 0n) throw new BadRequestException('Invalid repayment amount');
    return financialIntent(this.pool,orgId,'loans.repayment',idempotencyKey,
      {actorUserId,loanId,amount:moneyDecimal(value),description:description??null},async (c,journalKey) => {

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
      const totalRemaining = rows.reduce((acc, r) =>
        acc + moneyKobo(r.principal_due) + moneyKobo(r.interest_due)
          - moneyKobo(r.paid_principal) - moneyKobo(r.paid_interest), 0n);
      if (value > totalRemaining) {
        throw new BadRequestException(
          `Repayment ${moneyDecimal(value)} exceeds the outstanding balance of ${moneyDecimal(totalRemaining)}`,
        );
      }

      // Allocate: interest before principal within each installment in due order
      let remaining = value;
      let principalPortion = 0n;
      let interestPortion = 0n;
      for (const row of rows) {
        if (remaining <= 0n) break;
        const remInterest = moneyKobo(row.interest_due) - moneyKobo(row.paid_interest);
        const remPrincipal = moneyKobo(row.principal_due) - moneyKobo(row.paid_principal);
        if (remInterest < 0n || remPrincipal < 0n) {
          throw new ConflictException('Repayment schedule contains overpaid amounts');
        }
        const takeInterest = remInterest < remaining ? remInterest : remaining;
        const availablePrincipal = remaining - takeInterest;
        const takePrincipal = remPrincipal < availablePrincipal ? remPrincipal : availablePrincipal;
        if (takeInterest > 0n || takePrincipal > 0n) {
          const newPaidInterest = moneyKobo(row.paid_interest) + takeInterest;
          const newPaidPrincipal = moneyKobo(row.paid_principal) + takePrincipal;
          const done = newPaidInterest === moneyKobo(row.interest_due)
            && newPaidPrincipal === moneyKobo(row.principal_due);
          await c.query(
            `UPDATE loan_repayments
                SET paid_interest = $1, paid_principal = $2,
                    status = $3
              WHERE organization_id = $4 AND id = $5`,
            [
              moneyDecimal(newPaidInterest),
              moneyDecimal(newPaidPrincipal),
              done ? 'PAID' : 'PARTIAL',
              orgId,
              row.id,
            ],
          );
          interestPortion += takeInterest;
          principalPortion += takePrincipal;
          remaining -= takeInterest + takePrincipal;
        }
      }

      // Journal: Dr Cash / Cr Loan Receivables (principal) + Cr Interest Income
      if (remaining !== 0n || principalPortion + interestPortion !== value) {
        throw new ConflictException('Repayment allocation does not conserve the amount');
      }
      await this.postRepaymentJournal(
        c,
        orgId,
        actorUserId,
        loanId,
        loanRow.member_id,
        value,
        principalPortion,
        interestPortion,
        journalKey ?? null,
        description,
      );

      const outstandingKobo = moneyKobo(loanRow.outstanding_principal) - principalPortion;
      if (outstandingKobo < 0n) throw new ConflictException('Repayment exceeds outstanding principal');
      const outstanding = moneyDecimal(outstandingKobo);
      await c.query(
        `UPDATE loans
            SET outstanding_principal = $1,
                status = CASE WHEN $1::numeric <= 0 THEN 'COMPLETED' ELSE status END
          WHERE organization_id = $2 AND id = $3`,
        [String(outstanding), orgId, loanId],
      );
      await enqueueNotification(c, {
        organizationId: orgId,
        memberId: loanRow.member_id,
        type: 'REPAYMENT_RECEIVED',
        title: 'Repayment received',
        body: `We received your repayment. New outstanding balance: ${outstanding}.`,
        channels: outboundChannels(),
        metadata: { loanId, outstanding },
      });
      await c.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1, $2, 'loan.repayment', 'loan', $3, $4)`,
        [
          orgId,
          actorUserId,
          loanId,
          JSON.stringify({
            amount: moneyDecimal(value),
            principal: moneyDecimal(principalPortion),
            interest: moneyDecimal(interestPortion),
            outstanding,
          }),
        ],
      );
      const result=await c.query(`${selectLoan} WHERE l.organization_id=$1 AND l.id=$2`,[orgId,loanId]);
      return {loan:this.mapLoan(result.rows[0])};
    },existingClient);
  }

  private async postRepaymentJournal(
    c: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
    orgId: string,
    actorUserId: string,
    loanId: string,
    memberId: string,
    amount: bigint,
    principalPortion: bigint,
    interestPortion: bigint,
    idempotencyKey: string | null,
    description: string | undefined,
  ): Promise<void> {
    const period = await c.query(
      `SELECT id FROM ledger_periods
        WHERE organization_id = $1 AND status = 'OPEN'
          AND now()::date BETWEEN start_date AND end_date
        ORDER BY start_date DESC LIMIT 1 FOR SHARE`,
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
        description ?? `Loan repayment ${moneyDecimal(amount)}`,
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
    const params: unknown[] = [orgId, entryId, idByCode.get('1000'), moneyDecimal(amount), memberId];
    if (principalPortion > 0n) {
      creditClauses.push(
        `($1, $2, $${params.length + 1}, '0', $${params.length + 2}, $5)`,
      );
      params.push(idByCode.get('1020'), moneyDecimal(principalPortion));
    }
    if (interestPortion > 0n) {
      creditClauses.push(
        `($1, $2, $${params.length + 1}, '0', $${params.length + 2}, $5)`,
      );
      params.push(idByCode.get('4000'), moneyDecimal(interestPortion));
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
    principal: string,
  ): Promise<void> {
    const period = await c.query(
      `SELECT id FROM ledger_periods
        WHERE organization_id = $1 AND status = 'OPEN'
          AND now()::date BETWEEN start_date AND end_date
        ORDER BY start_date DESC LIMIT 1 FOR SHARE`,
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
        principal,
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
