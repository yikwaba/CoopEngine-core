import { randomUUID } from 'node:crypto';

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
      input.title,
      input.body,
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
