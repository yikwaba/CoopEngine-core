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
import { LedgerService } from '../ledger/ledger.service';
import { parseCsv } from '../members/csv';
import { PreviewImportDto } from '../members/dto/import-member.dto';

export interface PayrollPreviewResult {
  batchId: string;
  filename: string;
  totals: { totalRows: number; valid: number; invalid: number; totalAmount: number };
  errors: { row: number; reason: string }[];
}

export interface PayrollCommitResult {
  batchId: string;
  committed: number;
  totalAmount: number;
  skipped: { row: number; reason: string }[];
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const MAX_AMOUNT = 100_000_000;

const NORM = (h: string): string => h.trim().toLowerCase().replace(/\s+/g, '');
const REQUIRED_HEADERS = ['memberNo', 'amount'];

/** Payroll deduction row validated for one member. */
interface ValidRow {
  memberNo: number;
  memberId: string;
  amount: number;
}

@Injectable()
export class PayrollService {
  constructor(@Inject(DB_POOL) private readonly pool: Pool,
    private readonly ledger: LedgerService,
  ) {}

  private requireOrg(organizationId: string | null): string {
    if (!organizationId) {
      throw new ForbiddenException('Organization context required');
    }
    return organizationId;
  }

  /** Parse + validate a payroll CSV; persist the preview batch (FR-020). */
  async preview(
    organizationId: string | null,
    actorUserId: string,
    dto: PreviewImportDto,
  ): Promise<PayrollPreviewResult> {
    const orgId = this.requireOrg(organizationId);
    const parsed = parseCsv(dto.csv);
    if (parsed.length < 2) {
      throw new BadRequestException('CSV must contain a header row and data rows');
    }
    const headerMap = new Map<string, number>();
    parsed[0]!.forEach((h, i) => {
      const key = NORM(h);
      if (!headerMap.has(key)) headerMap.set(key, i);
    });
    const missing = REQUIRED_HEADERS.filter((h) => !headerMap.has(NORM(h)));
    if (missing.length > 0) {
      throw new BadRequestException(`Missing CSV columns: ${missing.join(', ')}`);
    }

    const errors: { row: number; reason: string }[] = [];
    const valid: ValidRow[] = [];
    const seenMembers = new Set<number>();
    const indexOf = (h: string) => headerMap.get(NORM(h))!;

    for (let i = 1; i < parsed.length; i += 1) {
      const cells = parsed[i]!;
      const csvRow = i + 1;
      const memberNoRaw = (cells[indexOf('memberNo')] ?? '').trim();
      const amountRaw = (cells[indexOf('amount')] ?? '').trim();
      const memberNo = Number(memberNoRaw);
      const amount = Number(amountRaw);
      const reasons: string[] = [];
      if (!Number.isInteger(memberNo) || memberNo < 1) {
        reasons.push('memberNo must be a positive integer');
      }
      if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
        reasons.push('amount must be > 0');
      } else if (round2(amount) !== amount) {
        reasons.push('amount supports at most 2 decimals');
      }
      if (memberNo >= 1 && seenMembers.has(memberNo)) {
        reasons.push(`duplicate memberNo ${memberNo} in file`);
      }
      if (reasons.length > 0) {
        errors.push({ row: csvRow, reason: reasons.join('; ') });
        continue;
      }
      seenMembers.add(memberNo);
      valid.push({ memberNo, memberId: '', amount: round2(amount) });
    }

    // Resolve members + persist the preview batch inside one tenant tx (RLS)
    const batchId = randomUUID();
    let totalAmount = 0;
    const rowsJson: { memberNo: number; memberId: string; amount: number }[] = [];
    await withTenant(this.pool, orgId, async (c) => {
      const memberNos = [...new Set(valid.map((v) => v.memberNo))];
      const memberById = new Map<number, { id: string; status: string }>();
      const { rows } = await c.query(
        `SELECT id, member_no, status FROM members
          WHERE organization_id = $1 AND member_no = ANY($2::bigint[])`,
        [orgId, memberNos],
      );
      for (const r of rows as { id: string; member_no: number; status: string }[]) {
        memberById.set(Number(r.member_no), { id: r.id, status: r.status });
      }
      const stillValid: ValidRow[] = [];
      for (const v of valid) {
        const member = memberById.get(v.memberNo);
        if (!member) {
          errors.push({ row: v.memberNo, reason: `no member with number ${v.memberNo}` });
        } else if (member.status !== 'ACTIVE') {
          errors.push({ row: v.memberNo, reason: `member ${v.memberNo} is ${member.status}` });
        } else {
          stillValid.push({ ...v, memberId: member.id });
        }
      }
      totalAmount = round2(stillValid.reduce((a, v) => a + v.amount, 0));
      rowsJson.push(
        ...stillValid.map((v) => ({ memberNo: v.memberNo, memberId: v.memberId, amount: v.amount })),
      );
      await c.query(
        `INSERT INTO payroll_batches (id, organization_id, filename, status, total_rows, valid_rows, invalid_count, rows, total_amount, created_by)
         VALUES ($1, $2, $3, 'PREVIEWED', $4, $5, $6, $7, $8, $9)`,
        [
          batchId,
          orgId,
          dto.filename,
          parsed.length - 1,
          stillValid.length,
          errors.length,
          JSON.stringify(rowsJson),
          String(totalAmount),
          actorUserId,
        ],
      );
    });

    return {
      batchId,
      filename: dto.filename,
      totals: {
        totalRows: parsed.length - 1,
        valid: rowsJson.length,
        invalid: errors.length,
        totalAmount,
      },
      errors,
    };
  }

  /**
   * Commit: one balanced journal (Dr Cash at Bank 1000 total / Cr Member
   * Savings Deposits 2000 per member), opening missing accounts, updating
   * balances + transaction projections — all in one tenant transaction.
   */
  private async postBatch(
    orgId: string,
    actorUserId: string,
    batchId: string,
  ): Promise<PayrollCommitResult> {
    const skipped: { row: number; reason: string }[] = [];
    let committed = 0;
    let totalPosted = 0;

    await withTenant(this.pool, orgId, async (c) => {
      const batch = await c.query(
        `SELECT id, status, rows FROM payroll_batches
          WHERE organization_id = $1 AND id = $2`,
        [orgId, batchId],
      );
      const b = batch.rows[0] as
        | { id: string; status: string; rows: unknown }
        | undefined;
      if (!b) throw new NotFoundException('Payroll batch not found');
      if (b.status === 'POSTED' || b.status === 'REVERSED') {
        throw new ConflictException('This payroll batch has already been posted');
      }
      if (b.status === 'REJECTED') {
        throw new ConflictException('This payroll batch was rejected; submit a corrected one');
      }
      if (b.status !== 'SUBMITTED') {
        throw new ConflictException('Submit the batch for approval before posting it');
      }
      const rows = (b.rows ?? []) as {
        memberNo: number;
        memberId: string;
        amount: number;
      }[];

      // Re-validate members are still ACTIVE inside the transaction
      const amountsByMember = new Map<string, number>();
      const memberNos = rows.map((r) => r.memberNo);
      const members = await c.query(
        `SELECT id, member_no FROM members
          WHERE organization_id = $1 AND member_no = ANY($2::bigint[]) AND status = 'ACTIVE'`,
        [orgId, memberNos],
      );
      const activeIds = new Set(
        (members.rows as { id: string }[]).map((r) => r.id),
      );
      for (const row of rows) {
        if (!activeIds.has(row.memberId)) {
          skipped.push({ row: row.memberNo, reason: 'member no longer ACTIVE' });
          continue;
        }
        amountsByMember.set(
          row.memberId,
          round2((amountsByMember.get(row.memberId) ?? 0) + row.amount),
        );
      }
      if (amountsByMember.size === 0) {
        throw new BadRequestException('No valid payroll rows to commit');
      }

      // Open savings accounts for members who do not have one yet
      const memberIds = [...amountsByMember.keys()];
      const accounts = await c.query(
        `SELECT a.id, a.member_id, a.account_no, a.current_balance
           FROM member_savings_accounts a
          WHERE a.organization_id = $1 AND a.member_id = ANY($2::uuid[])
            AND a.status = 'ACTIVE'`,
        [orgId, memberIds],
      );
      const accountByMember = new Map<
        string,
        { id: string; accountNo: number; currentBalance: number }
      >();
      for (const r of accounts.rows as {
        id: string;
        member_id: string;
        account_no: string | number;
        current_balance: string;
      }[]) {
        accountByMember.set(r.member_id, {
          id: r.id,
          accountNo: Number(r.account_no),
          currentBalance: Number(r.current_balance),
        });
      }
      await c.query(
        `INSERT INTO org_counters (organization_id) VALUES ($1) ON CONFLICT (organization_id) DO NOTHING`,
        [orgId],
      );
      const product = await c.query(
        `SELECT id FROM savings_products
          WHERE organization_id = $1 AND code = 'REGULAR-SAVINGS'`,
        [orgId],
      );
      const productId = (product.rows[0] as { id: string } | undefined)?.id;
      if (!productId) {
        throw new BadRequestException('Default REGULAR-SAVINGS product not found');
      }
      for (const memberId of memberIds) {
        if (accountByMember.has(memberId)) continue;
        const seq = await c.query(
          `UPDATE org_counters SET savings_seq = savings_seq + 1, updated_at = now()
            WHERE organization_id = $1 RETURNING savings_seq`,
          [orgId],
        );
        const accountNo = Number(
          (seq.rows[0] as { savings_seq: string | number }).savings_seq,
        );
        const ins = await c.query(
          `INSERT INTO member_savings_accounts (organization_id, member_id, product_id, account_no)
           VALUES ($1, $2, $3, $4) RETURNING id, account_no, current_balance`,
          [orgId, memberId, productId, accountNo],
        );
        const row = ins.rows[0] as {
          id: string;
          account_no: string;
          current_balance: string;
        };
        accountByMember.set(memberId, {
          id: row.id,
          accountNo: Number(row.account_no),
          currentBalance: 0,
        });
      }

      // Ledger entry: Dr 1000 (total) / Cr 2000 per member — single statement
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
      const seqJ = await c.query(
        `UPDATE org_counters SET journal_seq = journal_seq + 1, updated_at = now()
          WHERE organization_id = $1 RETURNING journal_seq`,
        [orgId],
      );
      const entryNo = Number(
        (seqJ.rows[0] as { journal_seq: string | number }).journal_seq,
      );
      const entryId = randomUUID();
      await c.query(
        `INSERT INTO journal_entries
           (id, organization_id, period_id, entry_date, description, source,
            source_type, source_id, status, entry_no, created_by, posted_by, posted_at)
         VALUES ($1, $2, $3, now()::date, $4, 'PAYROLL_DEDUCTION', 'payroll_batch', $5,
                 'POSTED', $6, $7, $7, now())`,
        [
          entryId,
          orgId,
          periodId,
          `Payroll deductions (${rows.length} members)`,
          batchId,
          entryNo,
          actorUserId,
        ],
      );
      const accRes = await c.query(
        `SELECT id, code FROM chart_of_accounts
          WHERE organization_id = $1 AND code = ANY($2::varchar[])`,
        [orgId, ['1000', '2000']],
      );
      const idByCode = new Map<string, string>();
      for (const r of accRes.rows as { id: string; code: string }[]) {
        idByCode.set(r.code, r.id);
      }
      const missing = ['1000', '2000'].find((code) => !idByCode.has(code));
      if (missing) throw new BadRequestException(`Unknown account code: ${missing}`);

      const total = round2([...amountsByMember.values()].reduce((a, b) => a + b, 0));
      // Line values: 1 cash debit (Dr 1000 total) + 1 credit per member (Cr 2000)
      const values: string[] = [];
      const params: unknown[] = [];
      const pushLine = (
        accountId: string,
        debit: string,
        credit: string,
        memberId: string | null,
      ) => {
        const base = params.length;
        values.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`,
        );
        params.push(orgId, entryId, accountId, debit, credit, memberId);
      };
      pushLine(idByCode.get('1000')!, String(total), '0', null);
      for (const [memberId, amount] of amountsByMember) {
        pushLine(idByCode.get('2000')!, '0', String(round2(amount)), memberId);
      }
      await c.query(
        `INSERT INTO journal_lines (organization_id, journal_entry_id, account_id, debit, credit, member_id)
         VALUES ${values.join(', ')}`,
        params,
      );

      // Update balances + transaction projections
      for (const [memberId, amount] of amountsByMember) {
        const account = accountByMember.get(memberId)!;
        const balance = round2(account.currentBalance + amount);
        await c.query(
          `UPDATE member_savings_accounts SET current_balance = $1
            WHERE organization_id = $2 AND id = $3`,
          [String(balance), orgId, account.id],
        );
        await c.query(
          `INSERT INTO savings_transactions (organization_id, account_id, journal_entry_id, type, signed_amount, running_balance)
           VALUES ($1, $2, $3, 'DEPOSIT', $4, $5)`,
          [orgId, account.id, entryId, String(amount), String(balance)],
        );
      }

      // POSTED, and the entries it created are recorded so a reversal can undo exactly those.
      await c.query(
        `UPDATE payroll_batches
            SET status = 'POSTED',
                committed_by = $1, committed_at = now(),
                approved_by = $1, approved_at = now(),
                journal_entry_ids = (
                  SELECT coalesce(jsonb_agg(id), '[]'::jsonb)
                    FROM journal_entries
                   WHERE organization_id = $2 AND source_type = 'payroll_batch' AND source_id = $3
                )
          WHERE organization_id = $2 AND id = $3`,
        [actorUserId, orgId, batchId],
      );
      await c.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1, $2, 'payroll.imported', 'payroll_batch', $3, $4)`,
        [
          orgId,
          actorUserId,
          batchId,
          JSON.stringify({ entryNo, total, members: amountsByMember.size }),
        ],
      );
      committed = amountsByMember.size;
      totalPosted = total;
    });
    return { batchId, committed, totalAmount: totalPosted, skipped };
  }

  /** Upload staged a preview; this puts it in front of an approver. */
  async submit(organizationId: string | null, actorUserId: string, batchId: string) {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT id, status, valid_rows, total_amount FROM payroll_batches
          WHERE organization_id = $1 AND id = $2`,
        [orgId, batchId],
      );
      const batch = rows[0] as
        | { id: string; status: string; valid_rows: string | number; total_amount: string }
        | undefined;
      if (!batch) throw new NotFoundException('Payroll batch not found');
      if (batch.status === 'SUBMITTED') {
        throw new ConflictException('This batch is already waiting for approval');
      }
      if (batch.status === 'POSTED' || batch.status === 'REVERSED') {
        throw new ConflictException('This batch has already been posted');
      }
      if (Number(batch.valid_rows) === 0) {
        throw new ConflictException('This batch has no valid rows to submit');
      }
      await c.query(
        `UPDATE payroll_batches
            SET status = 'SUBMITTED', submitted_by = $1, submitted_at = now()
          WHERE organization_id = $2 AND id = $3`,
        [actorUserId, orgId, batchId],
      );
      await c.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1, $2, 'payroll.submitted', 'payroll_batch', $3, '{}'::jsonb)`,
        [orgId, actorUserId, batchId],
      );
      return {
        id: batchId,
        status: 'SUBMITTED',
        totalAmount: batch.total_amount,
        members: Number(batch.valid_rows),
      };
    });
  }

  /**
   * Approve and post, atomically. The approver must not be the person who submitted it: money
   * leaving many members' savings at once deserves a second pair of eyes, and the whole batch
   * posts in one transaction or not at all.
   */
  async approve(organizationId: string | null, actorUserId: string, batchId: string) {
    const orgId = this.requireOrg(organizationId);
    const submittedBy = await withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT submitted_by, created_by, status FROM payroll_batches
          WHERE organization_id = $1 AND id = $2`,
        [orgId, batchId],
      );
      const batch = rows[0] as
        | { submitted_by: string | null; created_by: string | null; status: string }
        | undefined;
      if (!batch) throw new NotFoundException('Payroll batch not found');
      if (batch.status !== 'SUBMITTED') {
        throw new ConflictException('Only a submitted batch can be approved');
      }
      return batch.submitted_by ?? batch.created_by;
    });
    if (submittedBy && submittedBy === actorUserId) {
      throw new ConflictException(
        'A payroll batch must be approved by a different user (segregation of duties)',
      );
    }
    return this.postBatch(orgId, actorUserId, batchId);
  }

  /** Reject a submitted batch: nothing is posted and the reason is kept. */
  async reject(
    organizationId: string | null,
    actorUserId: string,
    batchId: string,
    reason: string,
  ) {
    const orgId = this.requireOrg(organizationId);
    if (!reason?.trim()) throw new BadRequestException('A rejection reason is required');
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `UPDATE payroll_batches
            SET status = 'REJECTED', rejected_by = $1, rejected_at = now(), rejection_reason = $4
          WHERE organization_id = $2 AND id = $3 AND status = 'SUBMITTED'
          RETURNING id, status`,
        [actorUserId, orgId, batchId, reason.trim()],
      );
      if (!rows[0]) throw new ConflictException('Only a submitted batch can be rejected');
      await c.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1, $2, 'payroll.rejected', 'payroll_batch', $3, $4::jsonb)`,
        [orgId, actorUserId, batchId, JSON.stringify({ reason: reason.trim() })],
      );
      return rows[0];
    });
  }

  /**
   * Reverse a posted batch. Every journal entry it created is reversed through the ledger, so the
   * correction follows the same path as any other reversal and appears in the audit trail.
   */
  async reverse(
    organizationId: string | null,
    actorUserId: string,
    batchId: string,
    reason: string,
  ) {
    const orgId = this.requireOrg(organizationId);
    if (!reason?.trim()) throw new BadRequestException('A reversal reason is required');

    const batch = await withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT id, status, journal_entry_ids, total_amount FROM payroll_batches
          WHERE organization_id = $1 AND id = $2`,
        [orgId, batchId],
      );
      return rows[0] as
        | { id: string; status: string; journal_entry_ids: string[]; total_amount: string }
        | undefined;
    });
    if (!batch) throw new NotFoundException('Payroll batch not found');
    if (batch.status !== 'POSTED') {
      throw new ConflictException('Only a posted batch can be reversed');
    }

    const entries = Array.isArray(batch.journal_entry_ids) ? batch.journal_entry_ids : [];
    if (entries.length === 0) {
      // Fall back to the source stamp, in case a batch was posted before this column existed.
      const found = await withTenant(this.pool, orgId, (c) =>
        c.query(
          `SELECT id FROM journal_entries
            WHERE organization_id = $1 AND source_type = 'payroll_batch' AND source_id = $2
              AND status = 'POSTED'`,
          [orgId, batchId],
        ),
      );
      entries.push(...(found.rows as { id: string }[]).map((r) => r.id));
    }

    const reversed: string[] = [];
    for (const entryId of entries) {
      const result = await this.ledger.reverse(orgId, actorUserId, entryId, reason.trim());
      reversed.push((result.reversal as { id?: string })?.id ?? entryId);
    }

    // Reversing the journal balances the books; it does not by itself move the money back out of
    // the members' savings accounts, so that is done here — in the same place the posting put it
    // in, and with the same refusal to overdraw: if a member has already spent it, an officer has
    // to deal with that rather than the system quietly inventing a negative balance.
    await withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT rows FROM payroll_batches WHERE organization_id = $1 AND id = $2`,
        [orgId, batchId],
      );
      const postedRows = ((rows[0] as { rows: unknown } | undefined)?.rows ?? []) as {
        memberId: string;
        amount: number;
      }[];

      for (const row of postedRows) {
        const account = await c.query(
          `SELECT id, current_balance FROM member_savings_accounts
            WHERE organization_id = $1 AND member_id = $2 AND status = 'ACTIVE'
            ORDER BY opened_at LIMIT 1`,
          [orgId, row.memberId],
        );
        const acc = account.rows[0] as { id: string; current_balance: string } | undefined;
        if (!acc) continue;
        const balance = round2(Number(acc.current_balance));
        if (balance < round2(row.amount)) {
          throw new ConflictException(
            `Member ${row.memberId} has only ${balance} in savings; the ${row.amount} this batch ` +
              'credited has already been used, so it must be resolved by hand',
          );
        }
        const after = round2(balance - row.amount);
        await c.query(
          `UPDATE member_savings_accounts SET current_balance = $1
            WHERE organization_id = $2 AND id = $3`,
          [String(after), orgId, acc.id],
        );
        await c.query(
          `INSERT INTO savings_transactions
             (organization_id, account_id, journal_entry_id, type, signed_amount, running_balance)
           VALUES ($1, $2, $3, 'WITHDRAWAL', $4, $5)`,
          [orgId, acc.id, reversed[0] ?? null, String(-round2(row.amount)), String(after)],
        );
      }
    });

    await withTenant(this.pool, orgId, async (c) => {
      await c.query(
        `UPDATE payroll_batches
            SET status = 'REVERSED', reversed_by = $1, reversed_at = now(), reversal_reason = $4
          WHERE organization_id = $2 AND id = $3`,
        [actorUserId, orgId, batchId, reason.trim()],
      );
      await c.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1, $2, 'payroll.reversed', 'payroll_batch', $3, $4::jsonb)`,
        [
          orgId,
          actorUserId,
          batchId,
          JSON.stringify({ reason: reason.trim(), entriesReversed: reversed.length }),
        ],
      );
    });
    return { id: batchId, status: 'REVERSED', entriesReversed: reversed.length };
  }

  /** Batch history: what was uploaded, who submitted it, where it stands. */
  async listBatches(
    organizationId: string | null,
    filters: { status?: string; limit?: number } = {},
  ) {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT b.id, b.filename, b.kind, b.status, b.total_rows, b.valid_rows, b.total_amount,
                b.created_at, b.submitted_at, b.approved_at, b.reversed_at, b.rejection_reason,
                b.reversal_reason,
                su.email AS submitted_by, au.email AS approved_by, cu.email AS created_by
           FROM payroll_batches b
           LEFT JOIN users su ON su.id = b.submitted_by
           LEFT JOIN users au ON au.id = b.approved_by
           LEFT JOIN users cu ON cu.id = b.created_by
          WHERE ($1::text IS NULL OR b.status = $1)
          ORDER BY b.created_at DESC
          LIMIT $2`,
        [filters.status ?? null, Math.min(filters.limit ?? 50, 200)],
      );
      return rows;
    });
  }

  /** One batch, with the rows it would post. */
  async batchDetail(organizationId: string | null, batchId: string) {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT id, filename, kind, status, total_rows, valid_rows, total_amount, rows,
                created_at, submitted_at, approved_at, reversed_at, rejection_reason, reversal_reason
           FROM payroll_batches WHERE organization_id = $1 AND id = $2`,
        [orgId, batchId],
      );
      if (!rows[0]) throw new NotFoundException('Payroll batch not found');
      return rows[0];
    });
  }
}
