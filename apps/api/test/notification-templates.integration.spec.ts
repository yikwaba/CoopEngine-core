/**
 * Notification templates (real PostgreSQL).
 *
 * Proves a cooperative can word its own SMS/email — and that nothing breaks when
 * it hasn't: absent templates fall back to the built-in catalogue, and a rendered
 * message reaches the notification row that actually gets dispatched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { createPool } from '@coopengine/db';
import { enqueueNotification } from '../src/notifications/enqueue';
import { ADMIN_PASSWORD, ensureRbacSeeded, TEST_DATABASE_URL } from './helpers';

const suffix = Math.random().toString(36).slice(2, 8);
const ADMIN = { email: `tmpl-admin-${suffix}@coopengine.test`, password: 'AdminPass123!' };

describe('notification templates', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let pool: Pool;
  let token = '';
  let orgId = '';
  let memberId = '';

  beforeAll(async () => {
    pool = createPool(TEST_DATABASE_URL);
    await ensureRbacSeeded(pool);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    http = request(app.getHttpServer());

    const slug = `tmpl-${suffix}`;
    const saas = await http
      .post('/api/v1/auth/login')
      .send({ email: 'admin@coopengine.dev', password: ADMIN_PASSWORD })
      .expect(200);
    await http
      .post('/api/v1/organizations')
      .set({ Authorization: `Bearer ${saas.body.tokens.accessToken}` })
      .send({ name: `Template ${suffix}`, slug, adminEmail: ADMIN.email, adminPassword: ADMIN.password })
      .expect(201);

    const login = await http
      .post('/api/v1/auth/login')
      .send({ email: ADMIN.email, password: ADMIN.password, organizationSlug: slug })
      .expect(200);
    token = login.body.tokens.accessToken as string;
    orgId = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).org as string;

    const member = await http
      .post('/api/v1/members')
      .set({ Authorization: `Bearer ${token}` })
      .send({
        firstName: 'Chidi',
        lastName: 'Balogun',
        email: `tmpl-member-${suffix}@coopengine.test`,
        phone: `+23481${String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0')}`,
        joinedOn: '2026-02-01',
      })
      .expect(201);
    memberId = (member.body.id ?? member.body.member?.id) as string;
  });

  afterAll(async () => {
    await app?.close();
    await pool.end();
  });

  it('lists every template with the built-in wording until a cooperative customises it', async () => {
    const res = await http
      .get('/api/v1/notifications/templates')
      .set({ Authorization: `Bearer ${token}` })
      .expect(200);
    expect(res.body).toHaveLength(6);
    const codes = res.body.map((t: { code: string }) => t.code);
    expect(codes).toContain('CONTRIBUTION_DUE');
    expect(codes).toContain('REPAYMENT_RECEIVED');
    expect(res.body.every((t: { isCustomised: boolean }) => t.isCustomised === false)).toBe(true);
    // The built-in wording is available as a reference even after customising.
    const due = res.body.find((t: { code: string }) => t.code === 'CONTRIBUTION_DUE');
    expect(due.defaultBody).toContain('{{amount}}');
    expect(due.variables.memberName).toBeTruthy();
  });

  it('previews the wording with sample values and counts SMS parts', async () => {
    const res = await http
      .post('/api/v1/notifications/templates/CONTRIBUTION_DUE/preview')
      .set({ Authorization: `Bearer ${token}` })
      .send({})
      .expect(201);
    expect(res.body.body).toContain('Ada Okafor');
    expect(res.body.unresolved).toEqual([]);
    expect(res.body.smsParts).toBeGreaterThanOrEqual(1);
  });

  it('saves the cooperative’s own wording and previews the draft', async () => {
    const custom = {
      title: 'Reminder from our cooperative',
      body: 'Hello {{memberName}}, abeg pay your {{frequency}} savings of N{{amount}} before {{dueDate}}. Thank you.',
      channel: 'SMS',
    };
    const saved = await http
      .put('/api/v1/notifications/templates/CONTRIBUTION_DUE')
      .set({ Authorization: `Bearer ${token}` })
      .send(custom)
      .expect(200);
    expect(saved.body.isCustomised).toBe(true);
    expect(saved.body.body).toContain('abeg pay');

    const preview = await http
      .post('/api/v1/notifications/templates/CONTRIBUTION_DUE/preview')
      .set({ Authorization: `Bearer ${token}` })
      .send({ vars: { memberName: 'Ngozi', amount: '2,000.00' } })
      .expect(201);
    expect(preview.body.body).toContain('Ngozi');
    expect(preview.body.body).toContain('2,000.00');
  });

  it('uses the cooperative wording when a notification is actually created', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [orgId]);
      await enqueueNotification(client, {
        organizationId: orgId,
        memberId,
        type: 'CONTRIBUTION_DUE',
        title: 'built-in title (should be replaced)',
        body: 'built-in body (should be replaced)',
        metadata: { amount: 5000, frequency: 'MONTHLY', dueDate: '2026-10-01' },
      });
      const row = await client.query(
        `SELECT title, body FROM notifications
          WHERE member_id = $1 AND type = 'CONTRIBUTION_DUE' ORDER BY created_at DESC LIMIT 1`,
        [memberId],
      );
      expect(row.rows[0].title).toBe('Reminder from our cooperative');
      // Member name resolved from the members table, numbers formatted for reading.
      expect(row.rows[0].body).toContain('Chidi Balogun');
      expect(row.rows[0].body).toContain('5,000.00');
      expect(row.rows[0].body).toContain('MONTHLY');
      expect(row.rows[0].body).not.toContain('{{');
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });

  it('falls back to the built-in wording for types the cooperative has not customised', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [orgId]);
      await enqueueNotification(client, {
        organizationId: orgId,
        memberId,
        type: 'REPAYMENT_RECEIVED',
        title: 'Repayment received',
        body: 'We received your repayment.',
        metadata: { amount: 13833.33, outstanding: 26666.67 },
      });
      const row = await client.query(
        `SELECT title, body FROM notifications
          WHERE member_id = $1 AND type = 'REPAYMENT_RECEIVED' ORDER BY created_at DESC LIMIT 1`,
        [memberId],
      );
      expect(row.rows[0].title).toBe('Repayment received');
      expect(row.rows[0].body).toContain('We received your repayment.');
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });

  it('resets back to the built-in wording', async () => {
    const res = await http
      .delete('/api/v1/notifications/templates/CONTRIBUTION_DUE')
      .set({ Authorization: `Bearer ${token}` })
      .expect(200);
    expect(res.body.isCustomised).toBe(false);
    expect(res.body.body).toBe(res.body.defaultBody);
  });

  it('validates input and keeps wording private to each cooperative', async () => {
    await http
      .put('/api/v1/notifications/templates/NOT_A_REAL_CODE')
      .set({ Authorization: `Bearer ${token}` })
      .send({ title: 'x', body: 'y' })
      .expect(404);

    await http
      .put('/api/v1/notifications/templates/LOAN_APPROVED')
      .set({ Authorization: `Bearer ${token}` })
      .send({ title: '', body: '' })
      .expect(400);

    await http
      .put('/api/v1/notifications/templates/LOAN_APPROVED')
      .set({ Authorization: `Bearer ${token}` })
      .send({ title: 'ok', body: 'x'.repeat(1200) })
      .expect(400);

    // A second cooperative starts from the defaults, not from a neighbour's wording.
    const slug2 = `tmpl2-${suffix}`;
    const admin2 = `tmpl2-admin-${suffix}@coopengine.test`;
    const saas = await http
      .post('/api/v1/auth/login')
      .send({ email: 'admin@coopengine.dev', password: ADMIN_PASSWORD })
      .expect(200);
    await http
      .post('/api/v1/organizations')
      .set({ Authorization: `Bearer ${saas.body.tokens.accessToken}` })
      .send({ name: `Template Two ${suffix}`, slug: slug2, adminEmail: admin2, adminPassword: ADMIN.password })
      .expect(201);
    const login2 = await http
      .post('/api/v1/auth/login')
      .send({ email: admin2, password: ADMIN.password, organizationSlug: slug2 })
      .expect(200);
    const other = await http
      .get('/api/v1/notifications/templates')
      .set({ Authorization: `Bearer ${login2.body.tokens.accessToken}` })
      .expect(200);
    expect(other.body.every((t: { isCustomised: boolean }) => t.isCustomised === false)).toBe(true);
  });
});
