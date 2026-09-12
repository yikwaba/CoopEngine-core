/**
 * Monnify virtual-account payments integration tests (real PostgreSQL).
 *
 * Proves: virtual-account creation (dev provider), signature-verified
 * webhooks auto-posting Dr 1000 / Cr 2000 to the ledger (auto-opening the
 * member savings account), duplicate delivery idempotency, bad-signature
 * rejection, unknown-account silent acknowledgement, and reconciliation.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { createPool } from '@coopengine/db';
import { ensureRbacSeeded, ADMIN_PASSWORD, TEST_DATABASE_URL } from './helpers';

const ADMIN_EMAIL = 'admin@coopengine.dev';
const MONNIFY_SECRET = 'monnify-dev-secret'; // dev fallback used by the service

let app: INestApplication;
let pool: Pool;

const sign = (rawBody: string): string =>
  createHash('sha512').update(`${MONNIFY_SECRET}|${rawBody}`).digest('hex');

async function onboardCoop(label: string): Promise<{
  tokens: { accessToken: string };
  slug: string;
}> {
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
    slug: onboard.body.slug as string,
  };
}

async function createActiveMember(
  coop: { tokens: { accessToken: string } },
  seed: string,
  email?: string,
): Promise<string> {
  const auth = { Authorization: `Bearer ${coop.tokens.accessToken}` };
  const created = await request(app.getHttpServer())
    .post('/api/v1/members')
    .set(auth)
    .send({ firstName: `Pay${seed}`, lastName: 'Member', email: email ?? `pay-${seed}-${randomUUID().slice(0, 6)}@coopengine.test` });
  expect(created.status).toBe(201);
  const id = created.body.id as string;
  await request(app.getHttpServer()).post(`/api/v1/members/${id}/approve`).set(auth);
  return id;
}

function webhookPayload(
  accountNumber: string,
  paymentReference: string,
  amount: number,
): Record<string, unknown> {
  return {
    eventType: 'SUCCESSFUL_TRANSACTION',
    eventData: {
      product: { type: 'RESERVED_ACCOUNT' },
      transactionReference: `TXN-${paymentReference}`,
      paymentReference,
      amountPaid: amount,
      totalPayable: amount,
      paidOn: new Date().toISOString(),
      paymentStatus: 'PAID',
      paymentDescription: 'Virtual account funding',
      transactionStatus: 'SUCCESSFUL',
      settlementAmount: amount,
      currency: 'NGN',
      paymentMethod: 'ACCOUNT_TRANSFER',
      customer: { email: 'member@example.com', name: 'Pay Member' },
    },
    accountNumber,
    accountReference: `VA-${randomUUID().slice(0, 8)}`,
    amountPaid: amount,
    transactionReference: `TXN-${paymentReference}`,
    paymentReference,
    transactionStatus: 'SUCCESSFUL',
    currency: 'NGN',
  };
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

describe('virtual-account payments', () => {
  it('creates accounts and auto-posts signature-verified webhooks', async () => {
    const coop = await onboardCoop('mny');
    const auth = { Authorization: `Bearer ${coop.tokens.accessToken}` };
    const memberEmail = `pay-${coop.slug}@coopengine.test`;
    const memberId = await createActiveMember(coop, 'V', memberEmail);

    // Create a virtual account (dev provider)
    const created = await request(app.getHttpServer())
      .post('/api/v1/payments/virtual-accounts')
      .set(auth)
      .send({ memberId });
    expect(created.status).toBe(201);
    expect(created.body.accountNumber).toMatch(/^8\d{9}$/);
    expect(created.body.provider).toBe('dev');
    const accountNumber = created.body.accountNumber as string;

    // Duplicate creation rejected
    const again = await request(app.getHttpServer())
      .post('/api/v1/payments/virtual-accounts')
      .set(auth)
      .send({ memberId });
    expect(again.status).toBe(409);

    // Listed
    const listed = await request(app.getHttpServer())
      .get('/api/v1/payments/virtual-accounts')
      .set(auth);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0].memberNo).toBe(1);

    // Bad signature -> 400
    const bad = await request(app.getHttpServer())
      .post('/api/v1/payments/monnify/webhook')
      .set('monnify-signature', 'deadbeef')
      .send(webhookPayload(accountNumber, 'PAY-1', 25000));
    expect(bad.status).toBe(400);

    // Valid webhook: 25,000 into the (auto-opened) savings account
    const rawBody = JSON.stringify(webhookPayload(accountNumber, 'PAY-1', 25000));
    const good = await request(app.getHttpServer())
      .post('/api/v1/payments/monnify/webhook')
      .set('monnify-signature', sign(rawBody))
      .send(JSON.parse(rawBody));
    expect(good.status).toBe(200);
    expect(good.body.acknowledged).toBe(true);

    // Member 360 shows the auto-created savings account funded
    const m360 = await request(app.getHttpServer())
      .get(`/api/v1/reports/member/${memberId}/360`)
      .set(auth);
    expect(m360.body.savingsTotal).toBe(25000);

    // Duplicate delivery of the same paymentReference -> acknowledged, no re-post
    const dupRaw = JSON.stringify(webhookPayload(accountNumber, 'PAY-1', 25000));
    const dup = await request(app.getHttpServer())
      .post('/api/v1/payments/monnify/webhook')
      .set('monnify-signature', sign(dupRaw))
      .send(JSON.parse(dupRaw));
    expect(dup.status).toBe(200);
    const m360after = await request(app.getHttpServer())
      .get(`/api/v1/reports/member/${memberId}/360`)
      .set(auth);
    expect(m360after.body.savingsTotal).toBe(25000);

    // Notifications list shows one POSTED row
    const notifications = await request(app.getHttpServer())
      .get('/api/v1/payments/internal/notifications')
      .set(auth);
    expect(notifications.body).toHaveLength(1);
    expect(notifications.body[0].amount).toBe(25000);
    expect(notifications.body[0].status).toBe('POSTED');

    // Ledger: net zero; reconciliation clean (member-linked 2000 line)
    const tb = await request(app.getHttpServer())
      .get('/api/v1/ledger/trial-balance')
      .set(auth);
    expect(tb.body.net).toBe(0);
    const reconcile = await request(app.getHttpServer())
      .get('/api/v1/reports/savings-reconciliation')
      .set(auth);
    expect(reconcile.body.matched).toBe(1);
    expect(reconcile.body.mismatches).toEqual([]);

    // Unknown account number -> acknowledged silently, nothing posted
    const ghostRaw = JSON.stringify(webhookPayload('8999999999', 'PAY-999', 5000));
    const ghost = await request(app.getHttpServer())
      .post('/api/v1/payments/monnify/webhook')
      .set('monnify-signature', sign(ghostRaw))
      .send(JSON.parse(ghostRaw));
    expect(ghost.status).toBe(200);
    expect(ghost.body.acknowledged).toBe(false);
    const listAfter = await request(app.getHttpServer())
      .get('/api/v1/payments/internal/notifications')
      .set(auth);
    expect(listAfter.body).toHaveLength(1);
    expect(listAfter.headers['x-total-count']).toBe('1');

    // Member self-service: sees their own account + funding history (OTP login)
    const otp = await request(app.getHttpServer())
      .post('/api/v1/auth/member/request-otp')
      .send({ organizationSlug: coop.slug, email: memberEmail });
    expect(otp.status).toBe(200);
    expect(otp.body.devCode).toBeTruthy();
    const verify = await request(app.getHttpServer())
      .post('/api/v1/auth/member/verify-otp')
      .send({ organizationSlug: coop.slug, email: memberEmail, code: otp.body.devCode });
    expect(verify.status).toBe(200);
    const memberTok = verify.body.accessToken as string;

    const myAccount = await request(app.getHttpServer())
      .get('/api/v1/member/virtual-account')
      .set({ Authorization: `Bearer ${memberTok}` });
    expect(myAccount.status).toBe(200);
    expect(myAccount.body.accountNumber).toBe(accountNumber);

    const myPayments = await request(app.getHttpServer())
      .get('/api/v1/member/payments')
      .set({ Authorization: `Bearer ${memberTok}` });
    expect(myPayments.status).toBe(200);
    expect(myPayments.body).toHaveLength(1);
    expect(myPayments.body[0].amount).toBe(25000);
    expect(myPayments.body[0].status).toBe('POSTED');
  });
});
