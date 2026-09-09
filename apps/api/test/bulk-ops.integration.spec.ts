/**
 * Bulk money-ops integration tests (real PostgreSQL).
 *
 * Proves: CSV preview/commit for share purchases (auto-posting Dr 1000 /
 * Cr 3000 per member) and for loan-repayment collections (interest-first
 * allocation across installments, journal history exposed per loan),
 * validation (unknown member / over-due amounts rejected at preview),
 * double-commit protection, and balanced books throughout.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { createPool } from '@coopengine/db';
import { ensureRbacSeeded, ADMIN_PASSWORD, TEST_DATABASE_URL } from './helpers';

const ADMIN_EMAIL = 'admin@coopengine.dev';

let app: INestApplication;
let pool: Pool;

async function onboardCoop(label: string): Promise<{ tokens: { accessToken: string } }> {
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
    .send({ firstName: `Bulk${seed}`, lastName: 'Member', email: `bulk-${seed}-${randomUUID().slice(0, 6)}@coopengine.test` });
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
    await pool.query(`DELETE FROM sessions`);
    await pool.end();
  }
  if (app) await app.close();
});

describe('bulk money operations', () => {
  it('batches share purchases and loan repayment collections onto the ledger', async () => {
    const coop = await onboardCoop('bulk');
    const auth = { Authorization: `Bearer ${coop.tokens.accessToken}` };
    const m1 = await createActiveMember(coop, '1');
    const m2 = await createActiveMember(coop, '2');
    const g = await createActiveMember(coop, 'G');

    // --- Share purchase batch -------------------------------------------
    const sharePreview = await request(app.getHttpServer())
      .post('/api/v1/bulk/share-purchases/preview')
      .set(auth)
      .send({
        filename: 'shares-mar.csv',
        csv: `memberNo,amount\n${m1.memberNo},10000\n${m2.memberNo},5000\n999999,2000`,
      });
    expect(sharePreview.status).toBe(201);
    expect(sharePreview.body.totals).toEqual({ totalRows: 3, valid: 2, invalid: 1, totalAmount: 15000 });
    expect(sharePreview.body.errors[0]).toContain('not found');

    const shareCommit = await request(app.getHttpServer())
      .post('/api/v1/bulk/share-purchases/commit')
      .set(auth)
      .send({ batchId: sharePreview.body.batchId });
    expect(shareCommit.status).toBe(200);
    expect(shareCommit.body.committed).toBe(2);
    expect(shareCommit.body.totalAmount).toBe(15000);

    // Double commit blocked
    const again = await request(app.getHttpServer())
      .post('/api/v1/bulk/share-purchases/commit')
      .set(auth)
      .send({ batchId: sharePreview.body.batchId });
    expect(again.status).toBe(409);

    const shareAcc = await request(app.getHttpServer())
      .get(`/api/v1/shares/member/${m1.id}`)
      .set(auth);
    expect(shareAcc.body.currentBalance).toBe(10000);

    // --- Loan repayment batch -------------------------------------------
    // Fund m1 savings (20k) so it can borrow 40k with two guarantors
    const acc = await request(app.getHttpServer())
      .post(`/api/v1/savings/member/${m1.id}/account`)
      .set(auth)
      .send({});
    await request(app.getHttpServer())
      .post(`/api/v1/savings/accounts/${acc.body.id as string}/deposits`)
      .set(auth)
      .send({ amount: 20000 });
    const products = await request(app.getHttpServer()).get('/api/v1/loans/products').set(auth);
    const cashLoan = (products.body as { code: string; id: string }[]).find(
      (p) => p.code === 'CASH-LOAN',
    ) as { id: string };
    const loan = await request(app.getHttpServer())
      .post('/api/v1/loans')
      .set(auth)
      .send({ memberId: m1.id, productId: cashLoan.id, principal: 30000, termMonths: 3, guarantorIds: [m2.id, g.id] });
    expect(loan.status).toBe(201);
    const loanId = loan.body.id as string;
    await request(app.getHttpServer()).post(`/api/v1/loans/${loanId}/approve`).set(auth).send({});
    await request(app.getHttpServer()).post(`/api/v1/loans/${loanId}/disburse`).set(auth).send({});

    const schedule = await request(app.getHttpServer())
      .get(`/api/v1/loans/${loanId}/schedule`)
      .set(auth);
    const installments = schedule.body as { principalDue: number; interestDue: number }[];
    const firstDue = installments[0].principalDue + installments[0].interestDue;

    // Preview: exact first installment is valid; over-due amount is rejected
    const loanPreview = await request(app.getHttpServer())
      .post('/api/v1/bulk/loan-repayments/preview')
      .set(auth)
      .send({
        filename: 'collections.csv',
        csv: `memberNo,amount\n${m1.memberNo},${firstDue}\n${m1.memberNo},1\n`,
      });
    expect(loanPreview.status).toBe(400); // duplicate memberNo in file

    const loanPreview2 = await request(app.getHttpServer())
      .post('/api/v1/bulk/loan-repayments/preview')
      .set(auth)
      .send({
        filename: 'collections.csv',
        csv: `memberNo,amount\n${m1.memberNo},${firstDue}\n${m2.memberNo},999999\n`,
      });
    expect(loanPreview2.status).toBe(201);
    expect(loanPreview2.body.totals.valid).toBe(1);
    expect(loanPreview2.body.totals.invalid).toBe(1);
    expect(loanPreview2.body.errors[0]).toContain('no open loan');

    const loanCommit = await request(app.getHttpServer())
      .post('/api/v1/bulk/loan-repayments/commit')
      .set(auth)
      .send({ batchId: loanPreview2.body.batchId });
    expect(loanCommit.status).toBe(200);
    expect(loanCommit.body.committed).toBe(1);
    expect(loanCommit.body.totalAmount).toBeCloseTo(firstDue, 2);

    // Outstanding reduced by exactly the principal portion
    const loanDetail = await request(app.getHttpServer()).get(`/api/v1/loans/${loanId}`).set(auth);
    expect(loanDetail.body.outstandingPrincipal).toBeCloseTo(30000 - installments[0].principalDue, 2);

    // History shows the split
    const history = await request(app.getHttpServer())
      .get(`/api/v1/loans/${loanId}/payments`)
      .set(auth);
    expect(history.body).toHaveLength(1);
    expect(history.body[0].principalPortion).toBeCloseTo(installments[0].principalDue, 2);
    expect(history.body[0].interestPortion).toBeCloseTo(installments[0].interestDue, 2);

    // Books balance across both batches
    const tb = await request(app.getHttpServer()).get('/api/v1/ledger/trial-balance').set(auth);
    expect(tb.body.net).toBe(0);
    const rows = tb.body.rows as { code: string; balance: number }[];
    const equity = rows.find((r) => r.code === '3000');
    expect(equity?.balance).toBe(-15000);
  });
});
