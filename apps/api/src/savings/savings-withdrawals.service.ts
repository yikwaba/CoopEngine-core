import { approvalStepKey, financialIntent } from '../common/financial-intent';
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
  amountDecimal: string;
  description: string | null;
  status: string;
  source: string;
  requestedBy: string | null;
  requestedAt: Date;
  decidedAt: Date | null;
  decisionNotes: string | null;
  journalEntryId: string | null;
  approvalStep: number | null;
  approvalTotalSteps: number | null;
  approvalStatus: string | null;
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
    if ((source === 'MEMBER' && (!memberId || actorUserId)) || (source === 'STAFF' && !actorUserId)) {
      throw new BadRequestException('Withdrawal requester identity is required');
    }
    const value = moneyKobo(amount);
    if (value <= 0n) throw new BadRequestException('Invalid amount');

    return financialIntent<WithdrawalDecision>(this.pool,orgId,'savings.withdrawal.request',idempotencyKey,
      {actorUserId,source,memberId,accountId,amount:moneyDecimal(value),description:description??null},async(c,journalKey)=>{
    const result = await c.query('SELECT withdrawal_approval_threshold FROM organizations WHERE id=$1', [orgId]);
    const raw = result.rows[0]?.withdrawal_approval_threshold as string | null | undefined;
    const threshold = raw == null ? null : moneyKobo(raw);
    // An active stepped policy is authoritative even when the legacy threshold
    // would otherwise permit immediate staff posting. Reuse this same decision
    // when creating the linked request so gaps/overlaps roll back atomically.
    const configured = await c.query(
      `SELECT 1 FROM approval_policies
        WHERE organization_id=$1 AND kind='WITHDRAWAL' AND is_active=true LIMIT 1`,
      [orgId],
    );
    const hasPolicy = configured?.rowCount === 1;
    const needsApproval =
      hasPolicy || source === 'MEMBER' || (threshold !== null && (threshold === 0n || value > threshold));

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

      const account = await this.savings.checkWithdrawalEligibility(c, orgId, accountId, value, memberId);

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
            account.memberId,
            moneyDecimal(value),
            description?.slice(0, 240) ?? null,
            source,
            source === 'STAFF' ? actorUserId : null,
            source === 'MEMBER' ? memberId : null,
          ],
        )
      ).rows[0] as { id: string };

      // Active policies govern both staff and member requests. The authenticated
      // member identity is recorded separately; never substitute a staff user.
      if (hasPolicy) {
        await this.approvals.createRequestInTransaction(c, orgId, actorUserId, {
          kind: 'WITHDRAWAL',
          entityType: 'savings_withdrawal_request',
          entityId: id.id,
          amount: moneyDecimal(value),
          ...(source === 'MEMBER' ? { requesterMemberId: memberId! } : {}),
          summary: description ?? `Savings withdrawal from account ${accountId}`,
          payload: { accountId, memberId: account.memberId, source },
        });
      }

      await c.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1, $2, 'savings.withdrawal.requested', 'savings_withdrawal_request', $3, $4)`,
        [
          orgId,
          actorUserId,
          id.id,
          JSON.stringify({ accountId, amount: moneyDecimal(value), source, requesterMemberId: source === 'MEMBER' ? memberId : null, threshold: threshold === null ? null : moneyDecimal(threshold) }),
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
                r.created_at, r.decided_at, r.decision_notes, r.journal_entry_id, ar.current_step AS approval_step, ar.total_steps AS approval_total_steps, ar.status AS approval_status
           FROM savings_withdrawal_requests r
           JOIN members m ON m.id = r.member_id
           LEFT JOIN users u ON u.id = r.requested_by_user_id
           LEFT JOIN LATERAL (
             SELECT current_step, total_steps, status FROM approval_requests WHERE organization_id=r.organization_id
               AND entity_type='savings_withdrawal_request' AND entity_id=r.id ORDER BY created_at DESC LIMIT 1
           ) ar ON true
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
        amountDecimal: moneyDecimal(moneyKobo(String(r.amount))),
        description: (r.description as string | null) ?? null,
        status: r.status as string,
        source: r.source as string,
        requestedBy: (r.requested_by as string | null) ?? null,
        requestedAt: r.created_at as Date,
        decidedAt: (r.decided_at as Date | null) ?? null,
        decisionNotes: (r.decision_notes as string | null) ?? null,
        journalEntryId: (r.journal_entry_id as string | null) ?? null,
        approvalStep: r.approval_step == null ? null : Number(r.approval_step),
        approvalTotalSteps: r.approval_total_steps == null ? null : Number(r.approval_total_steps),
        approvalStatus: (r.approval_status as string | null) ?? null,
      }));
    });
  }

  /** Approval step, payout, request outcome and both receipts share this transaction. */
  async approve(organizationId: string | null, approverUserId: string, requestId: string, expectedStepNo?: number) {
    return this.decideWithdrawal(organizationId,approverUserId,requestId,'APPROVE',undefined,expectedStepNo);
  }

  async reject(organizationId: string | null, approverUserId: string, requestId: string, notes?: string, expectedStepNo?: number) {
    return this.decideWithdrawal(organizationId,approverUserId,requestId,'REJECT',notes,expectedStepNo);
  }

  private async decideWithdrawal(
    organizationId: string | null, approverUserId: string, requestId: string,
    decision: 'APPROVE'|'REJECT', notes?: string, expectedStepNo?: number,
  ) {
    const orgId=this.requireOrg(organizationId);
    return financialIntent(this.pool,orgId,'withdrawals.decision',approvalStepKey(requestId,approverUserId,expectedStepNo),
      {approverUserId,requestId,decision,notes:notes??null,expectedStepNo:expectedStepNo??null},async c=>{
        const {rows}=await c.query(`SELECT id,account_id,amount,description,status,requested_by_user_id,journal_entry_id
          FROM savings_withdrawal_requests WHERE organization_id=$1 AND id=$2 FOR UPDATE`,[orgId,requestId]);
        const pending=rows[0];
        if (!pending) throw new NotFoundException('Withdrawal request not found');
        if (pending.status!=='PENDING') throw new ConflictException('Withdrawal is already decided; historical outcomes without a receipt require reconciliation');
        if (pending.requested_by_user_id===approverUserId) throw new ConflictException('A withdrawal request must be decided by a different user (segregation of duties)');
        // Refusal rolls back the decision receipt and any approval step. Rejection
        // remains available even when current eligibility no longer permits payout.
        if (decision === 'APPROVE') {
          await this.savings.checkWithdrawalEligibility(c, orgId, pending.account_id, moneyKobo(pending.amount));
        }
        const linked=await c.query(`SELECT id,status,current_step FROM approval_requests
          WHERE organization_id=$1 AND entity_type='savings_withdrawal_request' AND entity_id=$2 ORDER BY created_at DESC LIMIT 1`,[orgId,requestId]);
        const approval=linked.rows[0];
        if (approval) {
          if (expectedStepNo!==undefined && approval.current_step!==expectedStepNo) throw new ConflictException('Approval step has changed; refresh before deciding');
          if (approval.status==='CANCELLED' || (decision==='APPROVE' && approval.status==='REJECTED') || (decision==='REJECT' && approval.status==='APPROVED')) throw new ConflictException(`Approval request is already ${approval.status}`);
          if (approval.status==='PENDING') {
            const result=await this.approvals.decideRequestInTransaction(c,orgId,approverUserId,approval.id,
              {decision,comment:notes,expectedStepNo});
            if (result.status==='PENDING') return {requestId,approvalStatus:'PENDING' as const,currentStep:result.currentStep,nextApproverRoleCode:result.nextApproverRoleCode};
          }
        } else if (expectedStepNo!==undefined) throw new BadRequestException('This withdrawal has no stepped approval chain');
        if (decision==='REJECT') {
          await c.query(`UPDATE savings_withdrawal_requests SET status='REJECTED',decided_by_user_id=$2,decided_at=now(),decision_notes=$3 WHERE id=$1`,[requestId,approverUserId,notes?.slice(0,240)??null]);
          await c.query(`INSERT INTO audit_logs (organization_id,actor_user_id,action,entity_type,entity_id,metadata)
            VALUES ($1,$2,'savings.withdrawal.rejected','savings_withdrawal_request',$3,$4::jsonb)`,[orgId,approverUserId,requestId,JSON.stringify({notes:notes??null})]);
          return {requestId,status:'REJECTED' as const};
        }
        const period=await c.query(`SELECT id FROM ledger_periods WHERE organization_id=$1 AND status='OPEN'
          AND now()::date BETWEEN start_date AND end_date ORDER BY start_date DESC LIMIT 1 FOR SHARE`,[orgId]);
        if (!period.rows[0]) throw new ConflictException('No OPEN accounting period — cannot pay withdrawal');
        const key=`withdrawal-request:${requestId}`;
        const account=await this.savings.withdraw(orgId,approverUserId,pending.account_id,pending.amount,
          pending.description??'Approved withdrawal',key,c);
        const entry=await c.query(`SELECT id FROM journal_entries WHERE organization_id=$1 AND idempotency_key=$2`,[orgId,key]);
        if (!entry.rows[0]) throw new ConflictException('Withdrawal payout has no journal link');
        const journalEntryId=entry.rows[0].id as string;
        await c.query(`UPDATE savings_withdrawal_requests SET status='APPROVED',decided_by_user_id=$2,decided_at=now(),journal_entry_id=$3 WHERE id=$1`,[requestId,approverUserId,journalEntryId]);
        await c.query(`INSERT INTO audit_logs (organization_id,actor_user_id,action,entity_type,entity_id,metadata)
          VALUES ($1,$2,'savings.withdrawal.approved','savings_withdrawal_request',$3,$4::jsonb)`,[orgId,approverUserId,requestId,JSON.stringify({amount:pending.amount,journalEntryId})]);
        return {requestId,approvalStatus:'APPROVED' as const,account,journalEntryId};
      });
  }
}
