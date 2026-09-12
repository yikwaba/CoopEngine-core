/**
 * Phase-5 report endpoints integration tests (real PostgreSQL).
 *
 * Proves: contribution schedule aggregates monthly DEPOSIT totals, loan
 * aging buckets freshly disbursed loans as CURRENT, the exited-members
 * register carries payout metadata from the audit trail, and the savings
 * interest preview computes monthly accrual at product rates without posting.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { createPool, withTenant } from '@coopengine/db';
import { ensureRbacSeeded, ADMIN_PASSWORD, TEST_DATABASE_URL } from './helpers';

const ADMIN_EMAIL = 'admin@coopengine.dev';

let app: INestApplication;
let pool: Pool;

async function onboardCoop(label: string): Promise<{
  tokens: { accessToken: string };
}> {
  const saasLogin = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  expect(saasLogin.status).toBe(200);
  const suffix = randomUUID().slice(0, 8);
  const onboard = await request(app.getHttpServer())
    .post('/api/v1/organizations')
    .set('Authorization', `Bearer ${saasLogin.body.tokens.accessToken}`)
    .send({
      name: `${label} cooperative`,
      slug: `${label}-${suffix}`,
      adminEmail: `${label}-${suffix}@coopengine.test`,
      adminPassword: 'CoopPass123!',
    });
  expect(onboard.status).toBe(201);
  const coopLogin = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email: `${label}-${suffix}@coopengine.test`, password: 'CoopPass123!' });
  expect(coopLogin.status).toBe(200);
  return { tokens: { accessToken: coopLogin.body.tokens.accessToken as string } };
}

async function createActiveMember(
  coop: { tokens: { accessToken: string } },
  seed: string,
): Promise<{ id: string; memberNo: number }> {
  const auth = { Authorization: `Bearer ${coop.tokens.accessToken}` };
  const created = await request(app.getHttpServer())
    .post('/api/v1/members')
    .set(auth)
    .send({
      firstName: `Rep${seed}`,
      lastName: 'Member',
      email: `rep-${seed}-${randomUUID().slice(0, 6)}@coopengine.test`,
    });
  expect(created.status).toBe(201);
  const id = created.body.id as string;
  await request(app.getHttpServer()).post(`/api/v1/members/${id}/approve`).set(auth);
  return { id, memberNo: created.body.memberNo as number };
}

beforeAll(async () => {
  process.env.DATABASE_URL =
    TEST_DATABASE_URL;
  pool = createPool(process.env.DATABASE_URL);
  await ensureRbacSeeded(pool);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  await app.init();
});

afterAll(async () => {
  if (pool) {
    await pool.query(`DELETE FROM users WHERE email LIKE '%@coopengine.test'`);
    await pool.query(
      `DELETE FROM sessions WHERE user_id IN (
         SELECT id FROM users WHERE email LIKE '%@coopengine.test')`,
    );
    await pool.end();
  }
  if (app) await app.close();
});

describe('phase-5 report endpoints', () => {
  it('reports contribution schedule, loan aging, exited members and interest preview', async () => {
    const coop = await onboardCoop('rptx');
    const auth = { Authorization: `Bearer ${coop.tokens.accessToken}` };
    const m1 = await createActiveMember(coop, 'A');
    const m2 = await createActiveMember(coop, 'B');

    // Savings: 25,000 for m1 (two deposits) and 10,000 for m2
    const a1 = await request(app.getHttpServer())
      .post(`/api/v1/savings/member/${m1.id}/account`)
      .set(auth)
      .send({});
    const a1id = a1.body.id as string;
    await request(app.getHttpServer())
      .post(`/api/v1/savings/accounts/${a1id}/deposits`)
      .set(auth)
      .send({ amount: 15000 });
    await request(app.getHttpServer())
      .post(`/api/v1/savings/accounts/${a1id}/deposits`)
      .set(auth)
      .send({ amount: 10000 });
    const a2 = await request(app.getHttpServer())
      .post(`/api/v1/savings/member/${m2.id}/account`)
      .set(auth)
      .send({});
    await request(app.getHttpServer())
      .post(`/api/v1/savings/accounts/${a2.body.id as string}/deposits`)
      .set(auth)
      .send({ amount: 10000 });

    // Contribution schedule for the current month
    const schedule = await request(app.getHttpServer())
      .get('/api/v1/reports/contribution-schedule?months=3')
      .set(auth);
    expect(schedule.status).toBe(200);
    expect(schedule.body.totalContributed).toBe(35000);
    expect(schedule.body.rows).toHaveLength(2);
    const byNo = new Map(
      (schedule.body.rows as { memberNo: number; contributed: number }[]).map(
        (r) => [r.memberNo, r.contributed] as const,
      ),
    );
    expect(byNo.get(m1.memberNo)).toBe(25000);
    expect(byNo.get(m2.memberNo)).toBe(10000);

    // Disburse a loan for m1 to appear in aging as CURRENT
    const g = await createActiveMember(coop, 'G');
    const products = await request(app.getHttpServer()).get('/api/v1/loans/products').set(auth);
    const cashLoan = (products.body as { code: string; id: string }[]).find(
      (p) => p.code === 'CASH-LOAN',
    ) as { id: string };
    const apply = await request(app.getHttpServer())
      .post('/api/v1/loans')
      .set(auth)
      .send({
        memberId: m1.id,
        productId: cashLoan.id,
        principal: 20000,
        termMonths: 3,
        guarantorIds: [m2.id, g.id],
      });
    expect(apply.status).toBe(201);
    const loanId = apply.body.id as string;
    await request(app.getHttpServer()).post(`/api/v1/loans/${loanId}/approve`).set(auth).send({});
    await request(app.getHttpServer()).post(`/api/v1/loans/${loanId}/disburse`).set(auth).send({});

    const aging = await request(app.getHttpServer())
      .get('/api/v1/reports/loans-aging')
      .set(auth);
    expect(aging.status).toBe(200);
    const current = (aging.body.buckets as { bucket: string; count: number; outstanding: number }[]).find(
      (b) => b.bucket === 'CURRENT',
    );
    expect(current?.count).toBe(1);
    expect(current?.outstanding).toBe(20000);
    expect((aging.body.rows as { nextDueDate: string | null }[])[0].nextDueDate).toBeTruthy();

    // Interest preview with a configured rate (5% p.a.)
    const orgId = (await request(app.getHttpServer()).get('/api/v1/auth/me').set(auth)).body
      .organizationId as string;
    await withTenant(pool, orgId, async (c) => {
      await c.query(`UPDATE savings_products SET interest_rate_pa = 5 WHERE organization_id = $1`, [orgId]);
    });
    const interest = await request(app.getHttpServer())
      .get('/api/v1/reports/savings-interest-preview')
      .set(auth);
    expect(interest.status).toBe(200);
    // m1 25,000 + m2 10,000 = 35,000 at 5% -> 145.83/month total
    expect(interest.body.totalBalance).toBe(35000);
    expect(interest.body.totalMonthlyEstimate).toBeCloseTo(145.83, 1);
    expect(interest.body.rows).toHaveLength(2);

    // Exited-members register: exit m2 (no loans) and verify the audit trail
    const exit = await request(app.getHttpServer())
      .post(`/api/v1/members/${m2.id}/exit`)
      .set(auth);
    expect(exit.status).toBe(200);
    const exited = await request(app.getHttpServer())
      .get('/api/v1/reports/exited-members')
      .set(auth);
    expect(exited.status).toBe(200);
    expect(exited.body.count).toBe(1);
    expect(exited.body.totalPaidOut).toBe(10000);
    expect(exited.body.rows[0].memberNo).toBe(m2.memberNo);
    expect(exited.body.rows[0].payout).toBe(10000);
  });
});
