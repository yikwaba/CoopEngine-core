import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import * as bcrypt from 'bcryptjs';
import { DB_POOL } from '../database/database.module';
import { PasswordResetMailer } from './password-reset-mailer';

export const RESET_RESPONSE = { message: 'If this email belongs to an active staff account, a password reset link will be sent.' };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

@Injectable()
export class PasswordResetService {
  constructor(@Inject(DB_POOL) private readonly pool: Pool, private readonly mailer: PasswordResetMailer) {}

  async request(email: string, ip: string): Promise<typeof RESET_RESPONSE> {
    const started = Date.now();
    const normalized = email.trim().toLowerCase();
    const emailHash = digest(normalized);
    const ipHash = digest(ip);
    let tokenHash: string | undefined;
    try {
      const client = await this.pool.connect();
      let recipient: string | undefined;
      const token = randomBytes(32).toString('hex');
      tokenHash = digest(token);
      try {
        await client.query('BEGIN');
        // Serialize both rate buckets across API instances. Identity is global,
        // just like users/sessions; no caller-supplied tenant is trusted here.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`reset-ip:${ipHash}`]);
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`reset-email:${emailHash}`]);
        const counts = await client.query(`SELECT count(*) FILTER (WHERE email_hash=$1)::int AS email_count,
          count(*) FILTER (WHERE ip_hash=$2)::int AS ip_count FROM password_reset_requests
          WHERE requested_at > now() - interval '15 minutes' AND (email_hash=$1 OR ip_hash=$2)`, [emailHash, ipHash]);
        if (counts.rows[0].email_count < 5 && counts.rows[0].ip_count < 20) {
          await client.query('INSERT INTO password_reset_requests (email_hash, ip_hash) VALUES ($1,$2)', [emailHash, ipHash]);
          const user = await client.query("SELECT id,email FROM users WHERE email=$1 AND status='ACTIVE' AND password_hash IS NOT NULL FOR UPDATE", [normalized]);
          if (user.rows[0]) {
            recipient = user.rows[0].email;
            await client.query(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
              VALUES ($1,$2,now() + interval '15 minutes')`, [user.rows[0].id, tokenHash]);
          }
        }
        // Retain only recent attempt buckets; old/reset secrets need no archive.
        await client.query("DELETE FROM password_reset_requests WHERE requested_at < now() - interval '1 day'");
        await client.query("DELETE FROM password_reset_tokens WHERE expires_at < now() - interval '1 day'");
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
      if (recipient) {
        try { await this.mailer.send(recipient, token); }
        catch {
          await this.pool.query('DELETE FROM password_reset_tokens WHERE token_hash=$1', [tokenHash]);
          // No recipient, token, password or SMTP credentials in operational logs.
          console.error('Staff password recovery delivery failed');
        }
      }
      return RESET_RESPONSE;
    } finally {
      // Mail has a hard 2.5s deadline; normal eligible/unknown/throttled replies
      // have the same 3s response floor. DB outages are not hidden as success.
      if (process.env.NODE_ENV !== 'test') {
        await new Promise(resolve => setTimeout(resolve, Math.max(0, 3000 - (Date.now() - started))));
      }
    }
  }

  async reset(token: string, password: string): Promise<void> {
    // bcrypt truncates at 72 bytes, so enforce bytes in addition to DTO length.
    if (Buffer.byteLength(password, 'utf8') > 72) throw new BadRequestException('Password must be at most 72 UTF-8 bytes');
    const tokenHash = digest(token);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Lock the global user first: simultaneous reset links serialize without
      // deadlocking each other, and successful reset invalidates sibling links.
      const user = await client.query(`SELECT u.id FROM users u JOIN password_reset_tokens t ON t.user_id=u.id
        WHERE t.token_hash=$1 AND u.status='ACTIVE' FOR UPDATE OF u`, [tokenHash]);
      if (!user.rows[0]) throw new BadRequestException('Reset link is invalid or expired');
      const consumed = await client.query(`UPDATE password_reset_tokens SET consumed_at=now()
        WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>now() RETURNING user_id`, [tokenHash]);
      if (!consumed.rows[0]) throw new BadRequestException('Reset link is invalid or expired');
      const id = user.rows[0].id;
      const passwordHash = await bcrypt.hash(password, 12);
      await client.query('UPDATE users SET password_hash=$1,auth_version=auth_version+1,updated_at=now() WHERE id=$2', [passwordHash, id]);
      await client.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [id]);
      await client.query('UPDATE password_reset_tokens SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL', [id]);
      await client.query(`INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,metadata)
        VALUES ($1,'auth.password.reset','user',$1,'{}'::jsonb)`, [id]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
}
