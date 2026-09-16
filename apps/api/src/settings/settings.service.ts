import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { withTenant } from '@coopengine/db';
import { DB_POOL } from '../database/database.module';
import { UpdateSettingsDto } from './dto/update-settings.dto';

@Injectable()
export class SettingsService {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async get(organizationId: string) {
    return withTenant(this.pool, organizationId, async (client) => {
      const { rows } = await client.query(
        `SELECT organization_id, currency, timezone, settings, updated_at
           FROM organization_settings WHERE organization_id = $1`,
        [organizationId],
      );
      const row = rows[0] as Record<string, unknown> | undefined;
      if (!row) throw new NotFoundException('Settings not found for this cooperative');
      return {
        currency: row.currency,
        timezone: row.timezone,
        settings: row.settings ?? {},
        updatedAt: row.updated_at,
      };
    });
  }

  /** Merge, never replace: a partial update must not silently drop other switches. */
  async update(organizationId: string, userId: string, dto: UpdateSettingsDto) {
    return withTenant(this.pool, organizationId, async (client) => {
      const { rows } = await client.query(
        `SELECT currency, timezone, settings FROM organization_settings WHERE organization_id = $1`,
        [organizationId],
      );
      const current = rows[0] as
        | { currency: string; timezone: string; settings: Record<string, unknown> }
        | undefined;
      if (!current) throw new NotFoundException('Settings not found for this cooperative');

      const settings = { ...(current.settings ?? {}) } as Record<string, unknown>;
      if (dto.security) {
        const existing = (settings.security ?? {}) as Record<string, unknown>;
        settings.security = { ...existing, ...dto.security };
      }

      const { rows: updated } = await client.query(
        `UPDATE organization_settings
            SET currency = coalesce($2, currency),
                timezone = coalesce($3, timezone),
                settings = $4::jsonb,
                updated_at = now()
          WHERE organization_id = $1
          RETURNING currency, timezone, settings, updated_at`,
        [organizationId, dto.currency ?? null, dto.timezone ?? null, JSON.stringify(settings)],
      );

      await client.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1, $2, 'settings.updated', 'organization', $1, $3)`,
        [organizationId, userId, JSON.stringify({ changed: dto })],
      );

      const row = updated[0] as Record<string, unknown>;
      return {
        currency: row.currency,
        timezone: row.timezone,
        settings: row.settings ?? {},
        updatedAt: row.updated_at,
      };
    });
  }
}
