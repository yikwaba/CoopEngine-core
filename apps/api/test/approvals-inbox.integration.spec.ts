/**
 * The approvals inbox: one answer to "what needs my decision?".
 *
 * The rules it must respect:
 *   - it gathers the queues that exist (withdrawals, loans, journals, payroll) into one list;
 *   - it says who raised each item and how long it has waited;
 *   - holding the permission is not enough when you are the person who raised it — the inbox says
 *     so instead of letting an officer discover it by being refused;
 *   - acting on an item delegates to the module that owns the decision, so the rules live in one
 *     place and the item leaves the queue.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { createPool } from '@coopengine/db';
import { ADMIN_PASSWORD, ensureRbacSeeded, TEST_DATABASE_URL } from './helpers';

const suffix = randomUUID().slice(0, 8);
const slug = `appr-${suffix}`;
const ADMIN = `appr-${suffix}@coopengine.test`;
const PASSWORD = 'CoopPass123!';
const scheme = (token: string) => ({ Authorization: ['Bearer', token].join(' ') });

interface ApprovalItem {
  type: string;
  id: string;
  reference: string;
  amount: string | null;
  requestedBy: string | null;
  ageHours: number;
  canAct: boolean;
  blockedReason?: string;
}

describe('approvals inbox', () => {
  let app: INestApplication;
  let pool: Pool;
  let adminToken = '';
  let batchId = '';

  // not async: supertest's Test is thenable AND carries .expect()
  const inbox = (token: string) =>
    request(app.getHttpServer()).get('/api/v1/approvals').set(scheme(token));

  beforeAll(async () => {
    pool = createPool(TEST_DATABASE_URL);
    await ensureRbacSeeded(pool);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    const http = request(app.getHttpServer());

    const saas = await http
      .post('/api/v1/auth/login')
      .send({ email: 'admin@coopengine.dev', password: ADMIN_PASSWORD })
      .expect(200);
    await http
      .post('/api/v1/organizations')
      .set(scheme(saas.body.tokens.accessToken))
      .send({ name: `Approvals ${suffix}`, slug, adminEmail: ADMIN, adminPassword: PASSWORD })
      .expect(201);

    const login = await http
      .post('/api/v1/auth/login')
      .send({ email: ADMIN, password: PASSWORD, organizationSlug: slug })
      .expect(200);
    adminToken = login.body.tokens.accessToken as string;

    const member = await http
      .post('/api/v1/members')
      .set(scheme(adminToken))
      .send({ firstName: 'Batch', lastName: `Member${suffix}` })
      .expect(201);
    await http
      .post(`/api/v1/members/${member.body.id}/approve`)
      .set(scheme(adminToken))
      .send({})
      .expect(200);

    const csv = [
      'memberNo,amount',
      `${member.body.memberNo},12000`,
    ].join('\n');
    const preview = await http
      .post('/api/v1/payroll/import/preview')
      .set(scheme(adminToken))
      .send({ filename: 'approvals.csv', csv })
      .expect(201);
    batchId = preview.body.batchId as string;
    await http
      .post('/api/v1/payroll/import/commit')
      .set(scheme(adminToken))
      .send({ batchId })
      .expect(200);
  });

  afterAll(async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.internal_scan', 'on', true)`);
      const { rows } = await client.query(`SELECT id FROM organizations WHERE slug = $1`, [slug]);
      await client.query('COMMIT');
      const orgId = (rows[0] as { id: string } | undefined)?.id;
      if (orgId) {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [orgId]);
        await client.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
        await client.query('COMMIT');
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.internal_scan', 'on', true)`);
        await client.query(`DELETE FROM org_lookups WHERE slug = $1`, [slug]);
        await client.query('COMMIT');
      }
    } finally {
      client.release();
    }
    await pool.query(
      `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@coopengine.test')`,
    );
    await pool.query(`DELETE FROM users WHERE email LIKE '%@coopengine.test'`);
    await app?.close();
    await pool.end();
  });

  it('shows the waiting payroll batch, and blocks the person who raised it', async () => {
    const res = await inbox(adminToken).expect(200);
    const item = (res.body.items as ApprovalItem[]).find((i) => i.id === batchId);
    expect(item, JSON.stringify(res.body.items)).toBeDefined();
    expect(item?.type).toBe('PAYROLL');
    expect(Number(item?.amount)).toBe(12000);
    expect(item?.requestedBy).toBe(ADMIN);
    expect(item?.ageHours).toBeGreaterThanOrEqual(0);
    expect(res.body.counts.PAYROLL).toBeGreaterThanOrEqual(1);
    // the admin submitted it, so the inbox says so rather than letting them be refused
    expect(item?.canAct).toBe(false);
    expect(String(item?.blockedReason)).toMatch(/someone else/i);
  });

  it('a different officer sees it as actionable, and approving it clears the queue', async () => {
    const http = request(app.getHttpServer());
    const invited = await http
      .post('/api/v1/users')
      .set(scheme(adminToken))
      .send({ email: `approver-${suffix}@coopengine.test`, roleCodes: ['COOP_ADMIN'] })
      .expect(201);
    const approver = await http
      .post('/api/v1/auth/login')
      .send({ email: invited.body.email, password: invited.body.tempPassword, organizationSlug: slug })
      .expect(200);
    const approverToken = approver.body.tokens.accessToken as string;

    const before = await inbox(approverToken).expect(200);
    const item = (before.body.items as ApprovalItem[]).find((i) => i.id === batchId);
    expect(item?.canAct, JSON.stringify(before.body.items)).toBe(true);
    expect(item?.blockedReason).toBeUndefined();

    await http
      .post(`/api/v1/approvals/payroll/${batchId}/approve`)
      .set(scheme(approverToken))
      .expect(200);

    const after = await inbox(approverToken).expect(200);
    expect((after.body.items as ApprovalItem[]).some((i) => i.id === batchId)).toBe(false);
  });
});
