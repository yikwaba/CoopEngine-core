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

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface OpeningBalanceParseRow {
  memberRef: string;
  savings: number;
  shares: number;
  loanOutstanding: number;
  loanTermMonths: number | null;
  loanRatePa: number | null;
  loanDaysLate: number | null;
  loanArrearsAmount: number | null;
  loanPaidCount: number;
  loanPrincipal: number | null;
  loanLastPaymentDate: string | null;
}

export interface OpeningBalancePreviewRow {
  row: number;
  memberRef: string;
  memberId: string | null;
  memberName: string | null;
  savings: number;
  shares: number;
  loanOutstanding: number;
  loanTermMonths: number | null;
  loanDaysLate: number | null;
  loanArrearsAmount: number | null;
  loanPaidCount: number;
  loanPrincipal: number | null;
  loanLastPaymentDate: string | null;
  errors: string[];
}

export interface OpeningBalancePreviewResult {
  batchId: string | null;
  totals: { rows: number; valid: number; invalid: number };
  validTotals: { savings: number; shares: number; loans: number };
  rows: OpeningBalancePreviewRow[];
}

/** Minimal CSV reader (quoted fields, CRLF tolerant). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  const src = text.replace(/\r\n?/g, '\n');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const norm = (h: string): string => h.trim().toLowerCase().replace(/[\s_-]+/g, '');

const numberOrNull = (raw: string | undefined): number | null => {
  const v = (raw ?? '').trim();
  if (v === '') return 0;
  const cleaned = v.replace(/,/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
};

/**
 * Bulk migration of a cooperative's existing balances.
 *
 * Preview validates a CSV and stores a PENDING batch; commit posts every valid
 * row in one transaction with a single balanced journal:
 *
 *   Dr 1000 Cash at Bank        (savings + shares brought across)
 *   Dr 1020 Loans Receivable    (outstanding legacy loans)
 *   Cr 2000 Member Savings      (per member)
 *   Cr 3000 Member Share Capital(per member)
 *   Cr 3200 Opening Balance Equity (balancing figure = legacy loans)
 */
@Injectable()
export class OpeningBalancesService {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  private requireOrg(organizationId: string | null): string {
    if (!organizationId) throw new ConflictException('No organization in context');
    return organizationId;
  }

  async preview(
    organizationId: string | null,
    actorUserId: string,
    label: string,
    filename: string | undefined,
    csv: string,
  ): Promise<OpeningBalancePreviewResult> {
    const orgId = this.requireOrg(organizationId);
    if (!label?.trim()) throw new BadRequestException('label is required');
    if (!csv || csv.trim() === '') throw new BadRequestException('csv must not be empty');
    if (csv.length > 2_000_000) throw new BadRequestException('csv exceeds the 2 MB limit');

    const parsed = parseCsv(csv);
    if (parsed.length < 2) {
      throw new BadRequestException('CSV needs a header row and at least one data row');
    }
    const header = (parsed[0] as string[]).map(norm);
    const col = (name: string): number => header.indexOf(norm(name));
    const idxEmail = col('memberEmail');
    const idxNo = col('memberNo');
    const idxSavings = col('savings');
    const idxShares = col('shares');
    const idxLoan = col('loanOutstanding');
    const idxTerm = col('loanTermMonths');
    const idxRate = col('loanRatePa');
    const idxDaysLate = col('loanDaysLate');
    const idxArrears = col('loanArrearsAmount');
    const idxPaid = col('loanPaidCount');
    const idxPrincipal = col('loanPrincipal');
    const idxLastPay = col('loanLastPaymentDate');
    if (idxEmail < 0 && idxNo < 0) {
      throw new BadRequestException('CSV must include a memberEmail or memberNo column');
    }
    if (idxSavings < 0 && idxShares < 0 && idxLoan < 0) {
      throw new BadRequestException(
        'CSV must include at least one of savings, shares or loanOutstanding',
      );
    }

    return withTenant(this.pool, orgId, async (c) => {
      const rows: OpeningBalancePreviewRow[] = [];
      const seen = new Set<string>();
      const validRows: { row: OpeningBalanceParseRow; memberId: string }[] = [];

      for (let i = 1; i < parsed.length; i += 1) {
        const cells = parsed[i] as string[];
        const errors: string[] = [];
        const memberRef = ((idxEmail >= 0 ? cells[idxEmail] : '') || (idxNo >= 0 ? cells[idxNo] : '') || '').trim();
        if (!memberRef) errors.push('member reference is missing');

        const savings = numberOrNull(idxSavings >= 0 ? cells[idxSavings] : '0');
        const shares = numberOrNull(idxShares >= 0 ? cells[idxShares] : '0');
        const loans = numberOrNull(idxLoan >= 0 ? cells[idxLoan] : '0');
        const term = idxTerm >= 0 ? numberOrNull(cells[idxTerm]) : null;
        const rate = idxRate >= 0 ? numberOrNull(cells[idxRate]) : null;
        const daysLate = idxDaysLate >= 0 ? numberOrNull(cells[idxDaysLate]) : null;
        const arrears = idxArrears >= 0 ? numberOrNull(cells[idxArrears]) : null;
        const paidCountRaw = idxPaid >= 0 ? numberOrNull(cells[idxPaid]) : null;
        const principalRaw = idxPrincipal >= 0 ? numberOrNull(cells[idxPrincipal]) : null;
        const lastPayRaw = idxLastPay >= 0 ? (cells[idxLastPay] ?? '').trim() : '';

        for (const [name, value] of [
          ['savings', savings],
          ['shares', shares],
          ['loanOutstanding', loans],
        ] as const) {
          if (value === null) errors.push(`${name} is not a number`);
          else if (value < 0) errors.push(`${name} cannot be negative`);
        }

        const loanOutstanding = loans ?? 0;
        const termMonths = term === null || term === 0 ? null : term;
        if (loanOutstanding > 0) {
          if (termMonths === null || termMonths < 1 || termMonths > 60) {
            errors.push('loanTermMonths (1-60) is required when loanOutstanding is set');
          }
        }
        // Optional past-due carry-over (decision 2026-09-11: flags carry across)
        let daysLateValue: number | null = null;
        if (daysLate !== null && daysLate !== 0) {
          if (!Number.isInteger(daysLate) || daysLate < 0 || daysLate > 3650) {
            errors.push('loanDaysLate must be a whole number of days (0-3650)');
          } else if (loanOutstanding <= 0) {
            errors.push('loanDaysLate is only meaningful when loanOutstanding is set');
          } else {
            daysLateValue = daysLate;
          }
        }
        if (arrears !== null && arrears < 0) errors.push('loanArrearsAmount cannot be negative');

        // Repayment history reconstruction (decision 2026-09-11)
        let paidCount = 0;
        if (paidCountRaw !== null && paidCountRaw !== 0) {
          if (loanOutstanding <= 0) {
            errors.push('loanPaidCount is only meaningful when loanOutstanding is set');
          } else if (!Number.isInteger(paidCountRaw) || paidCountRaw < 0) {
            errors.push('loanPaidCount must be a whole number of instalments');
          } else if (termMonths !== null && paidCountRaw >= termMonths) {
            errors.push('loanPaidCount must be less than loanTermMonths (at least one instalment left)');
          } else {
            paidCount = paidCountRaw;
          }
        }
        let loanPrincipal: number | null = null;
        if (principalRaw !== null && principalRaw !== 0) {
          if (principalRaw < 0) errors.push('loanPrincipal cannot be negative');
          else if (loanOutstanding > 0 && principalRaw < loanOutstanding) {
            errors.push('loanPrincipal (original) cannot be smaller than loanOutstanding');
          } else loanPrincipal = round2(principalRaw);
        }
        let lastPaymentDate: string | null = null;
        if (lastPayRaw) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(lastPayRaw)) {
            errors.push('loanLastPaymentDate must be YYYY-MM-DD');
          } else if (paidCount === 0) {
            errors.push('loanLastPaymentDate needs loanPaidCount');
          } else if (lastPayRaw > new Date().toISOString().slice(0, 10)) {
            errors.push('loanLastPaymentDate cannot be in the future');
          } else {
            lastPaymentDate = lastPayRaw;
          }
        }
        if ((savings ?? 0) === 0 && (shares ?? 0) === 0 && loanOutstanding === 0) {
          errors.push('all balances are zero — nothing to migrate');
        }

        const key = memberRef.toLowerCase();
        if (memberRef && seen.has(key)) errors.push('duplicate member in this file');
        if (memberRef) seen.add(key);

        let memberId: string | null = null;
        let memberName: string | null = null;
        if (memberRef && errors.length === 0) {
          const find = await c.query(
            idxEmail >= 0 && memberRef.includes('@')
              ? `SELECT id, first_name || ' ' || last_name AS name, status FROM members WHERE lower(email) = lower($1)`
              : `SELECT id, first_name || ' ' || last_name AS name, status FROM members WHERE member_no::text = $1`,
            [memberRef],
          );
          const m = find.rows[0] as { id: string; name: string; status: string } | undefined;
          if (!m) {
            errors.push('no member matches this reference');
          } else if (m.status !== 'ACTIVE') {
            errors.push(`member is ${m.status}, not ACTIVE`);
          } else {
            memberId = m.id;
            memberName = m.name;
          }
        }

        const row: OpeningBalancePreviewRow = {
          row: i + 1,
          memberRef,
          memberId,
          memberName,
          savings: round2(savings ?? 0),
          shares: round2(shares ?? 0),
          loanOutstanding: round2(loanOutstanding),
          loanTermMonths: termMonths,
          loanDaysLate: daysLateValue,
          loanArrearsAmount: arrears === null ? null : round2(arrears),
          loanPaidCount: paidCount,
          loanPrincipal,
          loanLastPaymentDate: lastPaymentDate,
          errors,
        };
        rows.push(row);
        if (errors.length === 0 && memberId) {
          validRows.push({
            row: {
              memberRef,
              savings: row.savings,
              shares: row.shares,
              loanOutstanding: row.loanOutstanding,
              loanTermMonths: termMonths,
              loanRatePa: rate,
              loanDaysLate: daysLateValue,
              loanArrearsAmount: arrears === null ? null : round2(arrears),
              loanPaidCount: paidCount,
              loanPrincipal,
              loanLastPaymentDate: lastPaymentDate,
            },
            memberId,
          });
        }
      }

      const savingsTotal = round2(validRows.reduce((s, r) => s + r.row.savings, 0));
      const sharesTotal = round2(validRows.reduce((s, r) => s + r.row.shares, 0));
      const loansTotal = round2(validRows.reduce((s, r) => s + r.row.loanOutstanding, 0));

      let batchId: string | null = null;
      if (validRows.length > 0) {
        batchId = randomUUID();
        await c.query(
          `INSERT INTO opening_balance_batches
             (id, organization_id, label, source_filename, status, member_count,
              savings_total, shares_total, loans_total, created_by)
           VALUES ($1, $2, $3, $4, 'PENDING', $5, $6, $7, $8, $9)`,
          [
            batchId,
            orgId,
            label.trim(),
            filename?.slice(0, 255) ?? null,
            validRows.length,
            String(savingsTotal),
            String(sharesTotal),
            String(loansTotal),
            actorUserId,
          ],
        );
        for (const vr of validRows) {
          await c.query(
            `INSERT INTO opening_balance_rows
               (organization_id, batch_id, member_id, savings_amount, shares_amount,
                loan_outstanding, loan_term_months, loan_rate_pa, loan_days_late,
                loan_arrears_amount, loan_paid_count, loan_principal, loan_last_payment_date)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
            [
              orgId,
              batchId,
              vr.memberId,
              String(vr.row.savings),
              String(vr.row.shares),
              String(vr.row.loanOutstanding),
              vr.row.loanTermMonths,
              vr.row.loanRatePa === null ? null : String(vr.row.loanRatePa),
              vr.row.loanDaysLate,
              vr.row.loanArrearsAmount === null ? null : String(vr.row.loanArrearsAmount),
              vr.row.loanPaidCount,
              vr.row.loanPrincipal === null ? null : String(vr.row.loanPrincipal),
              vr.row.loanLastPaymentDate,
            ],
          );
        }
        await c.query(
          `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
           VALUES ($1, $2, 'migration.opening_balances.previewed', 'opening_balance_batch', $3, $4)`,
          [
            orgId,
            actorUserId,
            batchId,
            JSON.stringify({ label: label.trim(), valid: validRows.length, savingsTotal, sharesTotal, loansTotal }),
          ],
        );
      }

      return {
        batchId,
        totals: { rows: rows.length, valid: validRows.length, invalid: rows.length - validRows.length },
        validTotals: { savings: savingsTotal, shares: sharesTotal, loans: loansTotal },
        rows,
      };
    });
  }

  /** Post a PENDING batch: balances, loans and one balanced opening journal. */
  async commit(
    organizationId: string | null,
    actorUserId: string,
    batchId: string,
  ): Promise<{
    batchId: string;
    members: number;
    savings: number;
    shares: number;
    loans: number;
    journalEntryId: string;
    entryNo: number;
  }> {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const batchRes = await c.query(
        `SELECT id, label, status, member_count, savings_total, shares_total, loans_total
           FROM opening_balance_batches WHERE id = $1 FOR UPDATE`,
        [batchId],
      );
      const batch = batchRes.rows[0] as
        | { id: string; label: string; status: string; member_count: number }
        | undefined;
      if (!batch) throw new NotFoundException('Batch not found');
      if (batch.status !== 'PENDING') {
        throw new ConflictException(`Batch is ${batch.status} — it can only be posted once`);
      }

      const rowsRes = await c.query(
        `SELECT r.*, m.first_name || ' ' || m.last_name AS member_name
           FROM opening_balance_rows r JOIN members m ON m.id = r.member_id
          WHERE r.batch_id = $1 ORDER BY m.last_name, m.first_name`,
        [batchId],
      );
      const rows = rowsRes.rows as Record<string, unknown>[];
      if (rows.length === 0) throw new ConflictException('Batch has no rows to post');

      // Accounting period must be open.
      const period = await c.query(
        `SELECT id FROM ledger_periods
          WHERE organization_id = $1 AND status = 'OPEN'
            AND now()::date BETWEEN start_date AND end_date
          ORDER BY start_date DESC LIMIT 1`,
        [orgId],
      );
      const periodId = (period.rows[0] as { id: string } | undefined)?.id;
      if (!periodId) throw new ConflictException('No OPEN accounting period for today — cannot post');

      // Chart of accounts: Opening Balance Equity is created on demand.
      await c.query(
        `INSERT INTO chart_of_accounts (organization_id, code, name, type)
         SELECT $1, '3200', 'Opening Balance Equity', 'EQUITY'
          WHERE NOT EXISTS (
            SELECT 1 FROM chart_of_accounts WHERE organization_id = $1 AND code = '3200')`,
        [orgId],
      );
      const accRes = await c.query(
        `SELECT id, code FROM chart_of_accounts
          WHERE organization_id = $1 AND code = ANY($2::varchar[])`,
        [orgId, ['1000', '1020', '2000', '3000', '3200']],
      );
      const idByCode = new Map<string, string>();
      for (const r of accRes.rows as { id: string; code: string }[]) idByCode.set(r.code, r.id);
      for (const code of ['1000', '1020', '2000', '3000', '3200']) {
        if (!idByCode.has(code)) throw new BadRequestException(`Missing chart account ${code}`);
      }

      const savingsProduct = await c.query(
        `SELECT id FROM savings_products WHERE status = 'ACTIVE' ORDER BY created_at LIMIT 1`,
      );
      const savingsProductId = (savingsProduct.rows[0] as { id: string } | undefined)?.id;
      if (!savingsProductId) {
        throw new ConflictException('No ACTIVE savings product — create one before migrating');
      }
      const loanProduct = await c.query(
        `SELECT id, interest_rate_pa, interest_method FROM loan_products
          WHERE status = 'ACTIVE' ORDER BY created_at LIMIT 1`,
      );
      const loanProductRow = loanProduct.rows[0] as
        | { id: string; interest_rate_pa: string; interest_method: string }
        | undefined;
      if (!loanProductRow) {
        throw new ConflictException('No ACTIVE loan product — create one before migrating loans');
      }

      const entryNoRes = await c.query(
        `SELECT coalesce(max(entry_no), 0) + 1 AS next FROM journal_entries
          WHERE organization_id = $1 AND period_id = $2`,
        [orgId, periodId],
      );
      const entryNo = Number((entryNoRes.rows[0] as { next: string | number }).next);
      const entryId = randomUUID();

      await c.query(
        `INSERT INTO journal_entries
           (id, organization_id, period_id, entry_date, description, source,
            source_type, source_id, status, entry_no, created_by, posted_by, posted_at)
         VALUES ($1, $2, $3, now()::date, $4, 'OPENING_BALANCES', 'opening_balance_batch', $5,
                 'POSTED', $6, $7, $7, now())`,
        [entryId, orgId, periodId, `Opening balances — ${batch.label}`.slice(0, 240), batchId, entryNo, actorUserId],
      );

      let savingsTotal = 0;
      let sharesTotal = 0;
      let loansTotal = 0;
      const journalLines: { code: string; side: 'debit' | 'credit'; amount: number }[] = [];
      const todayIso = new Date().toISOString().slice(0, 10);

      for (const row of rows) {
        const memberId = row.member_id as string;
        const memberName = row.member_name as string;
        const savings = round2(Number(row.savings_amount));
        const shares = round2(Number(row.shares_amount));
        const loan = round2(Number(row.loan_outstanding));

        if (savings > 0) {
          const acc = await c.query(
            `SELECT id, current_balance FROM member_savings_accounts
              WHERE member_id = $1 AND status = 'ACTIVE' ORDER BY created_at LIMIT 1`,
            [memberId],
          );
          let accountId: string;
          let balance: number;
          const existing = acc.rows[0] as { id: string; current_balance: string } | undefined;
          if (existing) {
            accountId = existing.id;
            balance = round2(Number(existing.current_balance) + savings);
          } else {
            accountId = randomUUID();
            const seq = await c.query(
              `UPDATE org_counters SET savings_seq = savings_seq + 1, updated_at = now()
                WHERE organization_id = $1 RETURNING savings_seq`,
              [orgId],
            );
            balance = savings;
            await c.query(
              `INSERT INTO member_savings_accounts
                 (id, organization_id, member_id, product_id, account_no, status, current_balance)
               VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6)`,
              [
                accountId,
                orgId,
                memberId,
                savingsProductId,
                Number((seq.rows[0] as { savings_seq: string | number }).savings_seq),
                String(balance),
              ],
            );
          }
          if (existing) {
            await c.query(`UPDATE member_savings_accounts SET current_balance = $2 WHERE id = $1`, [
              accountId,
              String(balance),
            ]);
          }
          await c.query(
            `INSERT INTO savings_transactions
               (organization_id, account_id, journal_entry_id, type, signed_amount, running_balance)
             VALUES ($1, $2, $3, 'OPENING_BALANCE', $4, $5)`,
            [orgId, accountId, entryId, String(savings), String(balance)],
          );
          savingsTotal = round2(savingsTotal + savings);
          journalLines.push({ code: '2000', side: 'credit', amount: savings });
        }

        if (shares > 0) {
          const acc = await c.query(
            `SELECT id, current_balance FROM member_share_accounts WHERE member_id = $1 LIMIT 1`,
            [memberId],
          );
          let accountId: string;
          let balance: number;
          const existing = acc.rows[0] as { id: string; current_balance: string } | undefined;
          if (existing) {
            accountId = existing.id;
            balance = round2(Number(existing.current_balance) + shares);
            await c.query(`UPDATE member_share_accounts SET current_balance = $2 WHERE id = $1`, [
              accountId,
              String(balance),
            ]);
          } else {
            const ins = await c.query(
              `INSERT INTO member_share_accounts
                 (organization_id, member_id, current_balance) VALUES ($1, $2, $3) RETURNING id`,
              [orgId, memberId, String(shares)],
            );
            accountId = (ins.rows[0] as { id: string }).id;
            balance = shares;
          }
          await c.query(
            `INSERT INTO share_transactions
               (organization_id, account_id, journal_entry_id, type, signed_amount, running_balance)
             VALUES ($1, $2, $3, 'OPENING_BALANCE', $4, $5)`,
            [orgId, accountId, entryId, String(shares), String(balance)],
          );
          sharesTotal = round2(sharesTotal + shares);
          journalLines.push({ code: '3000', side: 'credit', amount: shares });
        }

        if (loan > 0) {
          const termMonths = Number(row.loan_term_months ?? 12);
          const rate = row.loan_rate_pa === null
            ? Number(loanProductRow.interest_rate_pa)
            : Number(row.loan_rate_pa);
          const loanId = randomUUID();
          const daysLate = Number(row.loan_days_late ?? 0);
          const arrearsAmount =
            row.loan_arrears_amount === null ? null : round2(Number(row.loan_arrears_amount));
          // Decision 2026-09-11: migrated loans use the straight-line (FLAT)
          // method, and past-due flags carry across — a loan already 90+ days
          // behind arrives DEFAULTED, matching the nightly arrears policy.
          const status = daysLate >= 90 ? 'DEFAULTED' : 'DISBURSED';
          await c.query(
            `INSERT INTO loans (id, organization_id, member_id, loan_product_id, principal,
                                term_months, interest_rate_pa, interest_method, status,
                                outstanding_principal, created_by, disbursed_by, disbursed_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'FLAT', $8, $5, $9, $9, now())`,
            [
              loanId,
              orgId,
              memberId,
              loanProductRow.id,
              String(loan),
              termMonths,
              String(rate),
              status,
              actorUserId,
            ],
          );
          // Straight-line (flat) schedule rebuilt to include the instalments the
          // member had ALREADY paid in the old system, so the loan arrives with
          // real history rather than just an ageing position.
          //   termMonths  = the original number of instalments
          //   paidCount   = instalments settled before the cut-over
          //   loan        = principal still outstanding
          const paidCount = Math.min(Number(row.loan_paid_count ?? 0), termMonths - 1);
          const remaining = termMonths - paidCount;
          const principalPer = round2(loan / remaining);

          // Rounding delta goes on the final instalment so the unpaid principal
          // sums to the outstanding balance exactly, whatever the division does.
          const principalBySeq = new Map<number, number>();
          for (let seq = 1; seq <= termMonths; seq += 1) principalBySeq.set(seq, principalPer);
          const delta = round2(loan - principalPer * remaining);
          if (delta !== 0) {
            principalBySeq.set(termMonths, round2((principalBySeq.get(termMonths) ?? 0) + delta));
          }
          // When paid instalments are reconstructed the original principal is the
          // sum of the whole schedule; a caller may state it explicitly instead.
          const scheduledPrincipal = round2(
            [...principalBySeq.values()].reduce((sum, v) => sum + v, 0),
          );
          const originalPrincipal =
            row.loan_principal === null
              ? scheduledPrincipal
              : round2(Number(row.loan_principal));
          if (originalPrincipal < loan) {
            throw new ConflictException('Original principal cannot be less than the outstanding balance');
          }
          const interestPer = round2((originalPrincipal * rate) / 1200);

          // Instalment dates are anchored on the first UNPAID one, which falls
          // exactly daysLate days ago; already-paid instalments precede it.
          const anchor = new Date(`${todayIso}T00:00:00Z`);
          anchor.setUTCDate(anchor.getUTCDate() - daysLate);
          const dueFor = (seq: number): string => {
            const due = new Date(anchor.toISOString().slice(0, 10) + 'T00:00:00Z');
            due.setUTCMonth(due.getUTCMonth() + (seq - (paidCount + 1)));
            return due.toISOString().slice(0, 10);
          };

          const values: string[] = [];
          const params: unknown[] = [];
          for (let seq = 1; seq <= termMonths; seq += 1) {
            const principal = principalBySeq.get(seq) ?? 0;
            const wasPaid = seq <= paidCount;
            const base = params.length;
            values.push(
              `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10})`,
            );
            params.push(
              randomUUID(),
              orgId,
              loanId,
              seq,
              dueFor(seq),
              String(principal),
              String(interestPer),
              wasPaid ? String(principal) : '0',
              wasPaid ? String(interestPer) : '0',
              wasPaid ? 'PAID' : 'PENDING',
            );
          }
          await c.query(
            `INSERT INTO loan_repayments
               (id, organization_id, loan_id, seq, due_date, principal_due, interest_due,
                paid_principal, paid_interest, status)
             VALUES ${values.join(', ')}`,
            params,
          );
          loansTotal = round2(loansTotal + loan);
          journalLines.push({ code: '1020', side: 'debit', amount: loan });
          await c.query(
            `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
             VALUES ($1, $2, 'loan.migrated', 'loan', $3, $4)`,
            [
              orgId,
              actorUserId,
              loanId,
              JSON.stringify({
                memberId,
                memberName,
                outstanding: loan,
                termMonths,
                interestMethod: 'FLAT',
                status,
                daysLate,
                arrearsAmount,
                originalPrincipal,
                instalmentsPaid: paidCount,
                instalmentsRemaining: remaining,
                lastPaymentDate: (row.loan_last_payment_date as string | null) ?? null,
                historyReconstructed: paidCount > 0,
                source: 'opening_balances',
              }),
            ],
          );
        }
      }

      // Cash brought across + the balancing opening-equity figure.
      if (savingsTotal + sharesTotal > 0) {
        journalLines.push({ code: '1000', side: 'debit', amount: round2(savingsTotal + sharesTotal) });
      }
      if (loansTotal > 0) {
        journalLines.push({ code: '3200', side: 'credit', amount: loansTotal });
      }
      const debits = round2(journalLines.filter((l) => l.side === 'debit').reduce((s, l) => s + l.amount, 0));
      const credits = round2(journalLines.filter((l) => l.side === 'credit').reduce((s, l) => s + l.amount, 0));
      if (debits !== credits) {
        throw new ConflictException(`Opening journal would not balance (Dr ${debits} vs Cr ${credits})`);
      }

      const values: string[] = [];
      const params: unknown[] = [];
      journalLines.forEach((line) => {
        const base = params.length;
        values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`);
        params.push(
          orgId,
          entryId,
          idByCode.get(line.code),
          line.side === 'debit' ? String(line.amount) : '0',
          line.side === 'credit' ? String(line.amount) : '0',
          null,
        );
      });
      await c.query(
        `INSERT INTO journal_lines
           (organization_id, journal_entry_id, account_id, debit, credit, memo)
         VALUES ${values.join(', ')}`,
        params,
      );

      await c.query(
        `UPDATE opening_balance_batches
            SET status = 'POSTED', journal_entry_id = $2, posted_at = now()
          WHERE id = $1`,
        [batchId, entryId],
      );
      await c.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1, $2, 'migration.opening_balances.posted', 'opening_balance_batch', $3, $4)`,
        [
          orgId,
          actorUserId,
          batchId,
          JSON.stringify({ members: rows.length, savingsTotal, sharesTotal, loansTotal, entryNo }),
        ],
      );

      return {
        batchId,
        members: rows.length,
        savings: savingsTotal,
        shares: sharesTotal,
        loans: loansTotal,
        journalEntryId: entryId,
        entryNo,
      };
    });
  }

  /** Migration batches, newest first. */
  async list(organizationId: string | null): Promise<
    {
      id: string;
      label: string;
      status: string;
      memberCount: number;
      savingsTotal: number;
      sharesTotal: number;
      loansTotal: number;
      createdAt: Date;
      postedAt: Date | null;
    }[]
  > {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT id, label, status, member_count, savings_total, shares_total, loans_total,
                created_at, posted_at
           FROM opening_balance_batches ORDER BY created_at DESC LIMIT 100`,
      );
      return rows.map((r) => ({
        id: r.id as string,
        label: r.label as string,
        status: r.status as string,
        memberCount: Number(r.member_count),
        savingsTotal: Number(r.savings_total),
        sharesTotal: Number(r.shares_total),
        loansTotal: Number(r.loans_total),
        createdAt: r.created_at as Date,
        postedAt: (r.posted_at as Date | null) ?? null,
      }));
    });
  }

  /** One batch with its rows and member names. */
  async get(organizationId: string | null, batchId: string): Promise<unknown> {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const batch = await c.query(
        `SELECT * FROM opening_balance_batches WHERE id = $1`,
        [batchId],
      );
      const b = batch.rows[0] as Record<string, unknown> | undefined;
      if (!b) throw new NotFoundException('Batch not found');
      const rows = await c.query(
        `SELECT r.member_id, m.member_no, m.first_name || ' ' || m.last_name AS member_name,
                r.savings_amount, r.shares_amount, r.loan_outstanding, r.loan_term_months
           FROM opening_balance_rows r JOIN members m ON m.id = r.member_id
          WHERE r.batch_id = $1 ORDER BY m.last_name, m.first_name`,
        [batchId],
      );
      return {
        id: b.id,
        label: b.label,
        status: b.status,
        memberCount: Number(b.member_count),
        savingsTotal: Number(b.savings_total),
        sharesTotal: Number(b.shares_total),
        loansTotal: Number(b.loans_total),
        journalEntryId: b.journal_entry_id,
        createdAt: b.created_at,
        postedAt: b.posted_at,
        rows: rows.rows,
      };
    });
  }

}
