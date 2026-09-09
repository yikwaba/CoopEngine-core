/**
 * Loans module integration tests (real PostgreSQL).
 *
 * Proves: default loan products seeded (3x / 15% / 12.5% per Decision Log),
 * 3x-savings multiplier enforcement, guarantor requirements, approve/reject
 * workflow, disbursement auto-posting a balanced journal to the ledger,
 * outstanding balance tracking, and cross-tenant isolation.
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
    .send({
      email: `${label}-${suffix}@coopengine.test`,
      password: 'CoopPass123!',
    });
  expect(coopLogin.status).toBe(200);
  return { tokens: { accessToken: coopLogin.body.tokens.accessToken as string } };
}

async function createActiveMember(
  coop: CoopCtx,
  seed: string,
  email: string,
): Promise<string> {
  const auth = { Authorization: `Bearer ${coop.tokens.accessToken}` };
  const created = await request(app.getHttpServer())
    .post('/api/v1/members')
    .set(auth)
    .send({ firstName: `Loan${seed}`, lastName: `Member${seed}`, email });
  expect(created.status).toBe(201);
  const id = created.body.id as string;
  const approved = await request(app.getHttpServer())
    .post(`/api/v1/members/${id}/approve`)
    .set(auth);
  expect(approved.status).toBe(200);
  return id;
}

async function fundSavings(
  coop: CoopCtx,
  memberId: string,
  amount: number,
): Promise<string> {
  const auth = { Authorization: `Bearer ${coop.tokens.accessToken}` };
  const opened = await request(app.getHttpServer())
    .post(`/api/v1/savings/member/${memberId}/account`)
    .set(auth)
    .send({});
  expect(opened.status).toBe(201);
  const deposit = await request(app.getHttpServer())
    .post(`/api/v1/savings/accounts/${opened.body.id as string}/deposits`)
    .set(auth)
    .send({ amount });
  expect(deposit.status).toBe(201);
  return opened.body.id as string;
}

beforeAll(async () => {
  process.env.DATABASE_URL =
    TEST_DATABASE_URL;
  pool = createPool(process.env.DATABASE_URL);
  await ensureRbacSeeded(pool);
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
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

describe('loans lifecycle', () => {
  it('enforces guarantor + 3x-multiplier limits and disburses onto the ledger', async () => {
    const coop = await onboardCoop('loans');
    const auth = { Authorization: `Bearer ${coop.tokens.accessToken}` };

    // Default products seeded per Decision Log
    const products = await request(app.getHttpServer())
      .get('/api/v1/loans/products')
      .set(auth);
    expect(products.status).toBe(200);
    const productList = products.body as {
      code: string;
      interestRatePa: number;
      multiplier: number;
    }[];
    const cashLoan = productList.find((p) => p.code === 'CASH-LOAN');
    expect(cashLoan).toMatchObject({ interestRatePa: 15, multiplier: 3 });

    // Borrower + two guarantors (all ACTIVE)
    const borrower = await createActiveMember(
      coop,
      'B',
      `borrower-${randomUUID().slice(0, 8)}@coopengine.test`,
    );
    const g1 = await createActiveMember(
      coop,
      'G1',
      `guarantor1-${randomUUID().slice(0, 8)}@coopengine.test`,
    );
    const g2 = await createActiveMember(
      coop,
      'G2',
      `guarantor2-${randomUUID().slice(0, 8)}@coopengine.test`,
    );

    // Fund savings 20,000 -> max loan 60,000 (3x)
    await fundSavings(coop, borrower, 20000);

    // Over-limit application rejected
    const overLimit = await request(app.getHttpServer())
      .post('/api/v1/loans')
      .set(auth)
      .send({
        memberId: borrower,
        productId: cashLoan?.id,
        principal: 65000,
        termMonths: 12,
        guarantorIds: [g1, g2],
      });
    expect(overLimit.status).toBe(400);

    // Too few guarantors rejected
    const fewGuarantors = await request(app.getHttpServer())
      .post('/api/v1/loans')
      .set(auth)
      .send({
        memberId: borrower,
        productId: cashLoan?.id,
        principal: 50000,
        termMonths: 12,
        guarantorIds: [g1],
      });
    expect(fewGuarantors.status).toBe(400);

    // Valid application: 50,000 within the 60,000 limit
    const applied = await request(app.getHttpServer())
      .post('/api/v1/loans')
      .set(auth)
      .send({
        memberId: borrower,
        productId: cashLoan?.id,
        principal: 50000,
        termMonths: 12,
        guarantorIds: [g1, g2],
      });
    expect(applied.status).toBe(201);
    expect(applied.body.status).toBe('PENDING');
    expect(applied.body.interestRatePa).toBe(15);
    const loanId = applied.body.id as string;

    // Guarantors attached
    const guarantors = await request(app.getHttpServer())
      .get(`/api/v1/loans/${loanId}/guarantors`)
      .set(auth);
    expect(guarantors.status).toBe(200);
    expect(guarantors.body).toHaveLength(2);

    // Disbursing before approval -> 409
    const earlyDisburse = await request(app.getHttpServer())
      .post(`/api/v1/loans/${loanId}/disburse`)
      .set(auth);
    expect(earlyDisburse.status).toBe(409);

    // Approve then disburse
    const approved = await request(app.getHttpServer())
      .post(`/api/v1/loans/${loanId}/approve`)
      .set(auth);
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('APPROVED');
    expect(approved.body.approvedAt).toBeTruthy();

    const disbursed = await request(app.getHttpServer())
      .post(`/api/v1/loans/${loanId}/disburse`)
      .set(auth);
    expect(disbursed.status).toBe(200);
    expect(disbursed.body.status).toBe('DISBURSED');
    expect(disbursed.body.outstandingPrincipal).toBe(50000);
    expect(disbursed.body.disbursedAt).toBeTruthy();

    // Ledger: a LOAN_DISBURSEMENT entry was posted; 1020 = +50,000
    const tb = await request(app.getHttpServer())
      .get('/api/v1/ledger/trial-balance')
      .set(auth);
    expect(tb.status).toBe(200);
    expect(tb.body.net).toBe(0);
    const receivable = (tb.body.rows as { code: string; balance: number }[]).find(
      (r) => r.code === '1020',
    );
    expect(receivable?.balance).toBe(50000);

    const journals = await request(app.getHttpServer())
      .get('/api/v1/ledger/journals?status=POSTED')
      .set(auth);
    const sources = (journals.body as { source: string }[]).map((j) => j.source);
    expect(sources).toContain('LOAN_DISBURSEMENT');

    // Double-disburse -> 409
    const reDisburse = await request(app.getHttpServer())
      .post(`/api/v1/loans/${loanId}/disburse`)
      .set(auth);
    expect(reDisburse.status).toBe(409);
  });

  it('rejects with reason and isolates loans between cooperatives', async () => {
    const coopA = await onboardCoop('loan-a');
    const coopB = await onboardCoop('loan-b');

    // A rejected loan in A
    const borrower = await createActiveMember(
      coopA,
      'R',
      `reject-${randomUUID().slice(0, 8)}@coopengine.test`,
    );
    const g1 = await createActiveMember(
      coopA,
      'RG1',
      `rg1-${randomUUID().slice(0, 8)}@coopengine.test`,
    );
    const g2 = await createActiveMember(
      coopA,
      'RG2',
      `rg2-${randomUUID().slice(0, 8)}@coopengine.test`,
    );
    await fundSavings(coopA, borrower, 10000);
    const productsA = await request(app.getHttpServer())
      .get('/api/v1/loans/products')
      .set({ Authorization: `Bearer ${coopA.tokens.accessToken}` });
    const cashLoanA = (productsA.body as { id: string }[])[0];

    const applied = await request(app.getHttpServer())
      .post('/api/v1/loans')
      .set({ Authorization: `Bearer ${coopA.tokens.accessToken}` })
      .send({
        memberId: borrower,
        productId: cashLoanA.id,
        principal: 10000,
        termMonths: 6,
        guarantorIds: [g1, g2],
      });
    expect(applied.status).toBe(201);
    const loanAId = applied.body.id as string;

    // Reject without reason -> 400
    const noReason = await request(app.getHttpServer())
      .post(`/api/v1/loans/${loanAId}/reject`)
      .set({ Authorization: `Bearer ${coopA.tokens.accessToken}` })
      .send({});
    expect(noReason.status).toBe(400);

    const rejected = await request(app.getHttpServer())
      .post(`/api/v1/loans/${loanAId}/reject`)
      .set({ Authorization: `Bearer ${coopA.tokens.accessToken}` })
      .send({ reason: 'Insufficient savings history' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe('REJECTED');
    expect(rejected.body.rejectionReason).toBe('Insufficient savings history');

    // Coop B cannot see or act on A's loan
    const bAuth = { Authorization: `Bearer ${coopB.tokens.accessToken}` };
    const crossRead = await request(app.getHttpServer())
      .get(`/api/v1/loans/${loanAId}`)
      .set(bAuth);
    expect(crossRead.status).toBe(404);

    const crossApprove = await request(app.getHttpServer())
      .post(`/api/v1/loans/${loanAId}/approve`)
      .set(bAuth);
    expect(crossApprove.status).toBe(404);
  });
});
