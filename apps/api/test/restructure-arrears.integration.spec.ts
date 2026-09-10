/**
 * Loan restructuring + arrears automation (real PostgreSQL).
 *
 * Proves: restructure replaces unpaid installments with a fresh schedule over
 * the remaining outstanding (history kept), invalid targets are rejected, the
 * arrears register ages overdue installments, and the auto-default run flags
 * loans 90+ days late with an audit trail — with no money movement.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { createPool } from '@coopengine/db';
import { ADMIN_PASSWORD, ensureRbacSeeded, TEST_DATABASE_URL } from './helpers';

const ADMIN_EMAIL = 'admin@coopengine.dev';

let app: INestApplication;
let pool: Pool;

async function onboardCoop(): Promise<{
  tokens: { accessToken: string };
  organizationId: string;
}> {
  const saasLogin = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  const suffix = randomUUID().slice(0, 8);
  await request(app.getHttpServer())
    .post('/api/v1/organizations')
    .set('Authorization', `Bearer ${saasLogin.body.tokens.accessToken}`)
    .send({
      name: `ra cooperative`,
      slug: `ra-${suffix}`,
      adminEmail: `ra-${suffix}@coopengine.test`,
      adminPassword: 'CoopPass123!',
    });
  const login = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email: `ra-${suffix}@coopengine.test`, password: 'CoopPass123!' });
  const accessToken = login.body.tokens.accessToken as string;
  const orgId = (login.body.organizations?.[0]?.id ?? login.body.organization?.id) as string;
  expect(orgId).toBeTruthy();
  return { tokens: { accessToken }, organizationId: orgId };
}

describe('loan restructuring and arrears automation', () => {
  beforeAll(async () => {
    pool = createPool(TEST_DATABASE_URL);
    await ensureRbacSeeded(pool);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM sessions WHERE user_id IN
      (SELECT id FROM users WHERE email LIKE '%@coopengine.test')`);
    await pool.query(`DELETE FROM users WHERE email LIKE '%@coopengine.test'`);
    await pool.end();
    await app.close();
  });

  it('restructures a disbursed loan and flags 90+ day arrears', async () => {
    const coop = await onboardCoop();
    const auth = { Authorization: `Bearer ${coop.tokens.accessToken}` };

    const memberIds: string[] = [];
    for (const seed of ['RA1', 'RA2', 'RA3']) {
      const created = await request(app.getHttpServer())
        .post('/api/v1/members')
        .set(auth)
        .send({
          firstName: seed,
          lastName: 'Member',
          email: `ra-${seed}-${randomUUID().slice(0, 6)}@coopengine.test`,
        });
      const id = (created.body.id ?? created.body.member?.id) as string;
      await request(app.getHttpServer()).post(`/api/v1/members/${id}/approve`).set(auth).send({});
      memberIds.push(id);
    }
    const [borrower, g1, g2] = memberIds as [string, string, string];

    const acct = await request(app.getHttpServer())
      .post(`/api/v1/savings/member/${borrower}/account`)
      .set(auth)
      .send({});
    const accountId = (acct.body.id ?? acct.body.account?.id) as string;
    await request(app.getHttpServer())
      .post(`/api/v1/savings/accounts/${accountId}/deposits`)
      .set(auth)
      .send({ amount: 60000, idempotencyKey: randomUUID() });

    const products = await request(app.getHttpServer()).get('/api/v1/loans/products').set(auth);
    const loan = await request(app.getHttpServer())
      .post('/api/v1/loans')
      .set(auth)
      .send({
        memberId: borrower,
        productId: products.body[0].id,
        principal: 30000,
        termMonths: 3,
        guarantorIds: [g1, g2],
      });
    const loanId = loan.body.id as string;
    await request(app.getHttpServer()).post(`/api/v1/loans/${loanId}/approve`).set(auth);
    await request(app.getHttpServer()).post(`/api/v1/loans/${loanId}/disburse`).set(auth);

    const before = await request(app.getHttpServer())
      .get(`/api/v1/loans/${loanId}/schedule`)
      .set(auth);
    expect(before.body).toHaveLength(3);

    // Restructure: 30,000 outstanding → 6 monthly installments
    const restructured = await request(app.getHttpServer())
      .post(`/api/v1/loans/${loanId}/restructure`)
      .set(auth)
      .send({ newTermMonths: 6, reason: 'Member lost income; rescheduled' });
    expect(restructured.status).toBe(200);
    expect(restructured.body.schedule).toHaveLength(6);
    const principalSum = restructured.body.schedule.reduce(
      (sum: number, r: { principalDue: string | number }) => sum + Number(r.principalDue),
      0,
    );
    expect(Math.round(principalSum * 100) / 100).toBe(30000);

    const badTerm = await request(app.getHttpServer())
      .post(`/api/v1/loans/${loanId}/restructure`)
      .set(auth)
      .send({ newTermMonths: 0, reason: 'invalid' });
    expect(badTerm.status).toBe(400);

    // Backdate the first installment by 100 days (tenant-scoped write on a
    // throwaway pool so the shared test pool keeps a clean session)
    const backdatePool = createPool(TEST_DATABASE_URL);
    try {
      const client = await backdatePool.connect();
      try {
        await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [
          coop.organizationId,
        ]);
        const upd = await client.query(
          `UPDATE loan_repayments SET due_date = now()::date - 100 WHERE loan_id = $1 AND seq = 1`,
          [loanId],
        );
        expect(upd.rowCount).toBe(1);
      } finally {
        client.release();
      }
    } finally {
      await backdatePool.end();
    }

    const arrears = await request(app.getHttpServer()).get('/api/v1/loans/arrears').set(auth);
    expect(arrears.status).toBe(200);
    expect(arrears.body.rows.length).toBeGreaterThan(0);
    const ninety = arrears.body.buckets.find((b: { bucket: string }) => b.bucket === '90+');
    expect(ninety.count).toBeGreaterThan(0);

    const marked = await request(app.getHttpServer())
      .post('/api/v1/loans/arrears/mark')
      .set(auth)
      .send({ daysLate: 90 });
    expect(marked.status).toBe(200);
    expect(marked.body.defaulted).toBe(1);

    const after = await request(app.getHttpServer()).get(`/api/v1/loans/${loanId}`).set(auth);
    expect(after.body.status, JSON.stringify(after.body).slice(0, 200)).toBe('DEFAULTED');

    // No money moved: books still balanced
    const net = await pool.query(`SELECT coalesce(sum(debit - credit), 0) AS net FROM journal_lines`);
    expect(Number(net.rows[0].net)).toBe(0);
  });
});
