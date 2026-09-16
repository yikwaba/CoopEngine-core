import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { withTenant } from '@coopengine/db';
import { DB_POOL } from '../database/database.module';
import { LedgerService } from '../ledger/ledger.service';
import { PayrollService } from '../payroll/payroll.service';


interface WithdrawalRow {
  id: string;
  requested_by_user_id: string | null;
  amount: string;
  created_at: string;
  member_no: string;
  member: string;
  requested_by: string | null;
}
interface LoanRow {
  id: string;
  created_by: string | null;
  principal: string;
  created_at: string;
  member_no: string;
  member: string;
  requested_by: string | null;
}
interface JournalRow {
  id: string;
  created_by: string | null;
  entry_no: string;
  description: string;
  created_at: string;
  requested_by: string | null;
  amount: string;
}
interface BatchRow {
  id: string;
  submitted_by: string | null;
  filename: string;
  total_amount: string;
  valid_rows: string;
  created_at: string;
  submitted_at: string | null;
  requested_by: string | null;
}

export interface ApprovalItem {
  type: 'WITHDRAWAL' | 'LOAN' | 'JOURNAL' | 'PAYROLL';
  id: string;
  reference: string;
  summary: string;
  amount: string | null;
  requestedBy: string | null;
  requestedById: string | null;
  ageHours: number;
  /** Where the action lives, for screens that act on it directly. */
  actionBase: string;
  /** Whether this caller can decide it, and if not, why not. */
  canAct: boolean;
  blockedReason?: string;
}

/**
 * The approvals inbox.
 *
 * Four different things wait for a second pair of eyes — a member's withdrawal, a loan
 * application, a manual journal, a payroll batch — and until now each was only visible on its own
 * screen, so "what needs my decision?" had no single answer. This gathers them.
 *
 * It does not invent a state machine: every action here delegates to the module that owns the
 * decision (ledger.approveAndPost, payroll.approve/reject), so the rules — including segregation
 * of duties — are enforced in exactly one place each.
 */
@Injectable()
export class ApprovalsService {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    private readonly ledger: LedgerService,
    private readonly payroll: PayrollService,
  ) {}

  private static readonly ACTION_PERMISSION: Record<ApprovalItem['type'], string> = {
    WITHDRAWAL: 'savings.approve',
    LOAN: 'loans.approve',
    JOURNAL: 'ledger.approve',
    PAYROLL: 'payroll.approve',
  };

  /** Everything pending, newest first, annotated with what this caller may do about it. */
  async inbox(
    organizationId: string | null,
    permissions: string[],
    callerUserId: string,
  ): Promise<{ items: ApprovalItem[]; counts: Record<string, number> }> {
    const orgId = this.requireOrg(organizationId);
    const permitted = new Set(permissions);

    const items = await withTenant(this.pool, orgId, async (c) => {
      const collected: ApprovalItem[] = [];

      const withdrawals = await c.query(
        `SELECT r.id, r.amount, r.status, r.created_at, r.requested_by_user_id,
                m.member_no, m.first_name || ' ' || m.last_name AS member,
                u.email AS requested_by
           FROM savings_withdrawal_requests r
           JOIN members m ON m.id = r.member_id
           LEFT JOIN users u ON u.id = r.requested_by_user_id
          WHERE r.status = 'PENDING'
          ORDER BY r.created_at`,
      );
      for (const row of withdrawals.rows as WithdrawalRow[]) {
        collected.push({
          type: 'WITHDRAWAL',
          id: row.id,
          reference: `Withdrawal · member ${row.member_no} (${row.member})`,
          summary: `Payout to ${row.member}`,
          amount: row.amount,
          requestedBy: row.requested_by ?? null,
          requestedById: row.requested_by_user_id ?? null,
          ageHours: this.ageHours(row.created_at),
          actionBase: '/withdrawals',
          canAct: false, // filled in below: the requester may not decide their own
          blockedReason: undefined,
        });
      }

      const loans = await c.query(
        `SELECT l.id, l.principal, l.created_at, l.status, l.created_by,
                m.member_no, m.first_name || ' ' || m.last_name AS member,
                u.email AS requested_by
           FROM loans l
           JOIN members m ON m.id = l.member_id
           LEFT JOIN users u ON u.id = l.created_by
          WHERE l.status = 'PENDING'
          ORDER BY l.created_at`,
      );
      for (const row of loans.rows as LoanRow[]) {
        collected.push({
          type: 'LOAN',
          id: row.id,
          reference: `Loan application · member ${row.member_no} (${row.member})`,
          summary: `Loan of ${row.principal} for ${row.member}`,
          amount: row.principal,
          requestedBy: row.requested_by ?? null,
          requestedById: row.created_by ?? null,
          ageHours: this.ageHours(row.created_at),
          actionBase: '/loans',
          canAct: false,
          blockedReason: undefined,
        });
      }

      const journals = await c.query(
        `SELECT j.id, j.entry_no, j.description, j.created_at, j.created_by,
                u.email AS requested_by,
                (SELECT coalesce(sum(l.debit), 0)::text FROM journal_lines l
                  WHERE l.journal_entry_id = j.id AND l.organization_id = j.organization_id) AS amount
           FROM journal_entries j
           LEFT JOIN users u ON u.id = j.created_by
          WHERE j.status = 'SUBMITTED'
          ORDER BY j.created_at`,
      );
      for (const row of journals.rows as JournalRow[]) {
        collected.push({
          type: 'JOURNAL',
          id: row.id,
          reference: `Journal #${row.entry_no} · ${row.description}`,
          summary: row.description,
          amount: row.amount,
          requestedBy: row.requested_by ?? null,
          requestedById: row.created_by ?? null,
          ageHours: this.ageHours(row.created_at),
          actionBase: '/ledger/journals',
          canAct: false,
          blockedReason: undefined,
        });
      }

      const batches = await c.query(
        `SELECT b.id, b.filename, b.total_amount, b.valid_rows, b.created_at, b.submitted_at,
                coalesce(b.submitted_by, b.created_by) AS submitted_by,
                coalesce(b.submitted_by, b.created_by) AS submitted_by,
                u.email AS requested_by
           FROM payroll_batches b
           LEFT JOIN users u ON u.id = coalesce(b.submitted_by, b.created_by)
          WHERE b.status = 'SUBMITTED'
          ORDER BY b.created_at`,
      );
      for (const row of batches.rows as BatchRow[]) {
        collected.push({
          type: 'PAYROLL',
          id: row.id,
          reference: `Payroll · ${row.filename} (${row.valid_rows} members)`,
          summary: `Payroll deduction for ${row.valid_rows} members`,
          amount: row.total_amount,
          requestedBy: row.requested_by ?? null,
          requestedById: row.submitted_by ?? null,
          ageHours: this.ageHours(row.submitted_at ?? row.created_at),
          actionBase: '/payroll/batches',
          canAct: false,
          blockedReason: undefined,
        });
      }
      return collected;
    });

    // Segregation of duties is decided per item, not globally: holding the permission is not
    // enough when you are the person who raised it.
    for (const item of items) {
      const needs = ApprovalsService.ACTION_PERMISSION[item.type];
      if (!permitted.has(needs)) {
        item.blockedReason = `Requires the ${needs} permission`;
        continue;
      }
      // Withdrawals and payroll enforce segregation of duties: the person who raised it cannot
      // decide it. Saying so here saves an officer the round trip of being refused.
      const segregationApplies = item.type === 'WITHDRAWAL' || item.type === 'PAYROLL';
      if (segregationApplies && item.requestedById && item.requestedById === callerUserId) {
        item.blockedReason = 'You raised this — someone else must decide it';
        continue;
      }
      item.canAct = true;
    }

    const counts: Record<string, number> = {};
    for (const item of items) counts[item.type] = (counts[item.type] ?? 0) + 1;
    return { items, counts };
  }

  /** Payroll decisions delegate to the payroll module, which owns the maker-checker rule. */
  async approvePayroll(organizationId: string | null, userId: string, batchId: string) {
    return this.payroll.approve(organizationId, userId, batchId);
  }

  async rejectPayroll(
    organizationId: string | null,
    userId: string,
    batchId: string,
    reason: string,
  ) {
    return this.payroll.reject(organizationId, userId, batchId, reason);
  }

  /** Journal decisions delegate to the ledger. */
  async approveJournal(organizationId: string | null, userId: string, journalId: string) {
    const result = await this.ledger.approveAndPost(organizationId, userId, journalId);
    return { id: journalId, status: 'POSTED', journal: result };
  }

  private ageHours(value: string | Date | null | undefined): number {
    if (!value) return 0;
    const then = new Date(value).getTime();
    if (Number.isNaN(then)) return 0;
    return Math.max(0, Math.round(((Date.now() - then) / 3_600_000) * 10) / 10);
  }

  private requireOrg(organizationId: string | null): string {
    if (!organizationId) throw new NotFoundException('Organization context required');
    return organizationId;
  }
}
