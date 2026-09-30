import { Inject, Injectable, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
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

  /**
   * Raise a request against exactly one active policy and snapshot its steps.
   *
   * Policy selection is deliberately strict. A gap or overlap is a configuration
   * error and blocks the transaction: silently auto-approving, or arbitrarily
   * choosing one of two policies, would turn bad configuration into money movement.
   */
  async createRequest(
    organizationId: string | null,
    requesterUserId: string,
    input: {
      kind: 'WITHDRAWAL' | 'PAYROLL' | 'LOAN' | 'JOURNAL' | 'EXPENSE';
      entityType: string;
      entityId: string;
      amount: number;
      summary?: string;
      payload?: Record<string, unknown>;
    },
  ) {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, (client) =>
      this.createRequestInTransaction(client, orgId, requesterUserId, input),
    );
  }

  /** Same creation path for a caller that already owns the tenant transaction. */
  async createRequestInTransaction(
    client: PoolClient,
    orgId: string,
    requesterUserId: string,
    input: {
      kind: 'WITHDRAWAL' | 'PAYROLL' | 'LOAN' | 'JOURNAL' | 'EXPENSE';
      entityType: string;
      entityId: string;
      amount: number;
      summary?: string;
      payload?: Record<string, unknown>;
    },
  ) {
      const matched = await client.query<{
        id: string;
        version: number;
      }>(
        `SELECT id, version
           FROM approval_policies
          WHERE organization_id = $1
            AND kind = $2
            AND is_active = true
            AND min_amount <= $3::numeric
            AND (max_amount IS NULL OR max_amount >= $3::numeric)
          ORDER BY version DESC, created_at DESC
          FOR UPDATE`,
        [orgId, input.kind, input.amount],
      );

      if (matched.rowCount !== 1) {
        const reason = matched.rowCount === 0 ? 'no active policy covers this amount' : 'active policies overlap';
        throw new ConflictException(
          `Approval policy configuration error for ${input.kind} at NGN ${input.amount}: ${reason}`,
        );
      }
      const policy = matched.rows[0]!;
      const policySteps = await client.query<{
        step_no: number;
        approver_role_code: string | null;
        approver_user_id: string | null;
      }>(
        `SELECT step_no, approver_role_code, approver_user_id
           FROM approval_policy_steps
          WHERE organization_id = $1 AND policy_id = $2
          ORDER BY step_no`,
        [orgId, policy.id],
      );
      if (policySteps.rowCount === 0) {
        throw new ConflictException(`Approval policy ${policy.id} has no approval steps`);
      }

      const inserted = await client.query<{
        id: string;
        amount: string;
        status: string;
        current_step: number;
        total_steps: number;
      }>(
        `INSERT INTO approval_requests
           (organization_id, kind, entity_type, entity_id, amount, summary, payload,
            requested_by, policy_id, policy_version, total_steps, current_step)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, 1)
         RETURNING id, amount, status, current_step, total_steps`,
        [
          orgId,
          input.kind,
          input.entityType,
          input.entityId,
          input.amount,
          input.summary ?? null,
          JSON.stringify(input.payload ?? {}),
          requesterUserId,
          policy.id,
          policy.version,
          policySteps.rowCount,
        ],
      );
      const request = inserted.rows[0]!;

      for (const step of policySteps.rows) {
        await client.query(
          `INSERT INTO approval_steps
             (organization_id, request_id, step_no, approver_role_code, approver_user_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [orgId, request.id, step.step_no, step.approver_role_code, step.approver_user_id],
        );
      }
      await client.query(
        `INSERT INTO approval_actions
           (organization_id, request_id, actor_user_id, action)
         VALUES ($1, $2, $3, 'SUBMIT')`,
        [orgId, request.id, requesterUserId],
      );

      return {
        id: request.id,
        kind: input.kind,
        entityType: input.entityType,
        entityId: input.entityId,
        amount: request.amount,
        status: request.status,
        policyVersion: policy.version,
        currentStep: request.current_step,
        totalSteps: request.total_steps,
        steps: policySteps.rows.map((step) => ({
          stepNo: step.step_no,
          approverRoleCode: step.approver_role_code,
          approverUserId: step.approver_user_id,
          status: 'PENDING',
        })),
      };
  }

  /** Decide only the current step, as the role or named user frozen on it. */
  async decideRequest(
    organizationId: string | null,
    actorUserId: string,
    requestId: string,
    input: { decision: 'APPROVE' | 'REJECT'; comment?: string },
  ) {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (client) => {
      const found = await client.query<{
        id: string;
        status: string;
        current_step: number;
        total_steps: number;
        requested_by: string;
        kind: string;
      }>(
        `SELECT id, status, current_step, total_steps, requested_by, kind
           FROM approval_requests
          WHERE organization_id = $1 AND id = $2
          FOR UPDATE`,
        [orgId, requestId],
      );
      if (found.rowCount !== 1) throw new NotFoundException('Approval request not found');
      const approval = found.rows[0]!;
      if (approval.status !== 'PENDING') {
        throw new ConflictException(`Approval request is already ${approval.status}`);
      }
      if (approval.requested_by === actorUserId) {
        throw new ConflictException('You raised this request; a different user must approve it');
      }

      const stepResult = await client.query<{
        id: string;
        step_no: number;
        approver_role_code: string | null;
        approver_user_id: string | null;
        status: string;
      }>(
        `SELECT id, step_no, approver_role_code, approver_user_id, status
           FROM approval_steps
          WHERE organization_id = $1 AND request_id = $2 AND step_no = $3
          FOR UPDATE`,
        [orgId, requestId, approval.current_step],
      );
      if (stepResult.rowCount !== 1) {
        throw new ConflictException(`Approval request has no step ${approval.current_step}`);
      }
      const step = stepResult.rows[0]!;
      if (step.status !== 'PENDING') {
        throw new ConflictException(`Approval step ${step.step_no} is already ${step.status}`);
      }

      let authorized = step.approver_user_id === actorUserId;
      let delegatedFrom: string | null = null;
      if (!authorized && step.approver_role_code) {
        const role = await client.query(
          `SELECT 1
             FROM user_roles ur
             JOIN roles r ON r.id = ur.role_id
            WHERE ur.organization_id = $1
              AND ur.user_id = $2
              AND r.code = $3
            LIMIT 1`,
          [orgId, actorUserId, step.approver_role_code],
        );
        authorized = role.rowCount === 1;
      }
      if (!authorized && step.approver_user_id) {
        const delegation = await client.query(
          `SELECT id
             FROM approval_delegations
            WHERE organization_id = $1
              AND from_user_id = $2
              AND to_user_id = $3
              AND is_active = true
              AND valid_from <= now()
              AND (valid_to IS NULL OR valid_to >= now())
              AND (kind IS NULL OR kind = $4)
            ORDER BY valid_from DESC
            LIMIT 1`,
          [orgId, step.approver_user_id, actorUserId, approval.kind],
        );
        if (delegation.rowCount === 1) {
          authorized = true;
          delegatedFrom = step.approver_user_id;
        }
      }
      if (!authorized) {
        const required = step.approver_user_id
          ? 'the named approver or their active delegate'
          : `the ${step.approver_role_code} role`;
        throw new ForbiddenException(`Current approval step requires ${required}`);
      }
      if (delegatedFrom) {
        await client.query(
          `INSERT INTO approval_actions
             (organization_id, request_id, step_no, actor_user_id, action, comment)
           VALUES ($1, $2, $3, $4, 'DELEGATE', $5)`,
          [
            orgId,
            requestId,
            step.step_no,
            actorUserId,
            `Acting under active delegation from user ${delegatedFrom}`,
          ],
        );
      }

      if (input.decision === 'REJECT') {
        await client.query(
          `UPDATE approval_steps
              SET status = 'REJECTED', acted_by = $1, acted_at = now(), comment = $2
            WHERE id = $3`,
          [actorUserId, input.comment ?? null, step.id],
        );
        await client.query(
          `INSERT INTO approval_actions
             (organization_id, request_id, step_no, actor_user_id, action, comment)
           VALUES ($1, $2, $3, $4, 'REJECT', $5)`,
          [orgId, requestId, step.step_no, actorUserId, input.comment ?? null],
        );
        await client.query(
          `UPDATE approval_requests
              SET status = 'REJECTED', decided_at = now(), decided_by = $1
            WHERE id = $2`,
          [actorUserId, requestId],
        );
        return {
          id: requestId,
          status: 'REJECTED',
          currentStep: approval.current_step,
          decidedStep: step.step_no,
          nextApproverRoleCode: null,
        };
      }

      await client.query(
        `UPDATE approval_steps
            SET status = 'APPROVED', acted_by = $1, acted_at = now(), comment = $2
          WHERE id = $3`,
        [actorUserId, input.comment ?? null, step.id],
      );
      await client.query(
        `INSERT INTO approval_actions
           (organization_id, request_id, step_no, actor_user_id, action, comment)
         VALUES ($1, $2, $3, $4, 'APPROVE', $5)`,
        [orgId, requestId, step.step_no, actorUserId, input.comment ?? null],
      );

      if (step.step_no === approval.total_steps) {
        await client.query(
          `UPDATE approval_requests
              SET status = 'APPROVED', decided_at = now(), decided_by = $1
            WHERE id = $2`,
          [actorUserId, requestId],
        );
        return {
          id: requestId,
          status: 'APPROVED',
          currentStep: approval.current_step,
          decidedStep: step.step_no,
          nextApproverRoleCode: null,
        };
      }

      const nextStepNo = step.step_no + 1;
      await client.query(`UPDATE approval_requests SET current_step = $1 WHERE id = $2`, [
        nextStepNo,
        requestId,
      ]);
      const next = await client.query<{ approver_role_code: string | null }>(
        `SELECT approver_role_code FROM approval_steps
          WHERE organization_id = $1 AND request_id = $2 AND step_no = $3`,
        [orgId, requestId, nextStepNo],
      );
      if (next.rowCount !== 1) {
        throw new ConflictException(`Approval chain is missing step ${nextStepNo}`);
      }
      return {
        id: requestId,
        status: 'PENDING',
        currentStep: nextStepNo,
        decidedStep: step.step_no,
        nextApproverRoleCode: next.rows[0]!.approver_role_code,
      };
    });
  }

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
