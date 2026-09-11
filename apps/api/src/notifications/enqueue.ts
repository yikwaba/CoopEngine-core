import { randomUUID } from 'node:crypto';
import {
  DEFAULT_TEMPLATES,
  TEMPLATE_CODE_SET,
  renderMessage,
} from './templates';

/** Minimal client shape shared by tenant transactions and pools. */
export interface Queryable {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
}

export type NotificationChannel = 'IN_APP' | 'SMS' | 'EMAIL';

export interface EnqueueNotificationInput {
  organizationId: string;
  memberId?: string | null;
  userId?: string | null;
  type: string;
  title: string;
  body: string;
  channels?: NotificationChannel[];
  metadata?: Record<string, unknown>;
}

/**
 * Create a notification inside the caller's transaction, so it commits (or
 * rolls back) with the business event that produced it.
 */
export async function enqueueNotification(
  c: Queryable,
  input: EnqueueNotificationInput,
): Promise<string> {
  const id = randomUUID();
  const channels = input.channels ?? ['IN_APP'];
  const { title, body } = await applyTemplate(c, input);
  await c.query(
    `INSERT INTO notifications
       (id, organization_id, member_id, user_id, type, title, body, channels, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      input.organizationId,
      input.memberId ?? null,
      input.userId ?? null,
      input.type,
      title,
      body,
      channels,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  return id;
}

/** True when at least one outbound channel is configured (else IN_APP only). */
export function outboundChannels(): NotificationChannel[] {
  const channels: NotificationChannel[] = ['IN_APP'];
  if (process.env.TERMII_API_KEY) channels.push('SMS');
  if (process.env.SMTP_HOST) channels.push('EMAIL');
  return channels;
}

/** Render a money/number value the way a cooperative expects to read it. */
function formatValue(value: unknown): unknown {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return value;
}

/**
 * If the cooperative has written its own wording for this notification type, use
 * it, filling {{placeholders}} from the notification's metadata. Otherwise the
 * caller's built-in text stands.
 *
 * Member and organisation names are only looked up when the template actually
 * mentions them, so the common case costs one indexed lookup.
 */
async function applyTemplate(
  c: Queryable,
  input: EnqueueNotificationInput,
): Promise<{ title: string; body: string }> {
  if (!TEMPLATE_CODE_SET.has(input.type)) return { title: input.title, body: input.body };

  let row: { title: string; body: string } | undefined;
  try {
    const res = await c.query(
      `SELECT title, body FROM notification_templates
        WHERE organization_id = $1 AND code = $2 AND is_active = true
        LIMIT 1`,
      [input.organizationId, input.type],
    );
    row = res.rows[0] as { title: string; body: string } | undefined;
  } catch {
    row = undefined; // never let wording break a business event
  }
  if (!row) return { title: input.title, body: input.body };

  const raw = (input.metadata ?? {}) as Record<string, unknown>;
  const vars: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) vars[k] = formatValue(v);

  const needsMember = /\{\{\s*memberName\s*\}\}/.test(row.title + row.body);
  const needsOrg = /\{\{\s*organizationName\s*\}\}/.test(row.title + row.body);
  if (needsMember && input.memberId) {
    const m = await c.query(
      `SELECT first_name, last_name FROM members WHERE id = $1 LIMIT 1`,
      [input.memberId],
    );
    const r = m.rows[0] as { first_name?: string; last_name?: string } | undefined;
    if (r) vars.memberName = [r.first_name, r.last_name].filter(Boolean).join(' ');
  }
  if (needsOrg) {
    const o = await c.query(`SELECT name FROM organizations WHERE id = $1 LIMIT 1`, [
      input.organizationId,
    ]);
    const r = o.rows[0] as { name?: string } | undefined;
    if (r?.name) vars.organizationName = r.name;
  }

  const rendered = renderMessage(row.title, row.body, vars);
  return { title: rendered.title.slice(0, 160), body: rendered.body };
}
