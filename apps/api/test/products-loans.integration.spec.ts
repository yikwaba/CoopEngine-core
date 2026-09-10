/**
 * Product administration + member self-service loan applications (real PostgreSQL).
 *
 * Proves: product CRUD (create/update/validate/duplicate), deactivation guard
 * while a product is in use, member-visible ACTIVE products, member loan
 * application rules (open-loan block, savings-multiple cap), the guarantor
 * approval gate, and the full member -> staff -> disbursed flow.
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

interface Coop {
  tokens: { accessToken: string };
  slug: string;
}

async function onboardCoop(label: string): Promise<Coop> {
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
  return {
    tokens: { accessToken: coopLogin.body.tokens.accessToken as string },
    slug: `${label}-${suffix}`,
  };
}

async function createActiveMember(
  coop: Coop,
  seed: string,
  email = `member-${seed}-${randomUUID().slice(0, 6)}@coopengine.test`,
): Promise<{ id: string; email: string }> {
  const auth = { Authorization: `Bearer ${coop.tokens.accessToken}` };
  const created = await request(app.getHttpServer())
    .post('/api/v1/members')
    .set(auth)
    .send({ firstName: `Mem${seed}`, lastName: 'Test', email });
  expect(created.status).toBe(201);
  const id = created.body.id ?? created.body.member?.id;
  const approved = await request(app.getHttpServer())
    .post(`/api/v1/members/${id}/approve`)
    .set(auth)
    .send({});
  expect(approved.status).toBe(200);
  return { id, email };
}

async function memberLogin(coop: Coop, email: string): Promise<string> {
  const otp = await request(app.getHttpServer())
    .post('/api/v1/auth/member/request-otp')
    .send({ organizationSlug: coop.slug, email });
  expect(otp.status).toBe(200);
  const code = otp.body.devCode as string | undefined;
  expect(code, 'dev provider should return the OTP code').toBeTruthy();
  const verify = await request(app.getHttpServer())
    .post('/api/v1/auth/member/verify-otp')
    .send({ organizationSlug: coop.slug, email, code });
  expect(verify.status).toBe(200);
  return verify.body.accessToken as string;
}

describe('product administration + member loan applications', () => {
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

  it('manages products and drives a member loan application to disbursement', async () => {
    const coop = await onboardCoop('pl');
    const auth = { Authorization: `Bearer ${coop.tokens.accessToken}` };

    // ---- product administration -------------------------------------------
    const seeded = await request(app.getHttpServer())
      .get('/api/v1/products/savings')
      .set(auth);
    expect(seeded.status).toBe(200);
    expect(Array.isArray(seeded.body)).toBe(true);

    const created = await request(app.getHttpServer())
      .post('/api/v1/products/savings')
      .set(auth)
      .send({ code: 'TARGET', name: 'Target Savings', interestRatePa: 6.5, minDeposit: 500, allowWithdrawal: false });
    expect(created.status).toBe(201);

    const duplicate = await request(app.getHttpServer())
      .post('/api/v1/products/savings')
      .set(auth)
      .send({ code: 'target', name: 'Dup', interestRatePa: 5, minDeposit: 0, allowWithdrawal: true });
    expect(duplicate.status).toBe(409);

    const badRate = await request(app.getHttpServer())
      .post('/api/v1/products/savings')
      .set(auth)
      .send({ code: 'BADRATE', name: 'Bad', interestRatePa: 150, minDeposit: 0, allowWithdrawal: true });
    expect(badRate.status).toBe(400);

    const updated = await request(app.getHttpServer())
      .patch(`/api/v1/products/savings/${created.body.id}`)
      .set(auth)
      .send({ code: 'TARGET', name: 'Target Savings', interestRatePa: 7, minDeposit: 500, allowWithdrawal: false });
    expect(updated.status).toBe(200);
    const afterUpdate = await request(app.getHttpServer())
      .get('/api/v1/products/savings')
      .set(auth);
    const target = afterUpdate.body.find((p: { code: string }) => p.code === 'TARGET');
    expect(target.interestRatePa).toBe(7);

    const deactivated = await request(app.getHttpServer())
      .post(`/api/v1/products/savings/${created.body.id}/status`)
      .set(auth)
      .send({ status: 'INACTIVE' });
    expect(deactivated.status).toBe(201);

    // ---- loan product + members -------------------------------------------
    const loanProduct = await request(app.getHttpServer())
      .post('/api/v1/products/loans')
      .set(auth)
      .send({
        code: 'PLLOAN',
        name: 'Test Loan',
        interestRatePa: 12,
        interestMethod: 'FLAT',
        multiplier: 3,
        minPrincipal: 1000,
        maxPrincipal: 5000000,
      });
    expect(loanProduct.status).toBe(201);

    const borrower = await createActiveMember(coop, 'B');
    const g1 = await createActiveMember(coop, 'G1');
    const g2 = await createActiveMember(coop, 'G2');

    // fund the borrower so the savings-multiple cap allows a loan
    const acct = await request(app.getHttpServer())
      .post(`/api/v1/savings/member/${borrower.id}/account`)
      .set(auth)
      .send({});
    expect([200, 201]).toContain(acct.status);
    const accountId = acct.body.id ?? acct.body.account?.id;
    const deposit = await request(app.getHttpServer())
      .post(`/api/v1/savings/accounts/${accountId}/deposits`)
      .set(auth)
      .send({ amount: 50000, idempotencyKey: randomUUID() });
    expect([200, 201]).toContain(deposit.status);

    // deactivation is blocked while the product is in use
    const staffLoan = await request(app.getHttpServer())
      .post('/api/v1/loans')
      .set(auth)
      .send({
        memberId: borrower.id,
        productId: loanProduct.body.id,
        principal: 100000,
        termMonths: 6,
        guarantorIds: [g1.id, g2.id],
      });
    expect(staffLoan.status).toBe(201);
    const inUse = await request(app.getHttpServer())
      .post(`/api/v1/products/loans/${loanProduct.body.id}/status`)
      .set(auth)
      .send({ status: 'INACTIVE' });
    expect(inUse.status).toBe(409);

    // ---- member self-service ----------------------------------------------
    const token = await memberLogin(coop, borrower.email);
    const mAuth = { Authorization: `Bearer ${token}` };

    const products = await request(app.getHttpServer())
      .get('/api/v1/member/loan-products')
      .set(mAuth);
    expect(products.status).toBe(200);
    expect(products.body.some((p: { code: string }) => p.code === 'PLLOAN')).toBe(true);

    // borrower already has an open loan (staff one) -> blocked
    const overCapBorrower = await request(app.getHttpServer())
      .post('/api/v1/member/loans/apply')
      .set(mAuth)
      .send({ loanProductId: loanProduct.body.id, principal: 900000, termMonths: 3 });
    expect(overCapBorrower.status).toBe(409);

    // ---- guarantor gate + full flow on the member channel ------------------
    const applicant = await createActiveMember(coop, 'A');
    const aToken = await memberLogin(coop, applicant.email);
    const aAuth = { Authorization: `Bearer ${aToken}` };
    const acct2 = await request(app.getHttpServer())
      .post(`/api/v1/savings/member/${applicant.id}/account`)
      .set(auth)
      .send({});
    expect([200, 201]).toContain(acct2.status);
    const account2 = acct2.body.id ?? acct2.body.account?.id;
    const dep2 = await request(app.getHttpServer())
      .post(`/api/v1/savings/accounts/${account2}/deposits`)
      .set(auth)
      .send({ amount: 20000, idempotencyKey: randomUUID() });
    expect([200, 201]).toContain(dep2.status);

    // cap rejection (savings 20,000 x3 = 60,000 max)
    const overCap = await request(app.getHttpServer())
      .post('/api/v1/member/loans/apply')
      .set(aAuth)
      .send({ loanProductId: loanProduct.body.id, principal: 900000, termMonths: 3 });
    expect(overCap.status).toBe(400);

    const applied = await request(app.getHttpServer())
      .post('/api/v1/member/loans/apply')
      .set(aAuth)
      .send({ loanProductId: loanProduct.body.id, principal: 30000, termMonths: 3 });
    expect(applied.status, JSON.stringify(applied.body)).toBe(201);
    const appliedId = applied.body.id;

    // approval blocked without guarantors
    const blocked = await request(app.getHttpServer())
      .post(`/api/v1/loans/${appliedId}/approve`)
      .set(auth);
    expect(blocked.status).toBe(409);

    for (const g of [g1, g2]) {
      const added = await request(app.getHttpServer())
        .post(`/api/v1/loans/${appliedId}/guarantors`)
        .set(auth)
        .send({ memberId: g.id });
      expect(added.status).toBe(201);
    }
    const dupGuarantor = await request(app.getHttpServer())
      .post(`/api/v1/loans/${appliedId}/guarantors`)
      .set(auth)
      .send({ memberId: g1.id });
    expect(dupGuarantor.status).toBe(409);

    const approved = await request(app.getHttpServer())
      .post(`/api/v1/loans/${appliedId}/approve`)
      .set(auth);
    expect(approved.status).toBe(200);
    const disbursed = await request(app.getHttpServer())
      .post(`/api/v1/loans/${appliedId}/disburse`)
      .set(auth);
    expect(disbursed.status).toBe(200);

    const myLoans = await request(app.getHttpServer())
      .get('/api/v1/member/loans')
      .set(aAuth);
    expect(myLoans.status).toBe(200);
    const mine = myLoans.body.find((l: { id: string }) => l.id === appliedId);
    expect(mine.status).toBe('DISBURSED');
    expect(mine.outstandingPrincipal).toBe(30000);
    expect(mine.nextDueDate).toBeTruthy();
  });

  it('keeps the books balanced after the flow', async () => {
    const { rows } = await pool.query(
      `SELECT coalesce(sum(debit - credit), 0) AS net FROM journal_lines`,
    );
    expect(Number(rows[0].net)).toBe(0);
  });
});

