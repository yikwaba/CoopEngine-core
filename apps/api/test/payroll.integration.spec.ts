/**
 * Payroll deduction import + savings reconciliation integration tests.
 *
 * Proves: CSV preview control totals (unknown/inactive/duplicate members),
 * commit auto-posting ONE balanced batch journal (Dr 1000 total / Cr 2000
 * per member) with account auto-open for new members, idempotent commit
 * guard, and a reconciliation report with ZERO mismatches.
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

async function activeMemberWithNo(
  coop: CoopCtx,
  seed: string,
): Promise<{ id: string; memberNo: number }> {
  const auth = { Authorization: `Bearer ${coop.tokens.accessToken}` };
  const created = await request(app.getHttpServer())
    .post('/api/v1/members')
    .set(auth)
    .send({
      firstName: `Pay${seed}`,
      lastName: 'Member',
      email: `pay-${seed}-${randomUUID().slice(0, 8)}@coopengine.test`,
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
    await pool.query(`DELETE FROM sessions`);
    await pool.end();
  }
  if (app) await app.close();
});

describe('payroll deduction import', () => {
  it('previews with control totals, commits one balanced batch journal, reconciles clean', async () => {
    const coop = await onboardCoop('payroll');
    const auth = { Authorization: `Bearer ${coop.tokens.accessToken}` };

    const m1 = await activeMemberWithNo(coop, 'P1');
    const m2 = await activeMemberWithNo(coop, 'P2');

    // Give member 1 an existing savings balance via a normal deposit
    const opened = await request(app.getHttpServer())
      .post(`/api/v1/savings/member/${m1.id}/account`)
      .set(auth)
      .send({});
    const account1Id = opened.body.id as string;
    await request(app.getHttpServer())
      .post(`/api/v1/savings/accounts/${account1Id}/deposits`)
      .set(auth)
      .send({ amount: 5000 });

    // CSV: 2 valid + 1 unknown memberNo + 1 duplicate of member 1
    const csv = [
      'memberNo,amount',
      `${m1.memberNo},15000`,
      `${m2.memberNo},20000`,
      `999999,5000`,
      `${m1.memberNo},100`,
    ].join('\n');

    const preview = await request(app.getHttpServer())
      .post('/api/v1/payroll/import/preview')
      .set(auth)
      .send({ filename: 'august-deductions.csv', csv });
    expect(preview.status).toBe(201);
    expect(preview.body.totals).toMatchObject({ totalRows: 4, valid: 2, invalid: 2 });
    expect(preview.body.totals.totalAmount).toBe(35000);
    const batchId = preview.body.batchId as string;

    // Commit -> member 2's account is auto-opened
    const commit = await request(app.getHttpServer())
      .post('/api/v1/payroll/import/commit')
      .set(auth)
      .send({ batchId });
    expect(commit.status).toBe(200);
    expect(commit.body).toMatchObject({ committed: 2, totalAmount: 35000 });

    // Balances: m1 = 5000 + 15000 = 20000; m2 = 20000 (auto-opened)
    const a1 = await request(app.getHttpServer())
      .get(`/api/v1/savings/accounts/${account1Id}`)
      .set(auth);
    expect(a1.body.currentBalance).toBe(20000);
    const m2accounts = await request(app.getHttpServer())
      .get(`/api/v1/savings/member/${m2.id}/accounts`)
      .set(auth);
    expect(m2accounts.body).toHaveLength(1);
    expect(m2accounts.body[0].currentBalance).toBe(20000);

    // Ledger: exactly one PAYROLL_DEDUCTION entry with 3 lines (Dr + 2 Cr)
    const journals = await request(app.getHttpServer())
      .get('/api/v1/ledger/journals?status=POSTED')
      .set(auth);
    const payrollEntries = (journals.body as { source: string; id: string }[]).filter(
      (j) => j.source === 'PAYROLL_DEDUCTION',
    );
    expect(payrollEntries).toHaveLength(1);
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/ledger/journals/${payrollEntries[0].id}`)
      .set(auth);
    const lines = (detail.body as { lines: { debit: number; credit: number }[] }).lines;
    expect(lines).toHaveLength(3);
    const debitTotal = lines.reduce((a, l) => a + l.debit, 0);
    const creditTotal = lines.reduce((a, l) => a + l.credit, 0);
    expect(debitTotal).toBe(35000);
    expect(creditTotal).toBe(35000);

    // Double-commit -> 409
    const again = await request(app.getHttpServer())
      .post('/api/v1/payroll/import/commit')
      .set(auth)
      .send({ batchId });
    expect(again.status).toBe(409);

    // Reconciliation: every account matches the ledger
    const reconcile = await request(app.getHttpServer())
      .get('/api/v1/reports/savings-reconciliation')
      .set(auth);
    expect(reconcile.status).toBe(200);
    expect(reconcile.body.checked).toBe(2);
    expect(reconcile.body.matched).toBe(2);
    expect(reconcile.body.mismatches).toEqual([]);
  });
});
