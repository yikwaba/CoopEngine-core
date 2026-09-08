/**
 * Savings module integration tests (real PostgreSQL).
 *
 * Proves: default product seeded, account opening, deposits/withdrawals that
 * AUTO-POST balanced journals to the ledger (entry numbers increment),
 * balance + statement consistency, overdraft rejection, idempotency-key
 * dedupe, and cross-tenant account isolation.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { createPool } from '@coopengine/db';
import { ensureRbacSeeded } from './helpers';

const ADMIN_EMAIL = 'admin@coopengine.dev';
const ADMIN_PASSWORD = 'AdminDev123!';

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

async function createApprovedMember(
  coop: CoopCtx,
  seed: string,
): Promise<{ id: string }> {
  const auth = { Authorization: `Bearer ${coop.tokens.accessToken}` };
  const created = await request(app.getHttpServer())
    .post('/api/v1/members')
    .set(auth)
    .send({
      firstName: `Sav${seed}`,
      lastName: `Member${seed}`,
      email: `savings-${seed.toLowerCase()}@coopengine.test`,
    });
  expect(created.status).toBe(201);
  const memberId = created.body.id as string;
  const approved = await request(app.getHttpServer())
    .post(`/api/v1/members/${memberId}/approve`)
    .set(auth);
  expect(approved.status).toBe(200);
  return { id: memberId };
}

beforeAll(async () => {
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ??
    'postgres://coopengine:coopengine@127.0.0.1:5432/coopengine';
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

describe('savings on the ledger', () => {
  it('deposits and withdrawals post balanced journals and keep balances', async () => {
    const coop = await onboardCoop('svgs');
    const auth = { Authorization: `Bearer ${coop.tokens.accessToken}` };

    // Default product exists
    const products = await request(app.getHttpServer())
      .get('/api/v1/savings/products')
      .set(auth);
    expect(products.status).toBe(200);
    const productList = products.body as { code: string }[];
    expect(productList.some((p) => p.code === 'REGULAR-SAVINGS')).toBe(true);

    // Member + account
    const member = await createApprovedMember(coop, 'A');
    const opened = await request(app.getHttpServer())
      .post(`/api/v1/savings/member/${member.id}/account`)
      .set(auth)
      .send({});
    expect(opened.status).toBe(201);
    expect(opened.body.accountNo).toBe(1);
    expect(opened.body.currentBalance).toBe(0);
    const accountId = opened.body.id as string;

    // Deposit 50,000
    const deposit = await request(app.getHttpServer())
      .post(`/api/v1/savings/accounts/${accountId}/deposits`)
      .set(auth)
      .send({
        amount: 50000,
        description: 'Monthly contribution',
        idempotencyKey: `dep-${randomUUID().slice(0, 14)}`,
      });
    expect(deposit.status).toBe(201);
    expect(deposit.body.currentBalance).toBe(50000);

    // Deposit again (no key) -> 100,000
    await request(app.getHttpServer())
      .post(`/api/v1/savings/accounts/${accountId}/deposits`)
      .set(auth)
      .send({ amount: 50000 });
    const afterTwo = await request(app.getHttpServer())
      .get(`/api/v1/savings/accounts/${accountId}`)
      .set(auth);
    expect(afterTwo.body.currentBalance).toBe(100000);

    // Withdraw 20,000
    const withdraw = await request(app.getHttpServer())
      .post(`/api/v1/savings/accounts/${accountId}/withdrawals`)
      .set(auth)
      .send({ amount: 20000, description: 'Emergency withdrawal' });
    expect(withdraw.status).toBe(200);
    expect(withdraw.body.currentBalance).toBe(80000);

    // Ledger: three POSTED entries, sequential numbers, balanced
    const journals = await request(app.getHttpServer())
      .get('/api/v1/ledger/journals?status=POSTED')
      .set(auth);
    expect(journals.status).toBe(200);
    const posted = journals.body as { entryNo: number; source: string }[];
    expect(posted).toHaveLength(3);
    expect(posted.map((j) => j.entryNo).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(posted.every((j) => j.source.startsWith('SAVINGS_'))).toBe(true);

    // Trial balance: net zero; Member Savings Deposits = -80,000
    const tb = await request(app.getHttpServer())
      .get('/api/v1/ledger/trial-balance')
      .set(auth);
    expect(tb.status).toBe(200);
    expect(tb.body.net).toBe(0);
    const savingsLine = (tb.body.rows as { code: string; balance: number }[]).find(
      (r) => r.code === '2000',
    );
    expect(savingsLine?.balance).toBe(-80000);

    // Statement: 3 txns, running balances consistent
    const statement = await request(app.getHttpServer())
      .get(`/api/v1/savings/accounts/${accountId}/statement`)
      .set(auth);
    expect(statement.status).toBe(200);
    const txns = statement.body as { type: string; signedAmount: number; runningBalance: number }[];
    expect(txns).toHaveLength(3);
    expect(txns[0]).toMatchObject({ type: 'WITHDRAWAL', signedAmount: -20000, runningBalance: 80000 });
    expect(txns[2]).toMatchObject({ type: 'DEPOSIT', signedAmount: 50000, runningBalance: 50000 });
  });

  it('rejects overdrafts, invalid amounts and duplicate idempotency keys', async () => {
    const coop = await onboardCoop('svgs-x');
    const auth = { Authorization: `Bearer ${coop.tokens.accessToken}` };
    const member = await createApprovedMember(coop, 'X');
    const opened = await request(app.getHttpServer())
      .post(`/api/v1/savings/member/${member.id}/account`)
      .set(auth)
      .send({});
    const accountId = opened.body.id as string;

    // Withdraw with zero balance -> 400
    const empty = await request(app.getHttpServer())
      .post(`/api/v1/savings/accounts/${accountId}/withdrawals`)
      .set(auth)
      .send({ amount: 1000 });
    expect(empty.status).toBe(400);

    const key = `svgs-key-${randomUUID().slice(0, 12)}`;
    const dep1 = await request(app.getHttpServer())
      .post(`/api/v1/savings/accounts/${accountId}/deposits`)
      .set(auth)
      .send({ amount: 1000, idempotencyKey: key });
    expect(dep1.status).toBe(201);

    // Same key replayed -> 409, balance unchanged
    const dep2 = await request(app.getHttpServer())
      .post(`/api/v1/savings/accounts/${accountId}/deposits`)
      .set(auth)
      .send({ amount: 5000, idempotencyKey: key });
    expect(dep2.status).toBe(409);
    const account = await request(app.getHttpServer())
      .get(`/api/v1/savings/accounts/${accountId}`)
      .set(auth);
    expect(account.body.currentBalance).toBe(1000);

    // Invalid amount -> 400
    const bad = await request(app.getHttpServer())
      .post(`/api/v1/savings/accounts/${accountId}/deposits`)
      .set(auth)
      .send({ amount: -5 });
    expect(bad.status).toBe(400);
  });

  it('isolates savings accounts between cooperatives', async () => {
    const coopA = await onboardCoop('iso-s-a');
    const coopB = await onboardCoop('iso-s-b');
    const memberA = await createApprovedMember(coopA, 'IsoA');
    const openedA = await request(app.getHttpServer())
      .post(`/api/v1/savings/member/${memberA.id}/account`)
      .set({ Authorization: `Bearer ${coopA.tokens.accessToken}` })
      .send({});
    const accountAId = openedA.body.id as string;

    // Org B cannot read, deposit to, or withdraw from A's account
    const bAuth = { Authorization: `Bearer ${coopB.tokens.accessToken}` };
    const crossRead = await request(app.getHttpServer())
      .get(`/api/v1/savings/accounts/${accountAId}`)
      .set(bAuth);
    expect(crossRead.status).toBe(404);

    const crossDep = await request(app.getHttpServer())
      .post(`/api/v1/savings/accounts/${accountAId}/deposits`)
      .set(bAuth)
      .send({ amount: 100 });
    expect(crossDep.status).toBe(404);

    const crossStmt = await request(app.getHttpServer())
      .get(`/api/v1/savings/accounts/${accountAId}/statement`)
      .set(bAuth);
    expect(crossStmt.status).toBe(404);
  });
});
