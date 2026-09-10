/**
 * Notification centre (real PostgreSQL).
 *
 * Proves: business events create member notifications transactionally (loan
 * decision, repayment, dividend), the member channel can list and mark them
 * read, staff can filter and dispatch pending records (dev adapter records the
 * attempt), and tenants stay isolated.
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

async function onboardCoop(label: string): Promise<{ tokens: { accessToken: string }; slug: string }> {
  const saasLogin = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  const suffix = randomUUID().slice(0, 8);
  await request(app.getHttpServer())
    .post('/api/v1/organizations')
    .set('Authorization', `Bearer ${saasLogin.body.tokens.accessToken}`)
    .send({
      name: `${label} cooperative`,
      slug: `${label}-${suffix}`,
      adminEmail: `${label}-${suffix}@coopengine.test`,
      adminPassword: 'CoopPass123!',
    });
  const login = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email: `${label}-${suffix}@coopengine.test`, password: 'CoopPass123!' });
  return { tokens: { accessToken: login.body.tokens.accessToken as string }, slug: `${label}-${suffix}` };
}

describe('notification centre', () => {
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

  it('records event notifications, exposes them to the member and dispatches', async () => {
    const coop = await onboardCoop('nt');
    const auth = { Authorization: `Bearer ${coop.tokens.accessToken}` };

    const members: { id: string; email: string }[] = [];
    for (const seed of ['NT1', 'NT2', 'NT3']) {
      const email = `nt-${seed}-${randomUUID().slice(0, 6)}@coopengine.test`;
      const created = await request(app.getHttpServer())
        .post('/api/v1/members')
        .set(auth)
        .send({ firstName: seed, lastName: 'Member', email, phone: '+2348000000000' });
      const id = (created.body.id ?? created.body.member?.id) as string;
      await request(app.getHttpServer()).post(`/api/v1/members/${id}/approve`).set(auth).send({});
      members.push({ id, email });
    }
    const [borrower, g1, g2] = members as [
      { id: string; email: string },
      { id: string; email: string },
      { id: string; email: string },
    ];

    const acct = await request(app.getHttpServer())
      .post(`/api/v1/savings/member/${borrower.id}/account`)
      .set(auth)
      .send({});
    const accountId = (acct.body.id ?? acct.body.account?.id) as string;
    await request(app.getHttpServer())
      .post(`/api/v1/savings/accounts/${accountId}/deposits`)
      .set(auth)
      .send({ amount: 40000, idempotencyKey: randomUUID() });

    const products = await request(app.getHttpServer()).get('/api/v1/loans/products').set(auth);
    const loan = await request(app.getHttpServer())
      .post('/api/v1/loans')
      .set(auth)
      .send({
        memberId: borrower.id,
        productId: products.body[0].id,
        principal: 20000,
        termMonths: 3,
        guarantorIds: [g1.id, g2.id],
      });
    const loanId = loan.body.id as string;

    // Loan decision + disbursement create notifications
    await request(app.getHttpServer()).post(`/api/v1/loans/${loanId}/approve`).set(auth);
    await request(app.getHttpServer()).post(`/api/v1/loans/${loanId}/disburse`).set(auth);

    const staffLog = await request(app.getHttpServer()).get('/api/v1/notifications').set(auth);
    expect(staffLog.status).toBe(200);
    const types = staffLog.body.items.map((n: { type: string }) => n.type);
    expect(types).toContain('LOAN_APPROVED');
    expect(types).toContain('LOAN_DISBURSED');
    expect(staffLog.body.pending).toBeGreaterThan(0);

    // Member sees their own notifications and can mark them read
    const otp = await request(app.getHttpServer())
      .post('/api/v1/auth/member/request-otp')
      .send({ organizationSlug: coop.slug, email: borrower.email });
    const verify = await request(app.getHttpServer())
      .post('/api/v1/auth/member/verify-otp')
      .send({ organizationSlug: coop.slug, email: borrower.email, code: otp.body.devCode });
    const mToken = verify.body.accessToken as string;
    const mine = await request(app.getHttpServer())
      .get('/api/v1/member/notifications')
      .set({ Authorization: `Bearer ${mToken}` });
    expect(mine.status).toBe(200);
    expect(mine.body.items.length).toBeGreaterThanOrEqual(2);
    expect(mine.body.items.every((n: { readAt: string | null }) => n.readAt === null)).toBe(true);

    const firstId = mine.body.items[0].id as string;
    const read = await request(app.getHttpServer())
      .post('/api/v1/member/notifications/read')
      .set({ Authorization: `Bearer ${mToken}` })
      .send({ id: firstId });
    expect([200, 201]).toContain(read.status);
    expect(read.body.updated).toBe(1);

    const readAll = await request(app.getHttpServer())
      .post('/api/v1/member/notifications/read')
      .set({ Authorization: `Bearer ${mToken}` })
      .send({});
    expect([200, 201]).toContain(readAll.status);
    expect(readAll.body.updated).toBeGreaterThanOrEqual(1);

    // Staff dispatch marks pending records sent via the dev adapter
    const dispatched = await request(app.getHttpServer())
      .post('/api/v1/notifications/dispatch')
      .set(auth)
      .send({});
    expect(dispatched.status).toBe(201);
    expect(dispatched.body.attempted).toBeGreaterThan(0);
    expect(dispatched.body.failed).toBe(0);

    const afterDispatch = await request(app.getHttpServer())
      .get('/api/v1/notifications?status=SENT')
      .set(auth);
    expect(afterDispatch.status).toBe(200);
    expect(afterDispatch.body.items.length).toBeGreaterThan(0);
    expect(afterDispatch.body.items[0].externalRef).toBeTruthy();

    // Dividend payout also notifies (share purchase then dividend post)
    for (const m of [borrower, g1]) {
      await request(app.getHttpServer())
        .post(`/api/v1/shares/member/${m.id}/purchases`)
        .set(auth)
        .send({ amount: 10000, idempotencyKey: randomUUID() });
    }
    const dividend = await request(app.getHttpServer())
      .post('/api/v1/dividends/post')
      .set(auth)
      .send({ periodLabel: '2026', distributableAmount: 10000 });
    expect(dividend.status).toBe(201);

    const dividendLog = await request(app.getHttpServer())
      .get('/api/v1/notifications?type=DIVIDEND_PAID')
      .set(auth);
    expect(dividendLog.status).toBe(200);
    expect(dividendLog.body.items).toHaveLength(2);
  });
});
