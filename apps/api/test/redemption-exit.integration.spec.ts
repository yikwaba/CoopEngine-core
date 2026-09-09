/**
 * Share redemption + member exit integration tests (real PostgreSQL).
 *
 * Proves: share redemption posts Dr 3000 / Cr 1000 and reduces the balance;
 * over-redemption is rejected; full member exit is blocked while loans are
 * open, then pays out savings + shares in one balanced journal and closes
 * accounts (status EXITED, zero balances); pagination returns X-Total-Count.
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

async function createActiveMember(
  coop: CoopCtx,
  seed: string,
): Promise<{ id: string; memberNo: number }> {
  const auth = { Authorization: `Bearer ${coop.tokens.accessToken}` };
  const created = await request(app.getHttpServer())
    .post('/api/v1/members')
    .set(auth)
    .send({ firstName: `Exit${seed}`, lastName: 'Member', email: `exit-${seed}-${randomUUID().slice(0, 6)}@coopengine.test` });
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

describe('share redemption and member exit', () => {
  it('redeems shares with a balanced journal and guards the balance', async () => {
    const coop = await onboardCoop('redeem');
    const auth = { Authorization: `Bearer ${coop.tokens.accessToken}` };
    const member = await createActiveMember(coop, 'R');

    // Buy 10,000 shares
    const buy = await request(app.getHttpServer())
      .post(`/api/v1/shares/member/${member.id}/purchases`)
      .set(auth)
      .send({ amount: 10000 });
    expect(buy.status).toBe(201);
    expect(buy.body.currentBalance).toBe(10000);

    // Redeem 4,000 -> 6,000 remaining
    const redeem = await request(app.getHttpServer())
      .post(`/api/v1/shares/member/${member.id}/redemptions`)
      .set(auth)
      .send({ amount: 4000 });
    expect(redeem.status).toBe(201);
    expect(redeem.body.currentBalance).toBe(6000);

    // Over-redemption rejected
    const over = await request(app.getHttpServer())
      .post(`/api/v1/shares/member/${member.id}/redemptions`)
      .set(auth)
      .send({ amount: 6001 });
    expect(over.status).toBe(400);

    // Ledger: share capital 3000 net -6000, cash 1000 net +4000 (purchase+redemption)
    const tb = await request(app.getHttpServer())
      .get('/api/v1/ledger/trial-balance')
      .set(auth);
    expect(tb.status).toBe(200);
    const rows = tb.body.rows as { code: string; balance: number }[];
    const equity = rows.find((r) => r.code === '3000');
    const cash = rows.find((r) => r.code === '1000');
    expect(equity?.balance).toBe(-6000);
    expect(cash?.balance).toBe(6000);
    expect(tb.body.net).toBe(0);
  });

  it('blocks exit on open loans, then pays out and closes accounts', async () => {
    const coop = await onboardCoop('ex');
    const auth = { Authorization: `Bearer ${coop.tokens.accessToken}` };
    const debtor = await createActiveMember(coop, 'D');
    const leaver = await createActiveMember(coop, 'L');

    // Fund the leaver: savings 30,000 + shares 10,000
    const opened = await request(app.getHttpServer())
      .post(`/api/v1/savings/member/${leaver.id}/account`)
      .set(auth)
      .send({});
    const savingsId = opened.body.id as string;
    await request(app.getHttpServer())
      .post(`/api/v1/savings/accounts/${savingsId}/deposits`)
      .set(auth)
      .send({ amount: 30000 });
    await request(app.getHttpServer())
      .post(`/api/v1/shares/member/${leaver.id}/purchases`)
      .set(auth)
      .send({ amount: 10000 });

    // Give the debtor an open loan (needs 2 guarantors + savings for the 3x rule)
    const debtSav = await request(app.getHttpServer())
      .post(`/api/v1/savings/member/${debtor.id}/account`)
      .set(auth)
      .send({});
    await request(app.getHttpServer())
      .post(`/api/v1/savings/accounts/${debtSav.body.id as string}/deposits`)
      .set(auth)
      .send({ amount: 20000 });
    const g2 = await createActiveMember(coop, 'G2');
    const products = await request(app.getHttpServer()).get('/api/v1/loans/products').set(auth);
    const cashLoan = (products.body as { code: string; id: string }[]).find(
      (p) => p.code === 'CASH-LOAN',
    ) as { id: string };
    const apply = await request(app.getHttpServer())
      .post('/api/v1/loans')
      .set(auth)
      .send({
        memberId: debtor.id,
        productId: cashLoan.id,
        principal: 15000,
        termMonths: 3,
        guarantorIds: [leaver.id, g2.id],
      });
    expect(apply.status).toBe(201);
    const loanId = apply.body.id as string;
    await request(app.getHttpServer())
      .post(`/api/v1/loans/${loanId}/approve`)
      .set(auth)
      .send({});
    await request(app.getHttpServer())
      .post(`/api/v1/loans/${loanId}/disburse`)
      .set(auth)
      .send({});

    // Exit blocked while the debtor's loan is open (debtor is a guarantor too,
    // but the block keyed on the debtor's OWN loan membership)
    const blocked = await request(app.getHttpServer())
      .post(`/api/v1/members/${debtor.id}/exit`)
      .set(auth);
    expect(blocked.status).toBe(409);

    // Leaver exits cleanly with a full payout
    const exit = await request(app.getHttpServer())
      .post(`/api/v1/members/${leaver.id}/exit`)
      .set(auth);
    expect(exit.status).toBe(200);
    expect(exit.body.member.status).toBe('EXITED');
    expect(exit.body.payout).toBe(40000);
    expect(exit.body.closedAccounts).toBe(2);

    // Balances zeroed + closed
    const acc = await request(app.getHttpServer())
      .get(`/api/v1/savings/accounts/${savingsId}`)
      .set(auth);
    expect(acc.body.currentBalance).toBe(0);
    expect(acc.body.status).toBe('CLOSED');
    const shareAcc = await request(app.getHttpServer())
      .get(`/api/v1/shares/member/${leaver.id}`)
      .set(auth);
    expect(shareAcc.body.currentBalance).toBe(0);
    expect(shareAcc.body.status).toBe('CLOSED');

    // Trial balance nets to zero after the payout journal
    const tb = await request(app.getHttpServer())
      .get('/api/v1/ledger/trial-balance')
      .set(auth);
    expect(tb.body.net).toBe(0);
  });

  it('paginates the member list with X-Total-Count', async () => {
    const coop = await onboardCoop('page');
    const auth = { Authorization: `Bearer ${coop.tokens.accessToken}` };
    await createActiveMember(coop, 'P1');
    await createActiveMember(coop, 'P2');
    await createActiveMember(coop, 'P3');

    const page = await request(app.getHttpServer())
      .get('/api/v1/members?limit=2&offset=0')
      .set(auth);
    expect(page.status).toBe(200);
    expect(page.body).toHaveLength(2);
    expect(page.headers['x-total-count']).toBe('3');

    const second = await request(app.getHttpServer())
      .get('/api/v1/members?limit=2&offset=2')
      .set(auth);
    expect(second.body).toHaveLength(1);
    expect(second.body[0].memberNo).toBe(3);

    // Search narrows the result set and total
    const search = await request(app.getHttpServer())
      .get('/api/v1/members?q=ExitP3')
      .set(auth);
    expect(search.status).toBe(200);
    expect(search.headers['x-total-count']).toBe('1');
    expect(search.body).toHaveLength(1);
    expect(search.body[0].memberNo).toBe(3);
  });
});
