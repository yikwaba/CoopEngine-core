/**
 * Live-provider code paths, exercised against LOCAL MOCKS.
 *
 * Proves the production branches of Phase D without real credentials:
 *  - Termii: MEMBER_OTP_PROVIDER=termii generates the code server-side, POSTs
 *    it to the Termii-compatible endpoint, and verification still works;
 *    provider failures return sent=false (no code leak).
 *  - Monnify: MONNIFY_PROVIDER=monnify authenticates (Basic), creates a
 *    reserved account through the API, stores the provider's account details,
 *    and inbound transfers still auto-post to the ledger.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { createPool } from '@coopengine/db';
import { ADMIN_PASSWORD, TEST_DATABASE_URL, ensureRbacSeeded } from './helpers';

const MONNIFY_SECRET = 'mock-monnify-secret';

let app: INestApplication;
let pool: Pool;
let termiiServer: Server;
let termiiPort = 0;
let monnifyServer: Server;
let monnifyPort = 0;

/** Captured provider traffic (assertions run against these). */
const termiiCaptured: { to: string; message: string; apiKey: string }[] = [];
let monnifyAuthCalls = 0;
let termiiShouldFail = false;

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? TEST_DATABASE_URL;
  pool = createPool(process.env.DATABASE_URL);
  await ensureRbacSeeded(pool);

  // ---- Termii mock (captures the SMS payload) --------------------------
  termiiServer = createServer((req, res) => {
    void (async () => {
      if (req.url === '/api/sms/send' && req.method === 'POST') {
        if (termiiShouldFail) return json(res, 500, { message: 'provider down' });
        const body = JSON.parse(await readBody(req)) as {
          api_key: string;
          to: string;
          message: string;
        };
        termiiCaptured.push({ to: body.to, message: body.message, apiKey: body.api_key });
        return json(res, 200, { message_id: 'mock-msg-1', code: 'ok' });
      }
      return json(res, 404, {});
    })();
  });
  await new Promise<void>((resolve) => termiiServer.listen(0, '127.0.0.1', resolve));
  termiiPort = (termiiServer.address() as { port: number }).port;

  // ---- Monnify mock (auth + reserved accounts) -------------------------
  monnifyServer = createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req);
      if (req.url === '/api/v1/auth/login') {
        monnifyAuthCalls += 1;
        if (req.method !== 'POST') {
          return json(res, 405, { requestSuccessful: false, responseMessage: 'method must be POST' });
        }
        if (!req.headers.authorization?.startsWith('Basic ')) {
          return json(res, 401, { requestSuccessful: false, responseMessage: 'no basic auth' });
        }
        return json(res, 200, {
          requestSuccessful: true,
          responseBody: { accessToken: 'mock-access-token', expiresIn: 3600 },
        });
      }
      if (req.url === '/api/v1/bank-transfer/reserved-accounts' && req.method === 'POST') {
        if (req.headers.authorization !== 'Bearer mock-access-token') {
          return json(res, 401, { requestSuccessful: false, responseMessage: 'bad token' });
        }
        const body = JSON.parse(raw) as { accountReference: string; accountName: string; contractCode: string };
        // Unique number per call (mirrors a real provider)
        const num = `999${String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0')}`;
        return json(res, 200, {
          requestSuccessful: true,
          responseBody: {
            accountReference: body.accountReference,
            accountNumber: num,
            bankName: 'Mock MFB',
            accountName: body.accountName,
            contractCode: body.contractCode,
          },
        });
      }
      return json(res, 404, {});
    })();
  });
  await new Promise<void>((resolve) => monnifyServer.listen(0, '127.0.0.1', resolve));
  monnifyPort = (monnifyServer.address() as { port: number }).port;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  await app.init();
});

afterAll(async () => {
  delete process.env.MEMBER_OTP_PROVIDER;
  delete process.env.MONNIFY_PROVIDER;
  delete process.env.TERMII_BASE_URL;
  delete process.env.MONNIFY_BASE_URL;
  if (pool) {
    await pool.query(`DELETE FROM users WHERE email LIKE '%@coopengine.test'`);
    await pool.query(`DELETE FROM sessions`);
    await pool.end();
  }
  await new Promise<void>((r) => termiiServer.close(() => r()));
  await new Promise<void>((r) => monnifyServer.close(() => r()));
  if (app) await app.close();
});

async function onboard(): Promise<{ token: string; slug: string }> {
  const saas = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email: 'admin@coopengine.dev', password: ADMIN_PASSWORD });
  expect(saas.status).toBe(200);
  const suffix = randomUUID().slice(0, 8);
  const onboarded = await request(app.getHttpServer())
    .post('/api/v1/organizations')
    .set('Authorization', `Bearer ${saas.body.tokens.accessToken}`)
    .send({
      name: `Provider mock cooperative`,
      slug: `pm-${suffix}`,
      adminEmail: `pm-${suffix}@coopengine.test`,
      adminPassword: 'CoopPass123!',
    });
  expect(onboarded.status).toBe(201);
  const login = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email: `pm-${suffix}@coopengine.test`, password: 'CoopPass123!' });
  return { token: login.body.tokens.accessToken as string, slug: onboarded.body.slug as string };
}

describe('live providers against local mocks', () => {
  it('delivers member OTPs through the Termii code path', async () => {
    const coop = await onboard();
    const auth = { Authorization: `Bearer ${coop.token}` };
    const member = await request(app.getHttpServer())
      .post('/api/v1/members')
      .set(auth)
      .send({
        firstName: 'Sms',
        lastName: 'Member',
        email: `sms-${coop.slug}@coopengine.test`,
        phone: '+2348030000001',
      });
    expect(member.status).toBe(201);
    await request(app.getHttpServer()).post(`/api/v1/members/${member.body.id}/approve`).set(auth);

    process.env.MEMBER_OTP_PROVIDER = 'termii';
    process.env.TERMII_API_KEY = 'mock-termii-key';
    process.env.TERMII_SENDER_ID = 'CoopEngine';
    process.env.TERMII_BASE_URL = `http://127.0.0.1:${termiiPort}`;

    const otp = await request(app.getHttpServer())
      .post('/api/v1/auth/member/request-otp')
      .send({ organizationSlug: coop.slug, email: `sms-${coop.slug}@coopengine.test` });
    expect(otp.status).toBe(200);
    expect(otp.body.sent).toBe(true);
    expect(otp.body.provider).toBe('termii');
    expect(otp.body.devCode).toBeUndefined(); // never leak the code in termii mode

    expect(termiiCaptured).toHaveLength(1);
    expect(termiiCaptured[0].to).toBe('+2348030000001');
    expect(termiiCaptured[0].apiKey).toBe('mock-termii-key');
    const code = /code is (\d{6})/.exec(termiiCaptured[0].message)?.[1];
    expect(code).toBeTruthy();

    const verify = await request(app.getHttpServer())
      .post('/api/v1/auth/member/verify-otp')
      .send({ organizationSlug: coop.slug, email: `sms-${coop.slug}@coopengine.test`, code });
    expect(verify.status).toBe(200);
    expect(verify.body.accessToken).toBeTruthy();

    // Provider outage: generic 200, no delivery, no code leak
    termiiShouldFail = true;
    const failed = await request(app.getHttpServer())
      .post('/api/v1/auth/member/request-otp')
      .send({ organizationSlug: coop.slug, email: `sms-${coop.slug}@coopengine.test` });
    expect(failed.status).toBe(200);
    expect(failed.body.sent).toBe(false);
    expect(failed.body.devCode).toBeUndefined();
    termiiShouldFail = false;
  });

  it('creates Monnify reserved accounts and posts inbound transfers', async () => {
    const coop = await onboard();
    const auth = { Authorization: `Bearer ${coop.token}` };
    const member = await request(app.getHttpServer())
      .post('/api/v1/members')
      .set(auth)
      .send({
        firstName: 'Virtual',
        lastName: 'Account',
        email: `va-${coop.slug}@coopengine.test`,
      });
    expect(member.status).toBe(201);
    await request(app.getHttpServer()).post(`/api/v1/members/${member.body.id}/approve`).set(auth);

    process.env.MONNIFY_PROVIDER = 'monnify';
    process.env.MONNIFY_API_KEY = 'mock-api-key';
    process.env.MONNIFY_SECRET_KEY = MONNIFY_SECRET;
    process.env.MONNIFY_CONTRACT_CODE = '1234567890';
    process.env.MONNIFY_BASE_URL = `http://127.0.0.1:${monnifyPort}`;

    const created = await request(app.getHttpServer())
      .post('/api/v1/payments/virtual-accounts')
      .set(auth)
      .send({ memberId: member.body.id });
    expect(created.status).toBe(201);
    expect(monnifyAuthCalls).toBe(1);
    expect(created.body.provider).toBe('monnify');
    expect(created.body.accountNumber).toMatch(/^999\d{7}$/);
    expect(created.body.bankName).toBe('Mock MFB');

    // Inbound transfer for the provider-issued number auto-posts to savings
    const payload = {
      accountNumber: created.body.accountNumber as string,
      accountReference: created.body.accountReference as string,
      paymentReference: `MNFY-${randomUUID().slice(0, 8)}`,
      transactionReference: `TXN-${randomUUID().slice(0, 8)}`,
      amountPaid: 17500,
      transactionStatus: 'SUCCESSFUL',
    };
    const rawBody = JSON.stringify(payload);
    const signature = createHash('sha512')
      .update(`${MONNIFY_SECRET}|${rawBody}`)
      .digest('hex');
    const webhook = await request(app.getHttpServer())
      .post('/api/v1/payments/monnify/webhook')
      .set('monnify-signature', signature)
      .send(JSON.parse(rawBody));
    expect(webhook.status).toBe(200);
    expect(webhook.body.acknowledged).toBe(true);

    const m360 = await request(app.getHttpServer())
      .get(`/api/v1/reports/member/${member.body.id}/360`)
      .set(auth);
    expect(m360.body.savingsTotal).toBe(17500);
  });
});
