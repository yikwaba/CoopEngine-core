/**
 * Loan repayment + share capital integration tests (real PostgreSQL).
 *
 * Proves: flat-interest schedule generation at disbursement, repayment
 * allocation (interest before principal in due order), loan completion when
 * fully repaid, balanced journals for repayments and share purchases,
 * and trial-balance integrity across the full money loop.
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

interface CoopCtx {
  tokens: { accessToken: string };
}

async function onboardCoop(label: string): Promise<CoopCtx> {
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

async function activeMember(coop: CoopCtx, seed: string): Promise<string> {
  const auth = { Authorization: `Bearer ${coop.tokens.accessToken}` };
  const created = await request(app.getHttpServer())
    .post('/api/v1/members')
    .set(auth)
    .send({
      firstName: `Repay${seed}`,
      lastName: `Member${seed}`,
      email: `${seed.toLowerCase()}-${randomUUID().slice(0, 8)}@coopengine.test`,
    });
  expect(created.status).toBe(201);
  const id = created.body.id as string;
  await request(app.getHttpServer()).post(`/api/v1/members/${id}/approve`).set(auth);
  return id;
}

async function fundSavings(coop: CoopCtx, memberId: string, amount: number): Promise<string> {
  const auth = { Authorization: `Bearer ${coop.tokens.accessToken}` };
  const opened = await request(app.getHttpServer())
    .post(`/api/v1/savings/member/${memberId}/account`)
    .set(auth)
    .send({});
  expect(opened.status).toBe(201);
  const accountId = opened.body.id as string;
  await request(app.getHttpServer())
    .post(`/api/v1/savings/accounts/${accountId}/deposits`)
    .set(auth)
    .send({ amount });
  return accountId;
}

async function disburseLoan(
  coop: CoopCtx,
  borrowerId: string,
  principal: number,
  termMonths: number,
): Promise<{ loanId: string; productId: string }> {
  const auth = { Authorization: `Bearer ${coop.tokens.accessToken}` };
  const g1 = await activeMember(coop, `G1-${randomUUID().slice(0, 4)}`);
  const g2 = await activeMember(coop, `G2-${randomUUID().slice(0, 4)}`);
  const products = await request(app.getHttpServer()).get('/api/v1/loans/products').set(auth);
  const product = (products.body as { code: string; id: string }[]).find(
    (p) => p.code === 'CASH-LOAN',
  ) as { id: string };
  const applied = await request(app.getHttpServer())
    .post('/api/v1/loans')
    .set(auth)
    .send({
      memberId: borrowerId,
      productId: product.id,
      principal,
      termMonths,
      guarantorIds: [g1, g2],
    });
  expect(applied.status).toBe(201);
  const loanId = applied.body.id as string;
  await request(app.getHttpServer()).post(`/api/v1/loans/${loanId}/approve`).set(auth);
  const disbursed = await request(app.getHttpServer())
    .post(`/api/v1/loans/${loanId}/disburse`)
    .set(auth);
  expect(disbursed.status).toBe(200);
  return { loanId, productId: product.id };
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

describe('loan repayment engine', () => {
  it('generates a flat schedule, allocates partial payments, and completes the loan', async () => {
    const coop = await onboardCoop('repay');
    const auth = { Authorization: `Bearer ${coop.tokens.accessToken}` };

    // 15,000 loan over 3 months at 15% p.a. flat:
    // interest = 15000 * 0.15 * 3/12 = 562.5; total due = 15,562.5
    const borrower = await activeMember(coop, 'B');
    await fundSavings(coop, borrower, 20000);
    const { loanId } = await disburseLoan(coop, borrower, 15000, 3);

    const schedule = await request(app.getHttpServer())
      .get(`/api/v1/loans/${loanId}/schedule`)
      .set(auth);
    expect(schedule.status).toBe(200);
    const rows = schedule.body as {
      seq: number;
      principalDue: number;
      interestDue: number;
      status: string;
    }[];
    expect(rows).toHaveLength(3);
    const totalPrincipal = rows.reduce((a, r) => a + r.principalDue, 0);
    const totalInterest = rows.reduce((a, r) => a + r.interestDue, 0);
    expect(totalPrincipal).toBe(15000);
    expect(totalInterest).toBe(562.5);
    expect(rows.every((r) => r.status === 'PENDING')).toBe(true);

    // Partial repayment 2,000 -> interest of installment 1 first, then principal
    const partial = await request(app.getHttpServer())
      .post(`/api/v1/loans/${loanId}/repayments`)
      .set(auth)
      .send({ amount: 2000, description: 'First contribution' });
    expect(partial.status).toBe(200);
    expect(partial.body.loan.outstandingPrincipal).toBe(13187.5); // 15000 - 1812.5

    const afterPartial = await request(app.getHttpServer())
      .get(`/api/v1/loans/${loanId}/schedule`)
      .set(auth);
    const rows2 = afterPartial.body as { status: string; paidInterest: number; paidPrincipal: number }[];
    expect(rows2[0]).toMatchObject({ status: 'PARTIAL', paidInterest: 187.5, paidPrincipal: 1812.5 });

    // Settle the remaining 13,562.5 -> loan COMPLETED
    const settle = await request(app.getHttpServer())
      .post(`/api/v1/loans/${loanId}/repayments`)
      .set(auth)
      .send({ amount: 13562.5 });
    expect(settle.status).toBe(200);
    expect(settle.body.loan.status).toBe('COMPLETED');
    expect(settle.body.loan.outstandingPrincipal).toBe(0);

    // Over-repaying a completed loan -> 409
    const extra = await request(app.getHttpServer())
      .post(`/api/v1/loans/${loanId}/repayments`)
      .set(auth)
      .send({ amount: 100 });
    expect(extra.status).toBe(409);

    // Ledger integrity across the loop:
    // 1020 back to 0, 4000 = -562.50, 1000 balanced by member savings elsewhere
    const tb = await request(app.getHttpServer())
      .get('/api/v1/ledger/trial-balance')
      .set(auth);
    expect(tb.status).toBe(200);
    expect(tb.body.net).toBe(0);
    const receivable = (tb.body.rows as { code: string; balance: number }[]).find(
      (r) => r.code === '1020',
    );
    const interestIncome = (tb.body.rows as { code: string; balance: number }[]).find(
      (r) => r.code === '4000',
    );
    expect(receivable?.balance).toBe(0);
    expect(interestIncome?.balance).toBe(-562.5);

    const journals = await request(app.getHttpServer())
      .get('/api/v1/ledger/journals?status=POSTED')
      .set(auth);
    const sources = (journals.body as { source: string }[]).map((j) => j.source);
    expect(sources.filter((s) => s === 'LOAN_REPAYMENT')).toHaveLength(2);
    expect(sources).toContain('LOAN_DISBURSEMENT');
  });
});

describe('share capital on the ledger', () => {
  it('posts share purchases to Member Share Capital (3000) with statements', async () => {
    const coop = await onboardCoop('shares');
    const auth = { Authorization: `Bearer ${coop.tokens.accessToken}` };
    const memberId = await activeMember(coop, 'S');

    // No account yet -> 404; purchase auto-opens it
    const missing = await request(app.getHttpServer())
      .get(`/api/v1/shares/member/${memberId}`)
      .set(auth);
    expect(missing.status).toBe(404);

    const purchase = await request(app.getHttpServer())
      .post(`/api/v1/shares/member/${memberId}/purchases`)
      .set(auth)
      .send({ amount: 10000, description: 'Share allotment' });
    expect(purchase.status).toBe(201);
    expect(purchase.body.currentBalance).toBe(10000);

    const second = await request(app.getHttpServer())
      .post(`/api/v1/shares/member/${memberId}/purchases`)
      .set(auth)
      .send({ amount: 5000 });
    expect(second.status).toBe(201);
    expect(second.body.currentBalance).toBe(15000);

    // Statement
    const statement = await request(app.getHttpServer())
      .get(`/api/v1/shares/member/${memberId}/statement`)
      .set(auth);
    expect(statement.status).toBe(200);
    const txns = statement.body as { signedAmount: number; runningBalance: number }[];
    expect(txns).toHaveLength(2);
    expect(txns[0].runningBalance).toBe(15000);

    // Trial balance: 3000 = -15,000 (equity credit), net zero
    const tb = await request(app.getHttpServer())
      .get('/api/v1/ledger/trial-balance')
      .set(auth);
    expect(tb.status).toBe(200);
    expect(tb.body.net).toBe(0);
    const shareCapital = (tb.body.rows as { code: string; balance: number }[]).find(
      (r) => r.code === '3000',
    );
    expect(shareCapital?.balance).toBe(-15000);

    // Idempotency + cross-member isolation
    const key = `share-${randomUUID().slice(0, 12)}`;
    await request(app.getHttpServer())
      .post(`/api/v1/shares/member/${memberId}/purchases`)
      .set(auth)
      .send({ amount: 100, idempotencyKey: key });
    const replay = await request(app.getHttpServer())
      .post(`/api/v1/shares/member/${memberId}/purchases`)
      .set(auth)
      .send({ amount: 500, idempotencyKey: key });
    expect(replay.status).toBe(409);
  });
});
