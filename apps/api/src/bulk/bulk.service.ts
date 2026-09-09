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
import { parseCsv } from '../members/csv';

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const MAX_AMOUNT = 100_000_000;

type BulkKind = 'SHARE_PURCHASE' | 'LOAN_REPAYMENT';

interface BulkRow {
  memberNo: number;
  memberId: string;
  amount: number;
  loanId?: string;
}

@Injectable()
export class BulkService {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  private requireOrg(organizationId: string | null): string {
    if (!organizationId) {
      throw new ForbiddenException('Organization context required');
    }
    return organizationId;
  }

  /** Parse memberNo/amount rows and validate duplicates + range. */
  private parseRows(csv: string): { memberNo: number; amount: number }[] {
    const parsed = parseCsv(csv);
    if (parsed.length < 2) throw new BadRequestException('CSV must have a header and data rows');
    const header = (parsed[0] as string[]).map((h) => h.trim().toLowerCase().replace(/\s+/g, ''));
    const idxNo = header.indexOf('memberno');
    const idxAmt = header.indexOf('amount');
    if (idxNo < 0 || idxAmt < 0) {
      throw new BadRequestException('CSV header must include memberNo and amount');
    }
    const seen = new Set<number>();
    const rows: { memberNo: number; amount: number }[] = [];
    for (const line of parsed.slice(1)) {
      if (line.length === 0 || line.every((c) => c.trim() === '')) continue;
      const memberNo = Number(String(line[idxNo] ?? '').trim());
      const amount = round2(Number(String(line[idxAmt] ?? '').trim()));
      if (!Number.isInteger(memberNo) || memberNo <= 0) {
        throw new BadRequestException('memberNo must be a positive integer');
      }
      if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
        throw new BadRequestException(`Invalid amount for member ${memberNo}`);
      }
      if (seen.has(memberNo)) {
        throw new BadRequestException(`Duplicate memberNo ${memberNo} in file`);
      }
      seen.add(memberNo);
      rows.push({ memberNo, amount });
    }
    return rows;
  }

  /**
   * Preview: resolve members (ACTIVE), validate loan obligations for
   * repayments, persist the batch (never writes money).
   */
  async preview(
    organizationId: string | null,
    kind: BulkKind,
    filename: string,
    csv: string,
  ): Promise<{
    batchId: string;
    kind: BulkKind;
    filename: string;
    totals: { totalRows: number; valid: number; invalid: number; totalAmount: number };
    errors: string[];
  }> {
    const orgId = this.requireOrg(organizationId);
    const parsedRows = this.parseRows(csv);
    const batchId = randomUUID();
    const errors: string[] = [];
    const rowsJson: BulkRow[] = [];
    await withTenant(this.pool, orgId, async (c) => {
      const memberNos = [...new Set(parsedRows.map((r) => r.memberNo))];
      const members = await c.query(
        `SELECT id, member_no, status FROM members
          WHERE organization_id = $1 AND member_no = ANY($2::bigint[])`,
        [orgId, memberNos],
      );
      const byNo = new Map<number, { id: string; status: string }>();
      for (const r of members.rows as { id: string; member_no: number; status: string }[]) {
        byNo.set(Number(r.member_no), { id: r.id, status: r.status });
      }
      for (const row of parsedRows) {
        const m = byNo.get(row.memberNo);
        if (!m) {
          errors.push(`memberNo ${row.memberNo}: not found`);
          continue;
        }
        if (m.status !== 'ACTIVE') {
          errors.push(`memberNo ${row.memberNo}: member is not ACTIVE`);
          continue;
        }
        if (kind === 'LOAN_REPAYMENT') {
          const loan = await c.query(
            `SELECT id FROM loans
              WHERE organization_id = $1 AND member_id = $2
                AND status IN ('DISBURSED','DEFAULTED') AND outstanding_principal > 0
              ORDER BY disbursed_at ASC NULLS LAST LIMIT 1`,
            [orgId, m.id],
          );
          if (!loan.rows[0]) {
            errors.push(`memberNo ${row.memberNo}: no open loan`);
            continue;
          }
          const due = await c.query(
            `SELECT COALESCE(SUM((principal_due - paid_principal) + (interest_due - paid_interest)), 0)::numeric AS remaining
               FROM loan_repayments WHERE loan_id = $1 AND organization_id = $2`,
            [loan.rows[0].id, orgId],
          );
          const remaining = Number((due.rows[0] as { remaining: string }).remaining);
          if (row.amount > remaining + 0.004) {
            errors.push(`memberNo ${row.memberNo}: amount exceeds outstanding due (${remaining.toFixed(2)})`);
            continue;
          }
          rowsJson.push({ memberNo: row.memberNo, memberId: m.id, amount: row.amount, loanId: (loan.rows[0] as { id: string }).id });
        } else {
          rowsJson.push({ memberNo: row.memberNo, memberId: m.id, amount: row.amount });
        }
      }
      await c.query(
        `INSERT INTO payroll_batches (id, organization_id, filename, kind, status, total_rows, valid_rows, invalid_count, rows, total_amount, created_by)
         VALUES ($1, $2, $3, $4, 'PREVIEWED', $5, $6, $7, $8, $9, $10)`,
        [
          batchId,
          orgId,
          filename,
          kind,
          parsedRows.length,
          rowsJson.length,
          errors.length,
          JSON.stringify(rowsJson),
          String(round2(rowsJson.reduce((a, r) => a + r.amount, 0))),
          null,
        ],
      );
    });
    return {
      batchId,
      kind,
      filename,
      totals: {
        totalRows: parsedRows.length,
        valid: rowsJson.length,
        invalid: errors.length,
        totalAmount: round2(rowsJson.reduce((a, r) => a + r.amount, 0)),
      },
      errors,
    };
  }

  /** Commit a previewed batch — one tenant transaction, auto-posted journals. */
  async commit(
    organizationId: string | null,
    kind: BulkKind,
    actorUserId: string,
    batchId: string,
  ): Promise<{
    committed: number;
    skipped: number;
    totalAmount: number;
    entryNos: number[];
  }> {
    const orgId = this.requireOrg(organizationId);
    const committed: string[] = [];
    let committedCount = 0;
    let skipped = 0;
    let total = 0;
    const entryNos: number[] = [];
    await withTenant(this.pool, orgId, async (c) => {
      const batch = await c.query(
        `SELECT id, filename, rows, kind, status FROM payroll_batches
          WHERE organization_id = $1 AND id = $2`,
        [orgId, batchId],
      );
      if (!batch.rows[0]) throw new NotFoundException('Batch not found');
      const b = batch.rows[0] as { filename: string; rows: unknown; kind: string; status: string };
      if (b.kind !== kind) throw new BadRequestException('Batch kind mismatch');
      if (b.status === 'COMMITTED') throw new ConflictException('Batch already committed');
      const raw = b.rows;
      const rows = (typeof raw === 'string' ? JSON.parse(raw) : raw ?? []) as BulkRow[];
      if (rows.length === 0) throw new BadRequestException('Batch has no valid rows');

      const period = await c.query(
        `SELECT id FROM ledger_periods
          WHERE organization_id = $1 AND status = 'OPEN' ORDER BY start_date DESC LIMIT 1`,
        [orgId],
      );
      if (!period.rows[0]) throw new ConflictException('No OPEN ledger period');
      const periodId = (period.rows[0] as { id: string }).id;

      const accounts = await c.query(
        `SELECT id, code FROM chart_of_accounts
          WHERE organization_id = $1 AND code = ANY($2::varchar[])`,
        [orgId, ['1000', '1020', '2000', '3000', '4000']],
      );
      const idByCode = new Map<string, string>();
      for (const r of accounts.rows as { id: string; code: string }[]) {
        idByCode.set(r.code, r.id);
      }

      const nextEntryNo = async (): Promise<number> => {
        const seq = await c.query(
          `UPDATE org_counters SET journal_seq = journal_seq + 1, updated_at = now()
            WHERE organization_id = $1 RETURNING journal_seq`,
          [orgId],
        );
        return Number((seq.rows[0] as { journal_seq: string | number }).journal_seq);
      };

      const postEntry = async (
        entryNo: number,
        description: string,
        debit: string,
        credits: { accountId: string; amount: number; memberId: string }[],
        sourceId?: string,
      ): Promise<string> => {
        const entryId = randomUUID();
        const entrySourceId = sourceId ?? randomUUID();
        await c.query(
          `INSERT INTO journal_entries
             (id, organization_id, period_id, entry_date, description, source, source_type, source_id, status, entry_no, created_by, posted_at)
           VALUES ($1, $2, $3, now()::date, $4, $5, 'bulk_batch', $6, 'POSTED', $7, $8, now())`,
          [entryId, orgId, periodId, description, kind, entrySourceId, entryNo, actorUserId],
        );
        const values: string[] = [];
        const params: unknown[] = [];
        let totalDebit = debit;
        void totalDebit;
        // debit line (cash)
        let base = params.length;
        values.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, '0', $${base + 5})`,
        );
        params.push(orgId, entryId, idByCode.get('1000'), debit, credits[0]?.memberId ?? null);
        for (const cr of credits) {
          base = params.length;
          values.push(
            `($${base + 1}, $${base + 2}, $${base + 3}, '0', $${base + 4}, $${base + 5})`,
          );
          params.push(orgId, entryId, cr.accountId, String(cr.amount), cr.memberId);
        }
        await c.query(
          `INSERT INTO journal_lines (organization_id, journal_entry_id, account_id, debit, credit, member_id)
           VALUES ${values.join(', ')}`,
          params,
        );
        return entryId;
      };

      for (const row of rows) {
        const member = await c.query(
          `SELECT status FROM members WHERE organization_id = $1 AND id = $2`,
          [orgId, row.memberId],
        );
        if (!member.rows[0] || (member.rows[0] as { status: string }).status !== 'ACTIVE') {
          skipped += 1;
          continue;
        }
        if (kind === 'SHARE_PURCHASE') {
          await c.query(
            `INSERT INTO member_share_accounts (organization_id, member_id, status)
             VALUES ($1, $2, 'ACTIVE') ON CONFLICT DO NOTHING`,
            [orgId, row.memberId],
          );
          const acc = await c.query(
            `SELECT id, current_balance FROM member_share_accounts
              WHERE organization_id = $1 AND member_id = $2`,
            [orgId, row.memberId],
          );
          const account = acc.rows[0] as { id: string; current_balance: string };
          const entryNo = await nextEntryNo();
          const entryId = await postEntry(
            entryNo,
            `Share purchase batch ${b.filename}`,
            String(row.amount),
            [{ accountId: idByCode.get('3000')!, amount: row.amount, memberId: row.memberId }],
          );
          const after = round2(Number(account.current_balance) + row.amount);
          await c.query(
            `UPDATE member_share_accounts SET current_balance = $1 WHERE organization_id = $2 AND id = $3`,
            [String(after), orgId, account.id],
          );
          await c.query(
            `INSERT INTO share_transactions (organization_id, account_id, journal_entry_id, type, signed_amount, running_balance)
             VALUES ($1, $2, $3, 'PURCHASE', $4, $5)`,
            [orgId, account.id, entryId, String(row.amount), String(after)],
          );
          committed.push(row.memberNo.toString());
          entryNos.push(entryNo);
          total = round2(total + row.amount);
          committedCount += 1;
        } else {
          // LOAN_REPAYMENT allocation (interest-before-principal, due order)
          const loanRes = await c.query(
            `SELECT id, outstanding_principal FROM loans
              WHERE organization_id = $1 AND id = $2 AND status IN ('DISBURSED','DEFAULTED')`,
            [orgId, row.loanId],
          );
          if (!loanRes.rows[0]) {
            skipped += 1;
            continue;
          }
          const loan = loanRes.rows[0] as { id: string; outstanding_principal: string };
          const installments = await c.query(
            `SELECT id, principal_due, interest_due, paid_principal, paid_interest
               FROM loan_repayments WHERE loan_id = $1 AND organization_id = $2
              ORDER BY seq ASC`,
            [row.loanId, orgId],
          );
          let remainingAmount = row.amount;
          let principalPortion = 0;
          let interestPortion = 0;
          const updates: { id: string; principal: number; interest: number }[] = [];
          for (const inst of installments.rows as {
            id: string;
            principal_due: string;
            interest_due: string;
            paid_principal: string;
            paid_interest: string;
          }[]) {
            if (remainingAmount <= 0.004) break;
            const intRem = Number(inst.interest_due) - Number(inst.paid_interest);
            if (intRem > 0.004) {
              const take = Math.min(intRem, remainingAmount);
              interestPortion = round2(interestPortion + take);
              remainingAmount = round2(remainingAmount - take);
              updates.push({ id: inst.id, principal: 0, interest: take });
            }
            if (remainingAmount <= 0.004) break;
            const prinRem = Number(inst.principal_due) - Number(inst.paid_principal);
            if (prinRem > 0.004) {
              const take = Math.min(prinRem, remainingAmount);
              principalPortion = round2(principalPortion + take);
              remainingAmount = round2(remainingAmount - take);
              updates.push({ id: inst.id, principal: take, interest: 0 });
            }
          }
          const entryNo = await nextEntryNo();
          const credits: { accountId: string; amount: number; memberId: string }[] = [
            { accountId: idByCode.get('1020')!, amount: principalPortion, memberId: row.memberId },
          ];
          if (interestPortion > 0.004) {
            credits.push({ accountId: idByCode.get('4000')!, amount: interestPortion, memberId: row.memberId });
          }
          const entryId = await postEntry(
            entryNo,
            `Loan repayment batch ${b.filename}`,
            String(round2(principalPortion + interestPortion)),
            credits,
            row.loanId,
          );
          for (const up of updates) {
            await c.query(
              `UPDATE loan_repayments SET paid_principal = paid_principal + $1, paid_interest = paid_interest + $2
                WHERE id = $3 AND organization_id = $4`,
              [String(up.principal), String(up.interest), up.id, orgId],
            );
          }
          const newOutstanding = round2(Number(loan.outstanding_principal) - principalPortion);
          await c.query(
            `UPDATE loans SET outstanding_principal = outstanding_principal - $1,
                    status = CASE WHEN outstanding_principal - $1 <= 0 THEN 'COMPLETED' ELSE status END
              WHERE organization_id = $2 AND id = $3`,
            [principalPortion, orgId, row.loanId],
          );
          void entryId;
          committed.push(row.memberNo.toString());
          entryNos.push(entryNo);
          total = round2(total + principalPortion + interestPortion);
          committedCount += 1;
        }
      }
      await c.query(
        `UPDATE payroll_batches SET status = 'COMMITTED'
          WHERE organization_id = $1 AND id = $2`,
        [orgId, batchId],
      );
    });
    return { committed: committedCount, skipped, totalAmount: total, entryNos };
  }
}
