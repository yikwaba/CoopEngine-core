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
import { enqueueNotification, outboundChannels } from '../notifications/enqueue';

export interface GoalRow {
  id: string;
  memberId: string;
  name: string;
  targetAmount: number;
  targetDate: string | null;
  startingBalance: number;
  currentBalance: number;
  progress: number;
  percent: number;
  status: string;
  achievedAt: Date | null;
  createdAt: Date;
}

export interface InstructionRow {
  id: string;
  memberId: string;
  amount: number;
  frequency: string;
  nextRunDate: string;
  status: string;
  note: string | null;
  lastRemindedAt: Date | null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** pg returns `date` columns as JS Dates — normalise to YYYY-MM-DD. */
const toIsoDate = (v: unknown): string => {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v ?? '').slice(0, 10);
};

function advance(date: string, frequency: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (frequency === 'WEEKLY') d.setUTCDate(d.getUTCDate() + 7);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Savings goals and standing contribution instructions.
 *
 * Goals track progress from savings actually accumulated since the goal was
 * created and flip to ACHIEVED (with a notification) as soon as the target is
 * met. Instructions are recorded mandates: the nightly sweep queues a
 * contribution reminder and advances the next run date — money movement stays
 * with the member (no silent debits).
 */
@Injectable()
export class GoalsService {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  private requireOrg(organizationId: string | null): string {
    if (!organizationId) throw new ConflictException('No organization in context');
    return organizationId;
  }

  private async savingsTotal(
    c: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
    memberId: string,
  ): Promise<number> {
    const { rows } = await c.query(
      `SELECT coalesce(sum(current_balance), 0) AS total
         FROM member_savings_accounts WHERE member_id = $1 AND status = 'ACTIVE'`,
      [memberId],
    );
    return Number((rows[0] as { total: string | number }).total);
  }

  async listGoals(organizationId: string | null, memberId?: string): Promise<GoalRow[]> {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const params: unknown[] = [];
      let clause = '';
      if (memberId) {
        params.push(memberId);
        clause = `WHERE g.member_id = $1`;
      }
      const { rows } = await c.query(
        `SELECT g.*, (SELECT coalesce(sum(a.current_balance), 0)
                        FROM member_savings_accounts a
                       WHERE a.member_id = g.member_id AND a.status = 'ACTIVE') AS savings_total
           FROM savings_goals g ${clause}
          ORDER BY g.created_at DESC LIMIT 200`,
        params,
      );
      const out: GoalRow[] = [];
      for (const r of rows as Record<string, unknown>[]) {
        const current = Number(r.savings_total);
        const starting = Number(r.starting_balance);
        const target = Number(r.target_amount);
        const progress = round2(Math.max(current - starting, 0));
        let status = r.status as string;
        let achievedAt = (r.achieved_at as Date | null) ?? null;
        if (status === 'ACTIVE' && progress >= target) {
          status = 'ACHIEVED';
          achievedAt = new Date();
          await c.query(`UPDATE savings_goals SET status = 'ACHIEVED', achieved_at = now() WHERE id = $1`, [
            r.id,
          ]);
          await enqueueNotification(c, {
            organizationId: orgId,
            memberId: r.member_id as string,
            type: 'SAVINGS_GOAL_ACHIEVED',
            title: `Goal reached: ${r.name as string}`,
            body: `You have saved ${progress.toFixed(2)} towards your ${target.toFixed(2)} target. Well done!`,
            channels: outboundChannels(),
            metadata: {
              goalId: r.id as string,
              goalName: r.name as string,
              target,
              progress,
            },
          });
        }
        out.push({
          id: r.id as string,
          memberId: r.member_id as string,
          name: r.name as string,
          targetAmount: target,
          targetDate: r.target_date ? toIsoDate(r.target_date) : null,
          startingBalance: starting,
          currentBalance: current,
          progress,
          percent: target > 0 ? Math.min(Math.round((progress / target) * 100), 100) : 0,
          status,
          achievedAt,
          createdAt: r.created_at as Date,
        });
      }
      return out;
    });
  }

  async createGoal(
    organizationId: string | null,
    memberId: string,
    input: { name: string; targetAmount: number; targetDate?: string },
  ): Promise<GoalRow> {
    const orgId = this.requireOrg(organizationId);
    if (!input.name?.trim()) throw new BadRequestException('Goal name is required');
    if (!Number.isFinite(input.targetAmount) || input.targetAmount <= 0) {
      throw new BadRequestException('targetAmount must be greater than zero');
    }
    await withTenant(this.pool, orgId, async (c) => {
      const m = await c.query(`SELECT id FROM members WHERE id = $1`, [memberId]);
      if (!m.rows[0]) throw new NotFoundException('Member not found');
      const starting = await this.savingsTotal(c, memberId);
      await c.query(
        `INSERT INTO savings_goals (organization_id, member_id, name, target_amount, target_date, starting_balance)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          orgId,
          memberId,
          input.name.trim(),
          String(round2(input.targetAmount)),
          input.targetDate ?? null,
          String(starting),
        ],
      );
      await c.query(
        `INSERT INTO audit_logs (organization_id, action, entity_type, metadata)
         VALUES ($1, 'savings.goal.created', 'member', $2)`,
        [orgId, JSON.stringify({ memberId, target: input.targetAmount, name: input.name })],
      );
    });
    const goals = await this.listGoals(orgId, memberId);
    const created = goals[0];
    if (!created) throw new ConflictException('Goal could not be created');
    return created;
  }

  async cancelGoal(organizationId: string | null, goalId: string): Promise<{ id: string; status: string }> {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `UPDATE savings_goals SET status = 'CANCELLED'
          WHERE id = $1 AND status <> 'ACHIEVED' RETURNING id`,
        [goalId],
      );
      const r = rows[0] as { id: string } | undefined;
      if (!r) throw new NotFoundException('Active goal not found');
      return { id: r.id, status: 'CANCELLED' };
    });
  }

  async listInstructions(
    organizationId: string | null,
    memberId?: string,
  ): Promise<InstructionRow[]> {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const params: unknown[] = [];
      let clause = '';
      if (memberId) {
        params.push(memberId);
        clause = `WHERE member_id = $1`;
      }
      const { rows } = await c.query(
        `SELECT * FROM standing_instructions ${clause} ORDER BY next_run_date LIMIT 200`,
        params,
      );
      return rows.map((r) => ({
        id: r.id as string,
        memberId: r.member_id as string,
        amount: Number(r.amount),
        frequency: r.frequency as string,
        nextRunDate: toIsoDate(r.next_run_date),
        status: r.status as string,
        note: (r.note as string | null) ?? null,
        lastRemindedAt: (r.last_reminded_at as Date | null) ?? null,
      }));
    });
  }

  async createInstruction(
    organizationId: string | null,
    memberId: string,
    input: { amount: number; frequency: string; nextRunDate?: string; note?: string },
  ): Promise<InstructionRow> {
    const orgId = this.requireOrg(organizationId);
    if (!Number.isFinite(input.amount) || input.amount <= 0) {
      throw new BadRequestException('amount must be greater than zero');
    }
    if (!['WEEKLY', 'MONTHLY'].includes(input.frequency)) {
      throw new BadRequestException('frequency must be WEEKLY or MONTHLY');
    }
    const today = new Date().toISOString().slice(0, 10);
    const next = input.nextRunDate ?? advance(today, input.frequency);
    const row = await withTenant(this.pool, orgId, async (c) => {
      const m = await c.query(`SELECT id FROM members WHERE id = $1`, [memberId]);
      if (!m.rows[0]) throw new NotFoundException('Member not found');
      const { rows } = await c.query(
        `INSERT INTO standing_instructions
           (organization_id, member_id, amount, frequency, next_run_date, note)
         VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *`,
        [orgId, memberId, String(round2(input.amount)), input.frequency, next, input.note ?? null],
      );
      return rows[0] as Record<string, unknown>;
    });
    return {
      id: row.id as string,
      memberId: row.member_id as string,
      amount: Number(row.amount),
      frequency: row.frequency as string,
      nextRunDate: toIsoDate(row.next_run_date),
      status: row.status as string,
      note: (row.note as string | null) ?? null,
      lastRemindedAt: (row.last_reminded_at as Date | null) ?? null,
    };
  }

  async updateInstruction(
    organizationId: string | null,
    instructionId: string,
    input: { status?: string; amount?: number; frequency?: string; nextRunDate?: string },
  ): Promise<InstructionRow> {
    const orgId = this.requireOrg(organizationId);
    if (input.status && !['ACTIVE', 'PAUSED', 'CANCELLED'].includes(input.status)) {
      throw new BadRequestException('status must be ACTIVE, PAUSED or CANCELLED');
    }
    const row = await withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `UPDATE standing_instructions
            SET status = coalesce($2, status),
                amount = coalesce($3, amount),
                frequency = coalesce($4, frequency),
                next_run_date = coalesce($5::date, next_run_date),
                updated_at = now()
          WHERE id = $1
        RETURNING *`,
        [
          instructionId,
          input.status ?? null,
          input.amount === undefined ? null : String(round2(input.amount)),
          input.frequency ?? null,
          input.nextRunDate ?? null,
        ],
      );
      const r = rows[0] as Record<string, unknown> | undefined;
      if (!r) throw new NotFoundException('Instruction not found');
      return r;
    });
    return {
      id: row.id as string,
      memberId: row.member_id as string,
      amount: Number(row.amount),
      frequency: row.frequency as string,
      nextRunDate: toIsoDate(row.next_run_date),
      status: row.status as string,
      note: (row.note as string | null) ?? null,
      lastRemindedAt: (row.last_reminded_at as Date | null) ?? null,
    };
  }

  /**
   * Nightly sweep: queue a reminder for every ACTIVE instruction that is due
   * and advance its next run date (no money movement).
   */
  async sweepDue(
    organizationId: string | null,
    actorUserId: string | null = null,
  ): Promise<{ reminded: number }> {
    const orgId = this.requireOrg(organizationId);
    const due = await withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT i.id, i.member_id, i.amount, i.frequency, i.next_run_date
           FROM standing_instructions i
          WHERE i.status = 'ACTIVE' AND i.next_run_date <= now()::date
          ORDER BY i.next_run_date LIMIT 500`,
      );
      return rows as Record<string, unknown>[];
    });
    if (due.length === 0) return { reminded: 0 };
    await withTenant(this.pool, orgId, async (c) => {
      for (const i of due) {
        await enqueueNotification(c, {
          organizationId: orgId,
          memberId: i.member_id as string,
          type: 'CONTRIBUTION_DUE',
          title: 'Contribution due',
          body: `Your ${(i.frequency as string).toLowerCase()} contribution of ${Number(i.amount).toFixed(2)} is due. Pay into your collection account to keep your savings on track.`,
          channels: outboundChannels(),
          metadata: {
            instructionId: i.id as string,
            amount: Number(i.amount),
            frequency: i.frequency as string,
            dueDate: String(i.next_run_date ?? ''),
          },
        });
        await c.query(
          `UPDATE standing_instructions
              SET next_run_date = $2, last_reminded_at = now(), updated_at = now()
            WHERE id = $1`,
          [i.id, advance(toIsoDate(i.next_run_date), i.frequency as string)],
        );
      }
      await c.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, metadata)
         VALUES ($1, $2, 'standing.instructions.swept', 'standing_instruction', $3)`,
        [orgId, actorUserId, JSON.stringify({ reminded: due.length })],
      );
    });
    return { reminded: due.length };
  }
}
