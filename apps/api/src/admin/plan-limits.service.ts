import { ConflictException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { withTenant } from '@coopengine/db';
import { DB_POOL } from '../database/database.module';

interface PlanRow {
  id: string;
  code: string;
  name: string;
  limits: Record<string, number | null>;
  features: Record<string, boolean>;
  status: string;
}

/**
 * What a cooperative's subscription entitles it to.
 *
 * A cooperative with no subscription is unmetered — the platform does not invent limits for
 * tenants that were never sold a plan, and existing cooperatives must not be constrained by
 * this arriving later.
 */
@Injectable()
export class PlanLimitsService {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  /** Reads across tenants on purpose: this is platform-policy resolution, not tenant data. */
  private async currentPlan(organizationId: string): Promise<PlanRow | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.internal_scan', 'on', true)`);
      const { rows } = await client.query(
        `SELECT pl.id, pl.code, pl.name, pl.limits, pl.features, s.status
           FROM subscriptions s
           JOIN plans pl ON pl.id = s.plan_id
          WHERE s.organization_id = $1 AND s.status <> 'CANCELLED'
          ORDER BY s.created_at DESC
          LIMIT 1`,
        [organizationId],
      );
      await client.query('COMMIT');
      return (rows[0] as PlanRow | undefined) ?? null;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async planFor(organizationId: string): Promise<PlanRow | null> {
    return this.currentPlan(organizationId);
  }

  /** Refuse a member addition that would take the cooperative past its plan. */
  async assertCanAddMembers(organizationId: string | null, additional = 1): Promise<void> {
    if (!organizationId) return;
    const plan = await this.currentPlan(organizationId);
    const limit = plan?.limits?.maxMembers ?? null;
    if (limit === null || limit === undefined) return;

    const { rows } = await withTenant(this.pool, organizationId, (client) =>
      client.query(`SELECT count(*)::int AS n FROM members WHERE status <> 'EXITED'`),
    );
    const current = (rows[0] as { n: number }).n;
    if (current + additional > limit) {
      throw new ConflictException(
        `This cooperative's ${plan?.name} plan covers ${limit} members and it already has ${current}. ` +
          `Move it to a larger plan to add ${additional > 1 ? `${additional} more` : 'another member'}.`,
      );
    }
  }

  /** Refuse an action whose module the cooperative's plan does not include. */
  async assertFeature(organizationId: string | null, feature: string): Promise<void> {
    if (!organizationId) return;
    const plan = await this.currentPlan(organizationId);
    if (!plan) return;
    if (plan.features?.[feature] === false) {
      throw new ForbiddenException(
        `The ${plan.name} plan does not include ${feature}. Move the cooperative to a plan that does.`,
      );
    }
  }
}
