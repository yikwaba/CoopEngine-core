import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { withTenant } from '@coopengine/db';
import { DB_POOL } from '../database/database.module';

export interface NotificationRow {
  id: string;
  memberId: string | null;
  type: string;
  title: string;
  body: string;
  channels: string[];
  status: string;
  sentAt: Date | null;
  readAt: Date | null;
  externalRef: string | null;
  error: string | null;
  createdAt: Date;
}

export interface NotificationList {
  items: NotificationRow[];
  total: number;
  pending: number;
}

/**
 * Notification centre. Records are created transactionally by the business
 * events (loan decisions, repayments, dividends); delivery happens in
 * `dispatchPending`, which uses Termii for SMS when configured and otherwise
 * records the attempt against the dev adapter.
 */
@Injectable()
export class NotificationsService {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  private requireOrg(organizationId: string | null): string {
    if (!organizationId) throw new ConflictException('No organization in context');
    return organizationId;
  }

  private map(r: Record<string, unknown>): NotificationRow {
    return {
      id: r.id as string,
      memberId: (r.member_id as string | null) ?? null,
      type: r.type as string,
      title: r.title as string,
      body: r.body as string,
      channels: (r.channels as string[]) ?? [],
      status: r.status as string,
      sentAt: (r.sent_at as Date | null) ?? null,
      readAt: (r.read_at as Date | null) ?? null,
      externalRef: (r.external_ref as string | null) ?? null,
      error: (r.error as string | null) ?? null,
      createdAt: r.created_at as Date,
    };
  }

  async list(
    organizationId: string | null,
    filters: { status?: string; channel?: string; type?: string; limit?: number; offset?: number } = {},
  ): Promise<NotificationList> {
    const orgId = this.requireOrg(organizationId);
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 500);
    const offset = Math.max(filters.offset ?? 0, 0);
    return withTenant(this.pool, orgId, async (c) => {
      const where: string[] = [];
      const params: unknown[] = [];
      if (filters.status) {
        params.push(filters.status);
        where.push(`status = $${params.length}`);
      }
      if (filters.channel) {
        params.push(filters.channel);
        where.push(`$${params.length} = ANY(channels)`);
      }
      if (filters.type) {
        params.push(filters.type);
        where.push(`type = $${params.length}`);
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = await c.query(`SELECT count(*) AS n FROM notifications ${clause}`, params);
      const pending = await c.query(
        `SELECT count(*) AS n FROM notifications WHERE status = 'PENDING'`,
      );
      const rows = await c.query(
        `SELECT * FROM notifications ${clause}
          ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
        params,
      );
      return {
        items: rows.rows.map((r) => this.map(r as Record<string, unknown>)),
        total: Number((total.rows[0] as { n: string | number }).n),
        pending: Number((pending.rows[0] as { n: string | number }).n),
      };
    });
  }

  async listForMember(
    organizationId: string,
    memberId: string,
    limit = 50,
    offset = 0,
  ): Promise<NotificationList> {
    const take = Math.min(Math.max(limit, 1), 200);
    const skip = Math.max(offset, 0);
    return withTenant(this.pool, organizationId, async (c) => {
      const total = await c.query(
        `SELECT count(*) AS n FROM notifications WHERE member_id = $1`,
        [memberId],
      );
      const rows = await c.query(
        `SELECT * FROM notifications WHERE member_id = $1
          ORDER BY created_at DESC LIMIT ${take} OFFSET ${skip}`,
        [memberId],
      );
      return {
        items: rows.rows.map((r) => this.map(r as Record<string, unknown>)),
        total: Number((total.rows[0] as { n: string | number }).n),
        pending: 0,
      };
    });
  }

  async markRead(
    organizationId: string,
    memberId: string,
    notificationId: string,
  ): Promise<{ id: string; readAt: Date }> {
    return withTenant(this.pool, organizationId, async (c) => {
      const { rows } = await c.query(
        `UPDATE notifications SET read_at = now()
          WHERE id = $1 AND member_id = $2
        RETURNING id, read_at`,
        [notificationId, memberId],
      );
      const r = rows[0] as { id: string; read_at: Date } | undefined;
      if (!r) throw new NotFoundException('Notification not found');
      return { id: r.id, readAt: r.read_at };
    });
  }

  async markAllRead(organizationId: string, memberId: string): Promise<{ updated: number }> {
    return withTenant(this.pool, organizationId, async (c) => {
      const res = await c.query(
        `UPDATE notifications SET read_at = now()
          WHERE member_id = $1 AND read_at IS NULL`,
        [memberId],
      );
      return { updated: res.rowCount ?? 0 };
    });
  }

  /**
   * Deliver pending notifications. SMS goes through Termii when
   * TERMII_API_KEY is configured (the Phase D switch); otherwise every channel
   * is recorded as sent by the dev adapter with a synthetic reference. Email is
   * dev-only until SMTP credentials are wired.
   */
  async dispatchPending(
    organizationId: string | null,
    actorUserId: string | null,
    options: { onlyChannel?: string; limit?: number } = {},
  ): Promise<{ attempted: number; sent: number; failed: number }> {
    const orgId = this.requireOrg(organizationId);
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const rows = await withTenant(this.pool, orgId, async (c) => {
      const { rows: pending } = await c.query(
        `SELECT n.id, n.title, n.body, n.channels, m.phone, m.email
           FROM notifications n
           LEFT JOIN members m ON m.id = n.member_id
          WHERE n.status = 'PENDING'
          ORDER BY n.created_at LIMIT ${limit}`,
      );
      return pending as Record<string, unknown>[];
    });

    let sent = 0;
    let failed = 0;
    for (const row of rows) {
      const channels = (row.channels as string[]) ?? ['IN_APP'];
      const outbound =
        options.onlyChannel && options.onlyChannel !== 'IN_APP'
          ? channels.includes(options.onlyChannel)
          : channels.some((ch) => ch === 'SMS' || ch === 'EMAIL');
      let outcome: { ok: boolean; ref?: string; error?: string };
      if (!outbound) {
        // IN_APP-only records are considered delivered on creation
        outcome = { ok: true, ref: 'in-app' };
      } else if (channels.includes('SMS') && process.env.TERMII_API_KEY) {
        outcome = await this.sendSms(
          (row.phone as string | null) ?? '',
          `${row.title as string}: ${row.body as string}`,
        );
      } else {
        // Dev adapter — records the attempt without contacting a provider
        outcome = { ok: true, ref: `dev:${String(row.id).slice(0, 8)}` };
      }
      await withTenant(this.pool, orgId, async (c) => {
        await c.query(
          `UPDATE notifications
              SET status = $2, sent_at = CASE WHEN $2 = 'SENT' THEN now() ELSE sent_at END,
                  external_ref = $3, error = $4
            WHERE id = $1`,
          [row.id, outcome.ok ? 'SENT' : 'FAILED', outcome.ref ?? null, outcome.error ?? null],
        );
      });
      if (outcome.ok) sent += 1;
      else failed += 1;
    }

    if (actorUserId) {
      await withTenant(this.pool, orgId, async (c) => {
        await c.query(
          `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, metadata)
           VALUES ($1, $2, 'notifications.dispatched', 'notification', $3)`,
          [orgId, actorUserId, JSON.stringify({ attempted: rows.length, sent, failed })],
        );
      });
    }
    return { attempted: rows.length, sent, failed };
  }

  /** Termii SMS delivery (bounded timeout, never throws). */
  private async sendSms(
    to: string,
    text: string,
  ): Promise<{ ok: boolean; ref?: string; error?: string }> {
    if (!to) return { ok: false, error: 'Member has no phone number' };
    const baseUrl = process.env.TERMII_BASE_URL ?? 'https://api.ng.termii.com';
    const channels = process.env.TERMII_CHANNEL ?? 'generic';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(process.env.TERMII_TIMEOUT_MS ?? 8000));
    try {
      const res = await fetch(`${baseUrl}/api/sms/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          to,
          from: process.env.TERMII_SENDER_ID ?? 'CoopEngine',
          sms: text.slice(0, 320),
          type: 'plain',
          channel: channels,
          api_key: process.env.TERMII_API_KEY,
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        return { ok: false, error: `termii HTTP ${res.status}` };
      }
      return { ok: true, ref: String(payload.message_id ?? payload.messageId ?? 'termii') };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'termii request failed' };
    } finally {
      clearTimeout(timeout);
    }
  }
}
