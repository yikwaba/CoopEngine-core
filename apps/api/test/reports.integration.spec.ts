/**
 * Reports + audit integration tests (real PostgreSQL).
 *
 * Builds a full coop (member + savings + shares + disbursed loan) and asserts
 * member 360, savings book, loan book, and tenant-scoped audit logs.
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

async function member(coop: { tokens: { accessToken: string } }, seed: string): Promise<string> {
  const auth = { Authorization: `Bearer ${coop.tokens.accessToken}` };
  const created = await request(app.getHttpServer())
    .post('/api/v1/members')
    .set(auth)
    .send({
      firstName: `Report${seed}`,
      lastName: 'Member',
      email: `rpt-${seed}-${randomUUID().slice(0, 8)}@coopengine.test`,
    });
  expect(created.status).toBe(201);
  const id = created.body.id as string;
  await request(app.getHttpServer()).post(`/api/v1/members/${id}/approve`).set(auth);
  return id;
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

describe('reports and audit', () => {
  it('member 360, savings book and loan book reflect real activity', async () => {
    const coop = await onboardCoop('rpt');
    const auth = { Authorization: `Bearer ${coop.tokens.accessToken}` };
    const borrower = await member(coop, 'B');

    // Savings 30,000 + shares 10,000
    const opened = await request(app.getHttpServer())
      .post(`/api/v1/savings/member/${borrower}/account`)
      .set(auth)
      .send({});
    await request(app.getHttpServer())
      .post(`/api/v1/savings/accounts/${opened.body.id as string}/deposits`)
      .set(auth)
      .send({ amount: 30000 });
    await request(app.getHttpServer())
      .post(`/api/v1/shares/member/${borrower}/purchases`)
      .set(auth)
      .send({ amount: 10000 });

    // Disburse a 20,000 cash loan (needs guarantors)
    const g1 = await member(coop, 'G1');
    const g2 = await member(coop, 'G2');
    const products = await request(app.getHttpServer()).get('/api/v1/loans/products').set(auth);
    const cashLoan = (products.body as { code: string; id: string }[]).find(
      (p) => p.code === 'CASH-LOAN',
    ) as { id: string };
    const applied = await request(app.getHttpServer())
      .post('/api/v1/loans')
      .set(auth)
      .send({ memberId: borrower, productId: cashLoan.id, principal: 20000, termMonths: 6, guarantorIds: [g1, g2] });
    expect(applied.status).toBe(201);
    const loanId = applied.body.id as string;
    await request(app.getHttpServer()).post(`/api/v1/loans/${loanId}/approve`).set(auth);
    await request(app.getHttpServer()).post(`/api/v1/loans/${loanId}/disburse`).set(auth);

    // Member 360
    const threesixty = await request(app.getHttpServer())
      .get(`/api/v1/reports/member/${borrower}/360`)
      .set(auth);
    expect(threesixty.status).toBe(200);
    const b360 = threesixty.body as {
      member: { status: string };
      savingsTotal: number;
      shareBalance: number;
      loansOutstandingTotal: number;
      savings: unknown[];
    };
    expect(b360.member.status).toBe('ACTIVE');
    expect(b360.savings).toHaveLength(1);
    expect(b360.savingsTotal).toBe(30000);
    expect(b360.shareBalance).toBe(10000);
    expect(b360.loansOutstandingTotal).toBe(20000);

    // Savings book (only the borrower holds an account)
    const book = await request(app.getHttpServer())
      .get('/api/v1/reports/savings-book')
      .set(auth);
    expect(book.status).toBe(200);
    expect(book.body.totalBalance).toBe(30000);
    expect(book.body.totalMembers).toBe(1);

    // Loan book
    const loanBook = await request(app.getHttpServer())
      .get('/api/v1/reports/loan-book')
      .set(auth);
    expect(loanBook.status).toBe(200);
    expect(loanBook.body.outstandingTotal).toBe(20000);
    expect(loanBook.body.disbursedCount).toBe(1);
  });

  it('audit logs are tenant-scoped and filterable by action', async () => {
    const coopA = await onboardCoop('aud-a');
    const coopB = await onboardCoop('aud-b');
    const aAuth = { Authorization: `Bearer ${coopA.tokens.accessToken}` };
    const bAuth = { Authorization: `Bearer ${coopB.tokens.accessToken}` };

    // Coop A does some activity
    const borrower = await member(coopA, 'A');
    const g1 = await member(coopA, 'AG1');
    const g2 = await member(coopA, 'AG2');
    const openedA = await request(app.getHttpServer())
      .post(`/api/v1/savings/member/${borrower}/account`)
      .set(aAuth)
      .send({});
    await request(app.getHttpServer())
      .post(`/api/v1/savings/accounts/${openedA.body.id as string}/deposits`)
      .set(aAuth)
      .send({ amount: 5000 });
    const products = await request(app.getHttpServer()).get('/api/v1/loans/products').set(aAuth);
    const cashLoan = (products.body as { code: string; id: string }[]).find((p) => p.code === 'CASH-LOAN') as { id: string };
    const applied = await request(app.getHttpServer())
      .post('/api/v1/loans')
      .set(aAuth)
      .send({ memberId: borrower, productId: cashLoan.id, principal: 5000, termMonths: 3, guarantorIds: [g1, g2] });
    await request(app.getHttpServer()).post(`/api/v1/loans/${applied.body.id as string}/approve`).set(aAuth);
    await request(app.getHttpServer()).post(`/api/v1/loans/${applied.body.id as string}/disburse`).set(aAuth);

    // A sees its own audit events
    const logs = await request(app.getHttpServer())
      .get('/api/v1/reports/audit-logs?action=loan.status.disbursed')
      .set(aAuth);
    expect(logs.status).toBe(200);
    const rows = logs.body as { action: string; entityType: string | null }[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.action === 'loan.status.disbursed')).toBe(true);

    // B sees none of A's events (tenant filter on a non-RLS table)
    const bLogs = await request(app.getHttpServer())
      .get('/api/v1/reports/audit-logs?action=loan.status.disbursed')
      .set(bAuth);
    expect(bLogs.status).toBe(200);
    expect((bLogs.body as unknown[]).length).toBe(0);
  });
});
