import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Pool } from 'pg';
import { withTenant } from '@coopengine/db';
import { DEFAULT_CHART_OF_ACCOUNTS, monthPeriod } from '@coopengine/shared';
import * as bcrypt from 'bcryptjs';
import { DB_POOL } from '../database/database.module';
import { CreateOrganizationDto } from './dto/create-organization.dto';

export interface OnboardedOrganization {
  id: string;
  name: string;
  slug: string;
  status: string;
  adminEmail: string;
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === '23505'
  );
}

@Injectable()
export class OrganizationsService {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  /**
   * Onboard a cooperative workspace (FR-001):
   * org + settings + HQ branch + cooperative admin user (COOP_ADMIN template).
   *
   * Tenant content is created inside the new org's own RLS transaction:
   * the org id is generated client-side so the tenant GUC can be set to it
   * before the first insert (RLS bootstrap pattern).
   */
  async onboard(dto: CreateOrganizationDto): Promise<OnboardedOrganization> {
    const orgId = randomUUID();
    try {
      await withTenant(this.pool, orgId, async (c) => {
        await c.query(
          `INSERT INTO organizations (id, name, slug, status)
           VALUES ($1, $2, $3, 'ACTIVE')`,
          [orgId, dto.name, dto.slug],
        );
        await c.query(
          `INSERT INTO organization_settings (organization_id) VALUES ($1)`,
          [orgId],
        );
        await c.query(
          `INSERT INTO org_counters (organization_id) VALUES ($1)`,
          [orgId],
        );
        await c.query(
          `INSERT INTO branches (organization_id, name, code, is_headquarters)
           VALUES ($1, $2, $3, true)`,
          [orgId, `${dto.name} Head Office`, 'HQ'],
        );
        // Baseline chart of accounts
        for (const account of DEFAULT_CHART_OF_ACCOUNTS) {
          await c.query(
            `INSERT INTO chart_of_accounts (id, organization_id, code, name, type, category, is_system)
             VALUES ($1, $2, $3, $4, $5, $6, true)`,
            [
              randomUUID(),
              orgId,
              account.code,
              account.name,
              account.type,
              account.category,
            ],
          );
        }
        // Default savings product (rate configured later by the coop)
        await c.query(
          `INSERT INTO savings_products (organization_id, code, name, interest_rate_pa, min_deposit, allow_withdrawal)
           VALUES ($1, 'REGULAR-SAVINGS', 'Regular Savings', 0, 0, true)
           ON CONFLICT (organization_id, code) DO NOTHING`,
          [orgId],
        );
        // Default loan products per Decision Log v1.1 (3x / 15% / 12.5%)
        await c.query(
          `INSERT INTO loan_products (organization_id, code, name, interest_rate_pa, interest_method, multiplier)
           VALUES ($1, 'CASH-LOAN', 'Cash Loan', 15, 'FLAT', 3),
                  ($1, 'ASSET-FINANCE', 'Asset Finance', 12.5, 'FLAT', 3)
           ON CONFLICT (organization_id, code) DO NOTHING`,
          [orgId],
        );
        // Open the current month's accounting period
        const now = new Date();
        const period = monthPeriod(
          now.getUTCFullYear(),
          now.getUTCMonth() + 1,
        );
        await c.query(
          `INSERT INTO ledger_periods (organization_id, code, start_date, end_date, status)
           VALUES ($1, $2, $3, $4, 'OPEN')
           ON CONFLICT (organization_id, code) DO NOTHING`,
          [orgId, period.code, period.startDate, period.endDate],
        );
      });

      // Admin user + COOP_ADMIN role assignment (identity tables, no RLS).
      const adminUserId = await this.upsertAdminUser(dto.adminEmail, dto.adminPassword);
      const role = await this.roleTemplateId('COOP_ADMIN');
      await this.pool.query(
        `INSERT INTO user_roles (user_id, organization_id, role_id)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [adminUserId, orgId, role],
      );

      await this.pool.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1, $2, 'tenant.onboarded', 'organization', $1, $3)`,
        [
          orgId,
          adminUserId,
          JSON.stringify({ slug: dto.slug, name: dto.name }),
        ],
      );

      return { id: orgId, name: dto.name, slug: dto.slug, status: 'ACTIVE', adminEmail: dto.adminEmail };
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('Organization slug already exists');
      }
      throw error;
    }
  }

  private async roleTemplateId(code: string): Promise<string> {
    const { rows } = await this.pool.query(
      `SELECT id FROM roles WHERE code = $1 AND organization_id IS NULL AND scope = 'org'`,
      [code],
    );
    const role = rows[0] as { id: string } | undefined;
    if (!role) throw new Error(`Role template missing: ${code} (run db:seed)`);
    return role.id;
  }

  private async upsertAdminUser(
    email: string,
    password: string,
  ): Promise<string> {
    const normalized = email.toLowerCase();
    const { rows } = await this.pool.query(
      `SELECT id FROM users WHERE email = $1`,
      [normalized],
    );
    if (rows[0]) return (rows[0] as { id: string }).id;
    const hash = await bcrypt.hash(password, 12);
    const inserted = await this.pool.query(
      `INSERT INTO users (email, password_hash, status)
       VALUES ($1, $2, 'ACTIVE')
       RETURNING id`,
      [normalized, hash],
    );
    return (inserted.rows[0] as { id: string }).id;
  }
}
