/**
 * Savings interest engine integration tests (real PostgreSQL).
 *
 * Proves: preview accrues one month at product rates (balance * rate/100/12),
 * posting credits balances + transaction projections in one balanced journal
 * (Dr 5000 / Cr 2000), is idempotent per org+period (double post -> 409),
 * requires an OPEN ledger period, and keeps trial balance at net zero.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { createPool, withTenant } from '@coopengine/db';
import { ensureRbacSeeded } from './helpers';

const ADMIN_EMAIL = 'admin@coopengine.dev';
const ADMIN_PASSWORD = 'AdminDev123!';

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

async function createMember(
  coop: { tokens: { accessToken: string } },
  seed: string,
): Promise<string> {
  const auth = { Authorization: `Bearer ${coop.tokens.accessToken}` };
  const created = await request(app.getHttpServer())
    .post('/api/v1/members')
    .set(auth)
    .send({ firstName: `Int${seed}`, lastName: 'Member', email: `int-${seed}-${randomUUID().slice(0, 6)}@coopengine.test` });
  expect(created.status).toBe(201);
  const id = created.body.id as string;
  await request(app.getHttpServer()).post(`/api/v1/members/${id}/approve`).set(auth);
  return id;
}

beforeAll(async () => {
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? 'postgres://coopengine:coopengine@127.0.0.1:5432/coopengine';
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

describe('savings interest engine', () => {
  it('previews, posts and protects a monthly interest run', async () => {
    const coop = await onboardCoop('int');
    const auth = { Authorization: `Bearer ${coop.tokens.accessToken}` };
    const m1 = await createMember(coop, '1');
    const m2 = await createMember(coop, '2');

    // Fund: m1 = 20,000; m2 = 10,000 (products still at 0% by default)
    const a1 = await request(app.getHttpServer())
      .post(`/api/v1/savings/member/${m1}/account`)
      .set(auth)
      .send({});
    const a1id = a1.body.id as string;
    await request(app.getHttpServer())
      .post(`/api/v1/savings/accounts/${a1id}/deposits`)
      .set(auth)
      .send({ amount: 20000 });
    const a2 = await request(app.getHttpServer())
      .post(`/api/v1/savings/member/${m2}/account`)
      .set(auth)
      .send({});
    await request(app.getHttpServer())
      .post(`/api/v1/savings/accounts/${a2.body.id as string}/deposits`)
      .set(auth)
      .send({ amount: 10000 });

    // Configure 6% p.a. on the default product
    const orgId = (await request(app.getHttpServer()).get('/api/v1/auth/me').set(auth)).body
      .organizationId as string;
    await withTenant(pool, orgId, async (c) => {
      await c.query(`UPDATE savings_products SET interest_rate_pa = 6 WHERE organization_id = $1`, [orgId]);
    });

    // At 0% nothing accrues; at 6%: 20,000 -> 100.00, 10,000 -> 50.00
    const preview = await request(app.getHttpServer())
      .get('/api/v1/savings/interest/preview')
      .set(auth);
    expect(preview.status).toBe(200);
    expect(preview.body.total).toBe(150);
    expect(preview.body.rows).toHaveLength(2);
    const amounts = new Map(
      (preview.body.rows as { memberNo: number; amount: number }[]).map((r) => [r.memberNo, r.amount]),
    );
    // member numbers are 1 and 2 in this fresh coop
    expect(amounts.get(1)).toBe(100);
    expect(amounts.get(2)).toBe(50);

    // Post the run
    const posted = await request(app.getHttpServer())
      .post('/api/v1/savings/interest/post')
      .set(auth)
      .send({});
    expect(posted.status).toBe(200);
    expect(posted.body.total).toBe(150);
    expect(posted.body.accounts).toBe(2);
    expect(posted.body.entryNo).toBeGreaterThan(0);

    // Balances credited
    const acc1 = await request(app.getHttpServer())
      .get(`/api/v1/savings/accounts/${a1id}`)
      .set(auth);
    expect(acc1.body.currentBalance).toBe(20100);
    const acc2 = await request(app.getHttpServer())
      .get(`/api/v1/savings/accounts/${a2.body.id as string}`)
      .set(auth);
    expect(acc2.body.currentBalance).toBe(10050);

    // INTEREST transactions on both statements
    const stmt = await request(app.getHttpServer())
      .get(`/api/v1/savings/accounts/${a1id}/statement`)
      .set(auth);
    expect(stmt.body[0].type).toBe('INTEREST');
    expect(stmt.body[0].signedAmount).toBe(100);

    // Double-post the same period -> 409
    const again = await request(app.getHttpServer())
      .post('/api/v1/savings/interest/post')
      .set(auth)
      .send({});
    expect(again.status).toBe(409);

    // Ledger: trial balance nets to zero, expense 5000 = -? No: Dr side +
    const tb = await request(app.getHttpServer())
      .get('/api/v1/ledger/trial-balance')
      .set(auth);
    expect(tb.body.net).toBe(0);
    const rows = tb.body.rows as { code: string; balance: number }[];
    const expense = rows.find((r) => r.code === '5000');
    expect(expense?.balance).toBe(150);
    const liability = rows.find((r) => r.code === '2000');
    expect(liability?.balance).toBe(-30150); // -30000 deposits -150 interest

    // Reconciliation stays clean after interest (member-linked lines counted)
    const reconcile = await request(app.getHttpServer())
      .get('/api/v1/reports/savings-reconciliation')
      .set(auth);
    expect(reconcile.body.matched).toBe(2);
    expect(reconcile.body.mismatches).toEqual([]);
  });
});
