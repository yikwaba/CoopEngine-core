import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { withTenant } from '@coopengine/db';
import { DB_POOL } from '../database/database.module';
import { AssignSubscriptionDto } from './dto/subscription.dto';
import { UpdateTenantDto } from './dto/update-tenant.dto';
import { PlansService } from './plans.service';

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  legal_name: string | null;
  status: string;
  created_at: Date;
}

@Injectable()
export class AdminService {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    private readonly plans: PlansService,
  ) {}

  /**
   * Cross-tenant reads run under the narrow `internal_scan` select policy — the same one the
   * nightly sweeps use — never by widening a tenant policy. Writes always go through tenant
   * scope instead.
   */
  private async withScan<T>(runner: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.internal_scan', 'on', true)`);
      const result = await runner(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async organizations(where = '', values: unknown[] = []): Promise<OrgRow[]> {
    return this.withScan(async (client) => {
      const { rows } = await client.query(
        `SELECT id, name, slug, legal_name, status, created_at
           FROM organizations ${where} ORDER BY created_at DESC`,
        values,
      );
      return rows as OrgRow[];
    });
  }

  /** One round trip per cooperative: the counts are tenant data, so they need tenant scope. */
  private async stats(organizationId: string) {
    const { rows } = await withTenant(this.pool, organizationId, (client) =>
      client.query(
        `SELECT
           (SELECT count(*)::int FROM members WHERE status <> 'EXITED') AS members,
           (SELECT count(*)::int FROM member_savings_accounts WHERE status = 'ACTIVE') AS savings_accounts,
           (SELECT coalesce(sum(current_balance), 0)::text FROM member_savings_accounts) AS savings_balance,
           (SELECT count(*)::int FROM loans WHERE status IN ('DISBURSED','DEFAULTED')) AS active_loans,
           (SELECT coalesce(sum(outstanding_principal), 0)::text FROM loans
             WHERE status IN ('DISBURSED','DEFAULTED')) AS loans_outstanding,
           (SELECT count(*)::int FROM user_roles WHERE organization_id = $1) AS staff`,
        [organizationId],
      ),
    );
    const row = rows[0] as Record<string, unknown>;
    return {
      members: Number(row.members),
      savingsAccounts: Number(row.savings_accounts),
      savingsBalance: String(row.savings_balance),
      activeLoans: Number(row.active_loans),
      loansOutstanding: String(row.loans_outstanding),
      staff: Number(row.staff),
    };
  }

  private async liveSubscriptions(orgIds: string[]) {
    if (orgIds.length === 0) return new Map<string, Record<string, unknown>>();
    return this.withScan(async (client) => {
      const { rows } = await client.query(
        `SELECT s.organization_id, s.status, s.started_at, s.renews_at,
                pl.code AS plan_code, pl.name AS plan_name, pl.price_amount, pl.currency, pl.limits, pl.features
           FROM subscriptions s
           JOIN plans pl ON pl.id = s.plan_id
          WHERE s.organization_id = ANY($1::uuid[]) AND s.status <> 'CANCELLED'`,
        [orgIds],
      );
      return new Map(
        (rows as Record<string, unknown>[]).map((r) => [r.organization_id as string, r]),
      );
    });
  }

  async listTenants(options: { limit: number; offset: number; q?: string }) {
    const where = options.q ? `WHERE name ILIKE $1 OR slug ILIKE $1` : '';
    const values = options.q ? [`%${options.q}%`] : [];
    const all = await this.organizations(where, values);
    const page = all.slice(options.offset, options.offset + options.limit);
    const subs = await this.liveSubscriptions(page.map((o) => o.id));

    const rows = [];
    for (const org of page) {
      const sub = subs.get(org.id);
      rows.push({
        id: org.id,
        name: org.name,
        slug: org.slug,
        legalName: org.legal_name,
        status: org.status,
        createdAt: org.created_at,
        ...(await this.stats(org.id)),
        plan: sub ? { code: sub.plan_code, name: sub.plan_name } : null,
        subscriptionStatus: sub ? sub.status : null,
        renewsAt: sub ? sub.renews_at : null,
      });
    }
    return { total: all.length, limit: options.limit, offset: options.offset, rows };
  }

  async tenant(organizationId: string) {
    const orgs = await this.organizations(`WHERE id = $1`, [organizationId]);
    const org = orgs[0];
    if (!org) throw new NotFoundException('Cooperative not found');

    const settings = await withTenant(this.pool, organizationId, (client) =>
      client.query(
        `SELECT currency, timezone, settings FROM organization_settings WHERE organization_id = $1`,
        [organizationId],
      ),
    );

    const subs = await this.liveSubscriptions([organizationId]);
    const sub = subs.get(organizationId);

    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      legalName: org.legal_name,
      status: org.status,
      createdAt: org.created_at,
      ...(await this.stats(organizationId)),
      settings: (settings.rows[0] as Record<string, unknown>) ?? null,
      plan: sub
        ? {
            code: sub.plan_code,
            name: sub.plan_name,
            priceAmount: sub.price_amount,
            limits: sub.limits,
            features: sub.features,
          }
        : null,
      subscription: sub ? { status: sub.status, startedAt: sub.started_at, renewsAt: sub.renews_at } : null,
    };
  }

  async updateTenant(organizationId: string, dto: UpdateTenantDto, actorUserId: string) {
    const orgs = await this.organizations(`WHERE id = $1`, [organizationId]);
    if (!orgs[0]) throw new NotFoundException('Cooperative not found');
    if (!dto.status && !dto.legalName) {
      throw new BadRequestException('Nothing to update: pass status or legalName');
    }

    await withTenant(this.pool, organizationId, async (client) => {
      await client.query(
        `UPDATE organizations
            SET status = coalesce($2, status),
                legal_name = coalesce($3, legal_name),
                updated_at = now()
          WHERE id = $1`,
        [organizationId, dto.status ?? null, dto.legalName ?? null],
      );
      await client.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1, $2, 'tenant.updated', 'organization', $1, $3)`,
        [organizationId, actorUserId, JSON.stringify(dto)],
      );
    });

    return this.tenant(organizationId);
  }

  async subscriptionHistory(organizationId: string) {
    return this.withScan(async (client) => {
      const { rows } = await client.query(
        `SELECT s.id, s.status, s.started_at, s.renews_at, s.ended_at, s.notes, s.created_at,
                pl.code AS plan_code, pl.name AS plan_name, pl.price_amount, pl.currency, pl.limits, pl.features
           FROM subscriptions s JOIN plans pl ON pl.id = s.plan_id
          WHERE s.organization_id = $1
          ORDER BY s.created_at DESC`,
        [organizationId],
      );
      return rows;
    });
  }

  /** Assign or change a cooperative's plan: one live subscription, history preserved. */
  async assignSubscription(organizationId: string, dto: AssignSubscriptionDto, actorUserId: string) {
    const orgs = await this.organizations(`WHERE id = $1`, [organizationId]);
    if (!orgs[0]) throw new NotFoundException('Cooperative not found');

    const planId = dto.planId ?? (dto.planCode ? await this.planIdForCode(dto.planCode) : undefined);
    if (!planId) throw new BadRequestException('Pass planCode or planId');

    const result = await withTenant(this.pool, organizationId, async (client) => {
      const existing = await client.query(
        `SELECT id FROM subscriptions WHERE organization_id = $1 AND status <> 'CANCELLED' LIMIT 1`,
        [organizationId],
      );
      const status = dto.status ?? 'ACTIVE';
      const renewsAt = dto.renewsAt ?? null;

      const saved = existing.rows[0]
        ? await client.query(
            `UPDATE subscriptions
                SET plan_id = $2, status = $3, renews_at = coalesce($4, renews_at),
                    notes = coalesce($5, notes), ended_at = NULL, updated_at = now()
              WHERE id = $1
              RETURNING id, status, renews_at`,
            [existing.rows[0].id, planId, status, renewsAt, dto.notes ?? null],
          )
        : await client.query(
            `INSERT INTO subscriptions (organization_id, plan_id, status, renews_at, notes)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, status, renews_at`,
            [organizationId, planId, status, renewsAt, dto.notes ?? null],
          );

      await client.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1, $2, 'subscription.assigned', 'subscription', $3, $4)`,
        [organizationId, actorUserId, saved.rows[0].id, JSON.stringify({ planId, status, renewsAt })],
      );
      return saved.rows[0];
    });

    return { ...result, plan: await this.plans.list().then((p) => p.find((x) => x.id === planId)) };
  }

  private async planIdForCode(code: string): Promise<string | undefined> {
    const { rows } = await this.pool.query(`SELECT id FROM plans WHERE code = $1`, [code.toUpperCase()]);
    return (rows[0] as { id: string } | undefined)?.id;
  }

  /** Platform summary for the console's landing page. */
  async overview() {
    const orgs = await this.organizations();
    const subs = await this.withScan(async (client) => {
      const { rows } = await client.query(
        `SELECT status, count(*)::int AS n FROM subscriptions GROUP BY status`,
      );
      return rows as { status: string; n: number }[];
    });
    const plans = await this.plans.list();

    let members = 0;
    let savingsBalance = 0;
    let loansOutstanding = 0;
    for (const org of orgs) {
      const s = await this.stats(org.id);
      members += s.members;
      savingsBalance += Number(s.savingsBalance);
      loansOutstanding += Number(s.loansOutstanding);
    }

    const byStatus = (status: string) => subs.find((s) => s.status === status)?.n ?? 0;
    return {
      cooperatives: {
        total: orgs.length,
        active: orgs.filter((o) => o.status === 'ACTIVE').length,
        suspended: orgs.filter((o) => o.status === 'SUSPENDED').length,
        pending: orgs.filter((o) => o.status === 'PENDING').length,
      },
      members,
      savingsBalance: savingsBalance.toFixed(2),
      loansOutstanding: loansOutstanding.toFixed(2),
      subscriptions: {
        active: byStatus('ACTIVE') + byStatus('TRIAL'),
        trial: byStatus('TRIAL'),
        pastDue: byStatus('PAST_DUE'),
        unassigned: orgs.length - subs.reduce((sum, s) => sum + s.n, 0),
      },
      plans: plans.length,
    };
  }
}
