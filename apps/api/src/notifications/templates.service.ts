import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { withTenant } from '@coopengine/db';
import { DB_POOL } from '../database/database.module';
import {
  DEFAULT_TEMPLATES,
  TEMPLATE_CODES,
  TEMPLATE_CODE_SET,
  previewTemplate,
  type TemplateCode,
} from './templates';

export interface TemplateView {
  code: TemplateCode;
  description: string;
  defaultChannel: string;
  /** Placeholders the built-in wording uses, with sample values. */
  variables: Record<string, string>;
  /** True when this cooperative has written its own wording. */
  isCustomised: boolean;
  isActive: boolean;
  title: string;
  body: string;
  defaultTitle: string;
  defaultBody: string;
  updatedAt: string | null;
}

const CHANNELS = new Set(['SMS', 'EMAIL', 'ANY']);

@Injectable()
export class NotificationTemplatesService {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async list(organizationId: string): Promise<TemplateView[]> {
    const saved = await withTenant(this.pool, organizationId, async (c) => {
      const res = await c.query(
        `SELECT code, channel, title, body, is_active, updated_at
           FROM notification_templates WHERE organization_id = $1`,
        [organizationId],
      );
      return res.rows as {
        code: string;
        channel: string;
        title: string;
        body: string;
        is_active: boolean;
        updated_at: Date | null;
      }[];
    });

    const byCode = new Map(saved.map((r) => [r.code, r]));
    return TEMPLATE_CODES.map((code) => {
      const def = DEFAULT_TEMPLATES[code];
      const row = byCode.get(code);
      return {
        code,
        description: def.description,
        defaultChannel: def.channel,
        variables: def.variables,
        isCustomised: Boolean(row),
        isActive: row ? row.is_active : true,
        title: row ? row.title : def.title,
        body: row ? row.body : def.body,
        defaultTitle: def.title,
        defaultBody: def.body,
        updatedAt: row?.updated_at ? row.updated_at.toISOString() : null,
      };
    });
  }

  async upsert(
    organizationId: string,
    actorUserId: string,
    code: string,
    dto: { title: string; body: string; channel?: string; isActive?: boolean },
  ): Promise<TemplateView> {
    if (!TEMPLATE_CODE_SET.has(code)) {
      throw new NotFoundException(`Unknown notification template: ${code}`);
    }
    const title = (dto.title ?? '').trim();
    const body = (dto.body ?? '').trim();
    if (!title || !body) {
      throw new BadRequestException('Both a title and a message body are required.');
    }
    if (title.length > 200) throw new BadRequestException('Title must be 200 characters or fewer.');
    if (body.length > 1000) {
      throw new BadRequestException(
        'Message must be 1000 characters or fewer (SMS is limited to 160 per part).',
      );
    }
    const channel = (dto.channel ?? DEFAULT_TEMPLATES[code as TemplateCode].channel).toUpperCase();
    if (!CHANNELS.has(channel)) {
      throw new BadRequestException('channel must be SMS, EMAIL or ANY.');
    }

    await withTenant(this.pool, organizationId, async (c) => {
      await c.query(
        `INSERT INTO notification_templates
           (id, organization_id, code, channel, title, body, is_active, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())
         ON CONFLICT (organization_id, code)
         DO UPDATE SET channel = EXCLUDED.channel,
                       title = EXCLUDED.title,
                       body = EXCLUDED.body,
                       is_active = EXCLUDED.is_active,
                       updated_at = now()`,
        [
          randomUUID(),
          organizationId,
          code,
          channel,
          title,
          body,
          dto.isActive ?? true,
        ],
      );
      await this.audit(c, organizationId, actorUserId, 'notification.template.updated', code, {
        channel,
      });
    });

    const all = await this.list(organizationId);
    return all.find((t) => t.code === code) as TemplateView;
  }

  /** Remove the cooperative's wording and fall back to the built-in text. */
  async reset(organizationId: string, actorUserId: string, code: string): Promise<TemplateView> {
    if (!TEMPLATE_CODE_SET.has(code)) {
      throw new NotFoundException(`Unknown notification template: ${code}`);
    }
    await withTenant(this.pool, organizationId, async (c) => {
      await c.query(
        `DELETE FROM notification_templates WHERE organization_id = $1 AND code = $2`,
        [organizationId, code],
      );
      await this.audit(c, organizationId, actorUserId, 'notification.template.reset', code, {});
    });
    const all = await this.list(organizationId);
    return all.find((t) => t.code === code) as TemplateView;
  }

  /** Render the wording with sample (or supplied) values, for the editor preview. */
  async preview(
    organizationId: string,
    code: string,
    overrides?: Record<string, string>,
    draft?: { title?: string; body?: string },
  ) {
    if (!TEMPLATE_CODE_SET.has(code)) {
      throw new NotFoundException(`Unknown notification template: ${code}`);
    }
    const def = DEFAULT_TEMPLATES[code as TemplateCode];
    const all = await this.list(organizationId);
    const current = all.find((t) => t.code === code);
    const rendered = previewTemplate(
      {
        title: draft?.title ?? current?.title ?? def.title,
        body: draft?.body ?? current?.body ?? def.body,
        variables: def.variables,
      },
      overrides,
    );
    return {
      code,
      title: rendered.title,
      body: rendered.body,
      unresolved: rendered.unresolved,
      sampleVars: rendered.sampleVars,
      smsParts: Math.max(1, Math.ceil(rendered.body.length / 160)),
    };
  }

  private async audit(
    c: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
    organizationId: string,
    actorUserId: string,
    action: string,
    code: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    // entity_id is a uuid column, so the template code travels in metadata.
    await c.query(
      `INSERT INTO audit_logs (id, organization_id, actor_user_id, action, entity_type, metadata)
       VALUES ($1, $2, $3, $4, 'notification_template', $5)`,
      [
        randomUUID(),
        organizationId,
        actorUserId,
        action,
        JSON.stringify({ ...metadata, code }),
      ],
    );
  }
}
