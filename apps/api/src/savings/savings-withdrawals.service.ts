import { financialIntent } from '../common/financial-intent';
import { moneyDecimal, moneyKobo } from '../common/money';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { withTenant } from '@coopengine/db';
import { DB_POOL } from '../database/database.module';
import { SavingsService, SavingsAccountRow } from './savings.service';
import { ApprovalsService } from '../approvals/approvals.service';

export type WithdrawalDecision =
  | { kind: 'POSTED'; account: SavingsAccountRow }
  | { kind: 'PENDING'; requestId: string; status: 'PENDING' };

export interface WithdrawalRequestRow {
  id: string;
  accountId: string;
  memberId: string;
  memberNo: number | null;
  memberName: string | null;
  amount: number;
  description: string | null;
  status: string;
  source: string;
  requestedBy: string | null;
  requestedAt: Date;
  decidedAt: Date | null;
  decisionNotes: string | null;
  journalEntryId: string | null;
}


/**
 * Maker-checker control for savings withdrawals.
 *
 * Policy comes from `organizations.withdrawal_approval_threshold`:
 *   NULL  -> post immediately (default)
 *   0     -> every withdrawal needs approval
 *   N > 0 -> withdrawals above N need approval
 *
 * A request can never be approved by the person who raised it, and approved
 * withdrawals are posted through SavingsService.withdraw() with an idempotency
 * key derived from the request id, so a retry cannot pay twice.
 */
@Injectable()
export class SavingsWithdrawalsService {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    private readonly savings: SavingsService,
    private readonly approvals: ApprovalsService,
  ) {}

  private requireOrg(organizationId: string | null): string {
    if (!organizationId) throw new ConflictException('No organization in context');
    return organizationId;
  }

  async policy(organizationId: string | null): Promise<{ threshold: number | null }> {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT withdrawal_approval_threshold FROM organizations WHERE id = $1`,
        [orgId],
      );
      const raw = (rows[0] as { withdrawal_approval_threshold: string | null } | undefined)
        ?.withdrawal_approval_threshold;
      return { threshold: raw === null || raw === undefined ? null : Number(raw) };
    });
  }

  async setThreshold(
    organizationId: string | null,
    actorUserId: string,
    threshold: number | null,
  ): Promise<{ threshold: number | null }> {
    const orgId = this.requireOrg(organizationId);
    if (threshold !== null && (!Number.isFinite(threshold) || threshold < 0)) {
      throw new BadRequestException('threshold must be null or a non-negative amount');
    }
    return withTenant(this.pool, orgId, async (c) => {
      await c.query(`UPDATE organizations SET withdrawal_approval_threshold = $2 WHERE id = $1`, [
        orgId,
        threshold === null ? null : moneyDecimal(moneyKobo(threshold)),
      ]);
      await c.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1, $2, 'savings.withdrawal_policy.updated', 'organization', $1, $3)`,
        [orgId, actorUserId, JSON.stringify({ threshold })],
      );
      return { threshold };
    });
  }

  /** Applies the policy: post now, or park the withdrawal for approval. */
  async request(
    organizationId: string | null,
    actorUserId: string | null,
    source: 'STAFF' | 'MEMBER',
    memberId: string | null,
    accountId: string,
    amount: number,
    description?: string,
    idempotencyKey?: string,
  ): Promise<WithdrawalDecision> {
    const orgId = this.requireOrg(organizationId);
    const value = moneyKobo(amount);
    if (value <= 0n) throw new BadRequestException('Invalid amount');

    return financialIntent<WithdrawalDecision>(this.pool,orgId,'savings.withdrawal.request',idempotencyKey,
      {actorUserId,source,memberId,accountId,amount:moneyDecimal(value),description:description??null},async(c,journalKey)=>{
    const result = await c.query('SELECT withdrawal_approval_threshold FROM organizations WHERE id=$1', [orgId]);
    const raw = result.rows[0]?.withdrawal_approval_threshold as string | null | undefined;
    const threshold = raw == null ? null : moneyKobo(raw);
    const needsApproval =
      source === 'MEMBER' || (threshold !== null && (threshold === 0n || value > threshold));

    if (!needsApproval && actorUserId) {
      const account = await this.savings.withdraw(
        orgId,
        actorUserId,
        accountId,
        amount,
        description,
        undefined,c,journalKey,
      );
      return { kind: 'POSTED', account };
    }

      const acc = await c.query(
        `SELECT a.id, a.member_id, a.status FROM member_savings_accounts a
          WHERE a.id = $1 AND a.organization_id = $2`,
        [accountId, orgId],
      );
      const account = acc.rows[0] as { id: string; member_id: string; status: string } | undefined;
      if (!account) throw new NotFoundException('Savings account not found');
      if (account.status !== 'ACTIVE') throw new ConflictException('Account is not active');
      if (memberId && memberId !== account.member_id) {
        throw new BadRequestException('Account does not belong to this member');
      }

      const id = (
        await c.query(
          `INSERT INTO savings_withdrawal_requests
             (organization_id, account_id, member_id, amount, description, status, source,
              requested_by_user_id, requested_by_member_id)
           VALUES ($1, $2, $3, $4, $5, 'PENDING', $6, $7, $8)
           RETURNING id`,
          [
            orgId,
            accountId,
            account.member_id,
            moneyDecimal(value),
            description?.slice(0, 240) ?? null,
            source,
            source === 'STAFF' ? actorUserId : null,
            source === 'MEMBER' ? memberId : null,
          ],
        )
      ).rows[0] as { id: string };

      // A tenant opts into the engine by defining at least one active withdrawal
      // policy. From that point the engine is authoritative: a gap or overlap rolls
      // this transaction back, so a parked withdrawal can never exist without its
      // approval request. Member-originated requests remain on the legacy staff
      // approval path until approval_requests can carry member identity (0041).
      if (source === 'STAFF' && actorUserId) {
        const configured = await c.query(
          `SELECT 1 FROM approval_policies
            WHERE organization_id = $1 AND kind = 'WITHDRAWAL' AND is_active = true
            LIMIT 1`,
          [orgId],
        );
        if (configured.rowCount === 1) {
          await this.approvals.createRequestInTransaction(c, orgId, actorUserId, {
            kind: 'WITHDRAWAL',
            entityType: 'savings_withdrawal_request',
            entityId: id.id,
            amount: Number(moneyDecimal(value)),
            summary: description ?? `Savings withdrawal from account ${accountId}`,
            payload: { accountId, memberId: account.member_id, source },
          });
        }
      }

      await c.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1, $2, 'savings.withdrawal.requested', 'savings_withdrawal_request', $3, $4)`,
        [
          orgId,
          actorUserId,
          id.id,
          JSON.stringify({ accountId, amount: moneyDecimal(value), source, threshold: threshold === null ? null : moneyDecimal(threshold) }),
        ],
      );

      return { kind: 'PENDING', requestId: id.id, status: 'PENDING' };
    });
  }

  async list(
    organizationId: string | null,
    status?: string,
    memberId?: string,
  ): Promise<WithdrawalRequestRow[]> {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const params: unknown[] = [orgId];
      let where = `r.organization_id = $1`;
      if (status) {
        params.push(status.toUpperCase());
        where += ` AND r.status = $${params.length}`;
      }
      if (memberId) {
        params.push(memberId);
        where += ` AND r.member_id = $${params.length}`;
      }
      const { rows } = await c.query(
        `SELECT r.id, r.account_id, r.member_id, m.member_no,
                m.first_name || ' ' || m.last_name AS member_name,
                r.amount, r.description, r.status, r.source,
                COALESCE(u.email, 'member self-service') AS requested_by,
                r.created_at, r.decided_at, r.decision_notes, r.journal_entry_id
           FROM savings_withdrawal_requests r
           JOIN members m ON m.id = r.member_id
           LEFT JOIN users u ON u.id = r.requested_by_user_id
          WHERE ${where}
          ORDER BY r.created_at DESC LIMIT 200`,
        params,
      );
      return rows.map((r) => ({
        id: r.id as string,
        accountId: r.account_id as string,
        memberId: r.member_id as string,
        memberNo: r.member_no === null ? null : Number(r.member_no),
        memberName: (r.member_name as string | null) ?? null,
        amount: Number(r.amount),
        description: (r.description as string | null) ?? null,
        status: r.status as string,
        source: r.source as string,
        requestedBy: (r.requested_by as string | null) ?? null,
        requestedAt: r.created_at as Date,
        decidedAt: (r.decided_at as Date | null) ?? null,
        decisionNotes: (r.decision_notes as string | null) ?? null,
        journalEntryId: (r.journal_entry_id as string | null) ?? null,
      }));
    });
  }

  /**
   * Advance an engine-linked request, or use the legacy single approver when the
   * cooperative has not activated FR-020 policies. Only a final engine decision
   * posts money. A retry after approval/posting converges on the same journal.
   */
  async approve(
    organizationId: string | null,
    approverUserId: string,
    requestId: string,
  ): Promise<
    | {
        requestId: string;
        approvalStatus: 'PENDING';
        currentStep: number;
        nextApproverRoleCode: string | null;
      }
    | {
        requestId: string;
        approvalStatus: 'APPROVED';
        account: SavingsAccountRow;
        journalEntryId: string | null;
      }
  > {
    const orgId = this.requireOrg(organizationId);
    const pending = await withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT r.id, r.account_id, r.amount, r.description, r.status,
                r.requested_by_user_id, r.journal_entry_id,
                ar.id AS approval_request_id, ar.status AS approval_status
           FROM savings_withdrawal_requests r
           LEFT JOIN LATERAL (
             SELECT id, status FROM approval_requests
              WHERE organization_id = r.organization_id
                AND entity_type = 'savings_withdrawal_request'
                AND entity_id = r.id
              ORDER BY created_at DESC LIMIT 1
           ) ar ON true
          WHERE r.id = $1
          FOR UPDATE OF r`,
        [requestId],
      );
      const r = rows[0] as
        | {
            id: string;
            account_id: string;
            amount: string;
            description: string | null;
            status: string;
            requested_by_user_id: string | null;
            journal_entry_id: string | null;
            approval_request_id: string | null;
            approval_status: string | null;
          }
        | undefined;
      if (!r) throw new NotFoundException('Withdrawal request not found');
      return r;
    });

    // Successful replay or crash recovery after the row was marked approved.
    if (pending.status === 'APPROVED') {
      return {
        requestId,
        approvalStatus: 'APPROVED',
        account: await this.savings.getAccount(orgId, pending.account_id),
        journalEntryId: pending.journal_entry_id,
      };
    }
    if (pending.status !== 'PENDING') {
      throw new ConflictException(`Request is ${pending.status} and can no longer be approved`);
    }

    if (pending.approval_request_id) {
      if (pending.approval_status === 'REJECTED' || pending.approval_status === 'CANCELLED') {
        throw new ConflictException(`Approval request is already ${pending.approval_status}`);
      }
      if (pending.approval_status === 'PENDING') {
        const decision = await this.approvals.decideRequest(
          orgId,
          approverUserId,
          pending.approval_request_id,
          { decision: 'APPROVE' },
        );
        if (decision.status === 'PENDING') {
          return {
            requestId,
            approvalStatus: 'PENDING',
            currentStep: decision.currentStep,
            nextApproverRoleCode: decision.nextApproverRoleCode,
          };
        }
      }
      // APPROVED (whether before this call or by the final decision above) falls
      // through to exactly-once posting below.
    } else if (
      pending.requested_by_user_id &&
      pending.requested_by_user_id === approverUserId
    ) {
      throw new ConflictException(
        'A withdrawal request must be approved by a different user (segregation of duties)',
      );
    }

    const idempotencyKey = `withdrawal-request:${requestId}`;
    let account: SavingsAccountRow;
    try {
      account = await this.savings.withdraw(
        orgId,
        approverUserId,
        pending.account_id,
        pending.amount,
        pending.description ?? 'Approved withdrawal',
        idempotencyKey,
      );
    } catch (error) {
      // If the journal committed but the request-row update did not (process death,
      // timeout), the idempotency unique key refuses a second posting. Verify that
      // exact journal and continue the recovery rather than trapping the request.
      const existing = await withTenant(this.pool, orgId, async (c) =>
        c.query(
          `SELECT id FROM journal_entries
            WHERE organization_id = $1 AND idempotency_key = $2`,
          [orgId, idempotencyKey],
        ),
      );
      if (existing.rowCount !== 1) throw error;
      account = await this.savings.getAccount(orgId, pending.account_id);
    }

    return withTenant(this.pool, orgId, async (c) => {
      const entry = await c.query(
        `SELECT id FROM journal_entries WHERE organization_id = $1 AND idempotency_key = $2`,
        [orgId, idempotencyKey],
      );
      const journalEntryId = (entry.rows[0] as { id: string } | undefined)?.id ?? null;
      await c.query(
        `UPDATE savings_withdrawal_requests
            SET status = 'APPROVED', decided_by_user_id = $2, decided_at = now(),
                journal_entry_id = $3
          WHERE id = $1 AND status = 'PENDING'`,
        [requestId, approverUserId, journalEntryId],
      );
      await c.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1, $2, 'savings.withdrawal.approved', 'savings_withdrawal_request', $3, $4)`,
        [
          orgId,
          approverUserId,
          requestId,
          JSON.stringify({ amount: pending.amount, journalEntryId }),
        ],
      );
      return { requestId, approvalStatus: 'APPROVED' as const, account, journalEntryId };
    });
  }

  async reject(
    organizationId: string | null,
    approverUserId: string,
    requestId: string,
    notes?: string,
  ): Promise<{ requestId: string; status: 'REJECTED' }> {
    const orgId = this.requireOrg(organizationId);
    const found = await withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT r.status, r.requested_by_user_id,
                ar.id AS approval_request_id, ar.status AS approval_status
           FROM savings_withdrawal_requests r
           LEFT JOIN LATERAL (
             SELECT id, status FROM approval_requests
              WHERE organization_id = r.organization_id
                AND entity_type = 'savings_withdrawal_request'
                AND entity_id = r.id
              ORDER BY created_at DESC LIMIT 1
           ) ar ON true
          WHERE r.id = $1
          FOR UPDATE OF r`,
        [requestId],
      );
      return rows[0] as
        | {
            status: string;
            requested_by_user_id: string | null;
            approval_request_id: string | null;
            approval_status: string | null;
          }
        | undefined;
    });
    if (!found) throw new NotFoundException('Withdrawal request not found');
    if (found.status === 'REJECTED') return { requestId, status: 'REJECTED' };
    if (found.status !== 'PENDING') {
      throw new ConflictException(`Request is ${found.status} and can no longer be rejected`);
    }

    if (found.approval_request_id) {
      if (found.approval_status === 'APPROVED') {
        throw new ConflictException('Approval request is already APPROVED');
      }
      if (found.approval_status === 'PENDING') {
        await this.approvals.decideRequest(
          orgId,
          approverUserId,
          found.approval_request_id,
          { decision: 'REJECT', comment: notes },
        );
      }
      // REJECTED means a previous attempt completed the engine decision but died
      // before updating the withdrawal row; continue and converge below.
    } else if (
      found.requested_by_user_id &&
      found.requested_by_user_id === approverUserId
    ) {
      throw new ConflictException(
        'A withdrawal request must be rejected by a different user (segregation of duties)',
      );
    }

    return withTenant(this.pool, orgId, async (c) => {
      await c.query(
        `UPDATE savings_withdrawal_requests
            SET status = 'REJECTED', decided_by_user_id = $2, decided_at = now(), decision_notes = $3
          WHERE id = $1 AND status = 'PENDING'`,
        [requestId, approverUserId, notes?.slice(0, 240) ?? null],
      );
      await c.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1, $2, 'savings.withdrawal.rejected', 'savings_withdrawal_request', $3, $4)`,
        [orgId, approverUserId, requestId, JSON.stringify({ notes: notes ?? null })],
      );
      return { requestId, status: 'REJECTED' as const };
    });
  }
}
