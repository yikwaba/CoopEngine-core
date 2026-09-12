/**
 * Member self-service: savings view + downloadable statements.
 *
 * Covers the two screens added to the member app, end to end through the real API and
 * database: a member sees their own balance and movements, and can download their own
 * savings statement as a real PDF. Also proves the member can only ever see their own
 * numbers (the endpoints are scoped to the member in the token, not to a parameter).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { createPool } from '@coopengine/db';
import { ADMIN_PASSWORD, ensureRbacSeeded, TEST_DATABASE_URL } from './helpers';

const suffix = Math.random().toString(36).slice(2, 8);
const ADMIN = { email: `stmt-${suffix}@coopengine.test`, password: 'AdminPass123!' };
const A = { email: `stmt-a-${suffix}@coopengine.test`, phone: '+2348037770001' };
const B = { email: `stmt-b-${suffix}@coopengine.test`, phone: '+2348037770002' };

describe('member savings view and statements', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let pool: Pool;
  let staffToken = '';
  let tokenA = '';
  let tokenB = '';
  let slug = '';

  async function memberToken(email: string): Promise<string> {
    const otp = await http
      .post('/api/v1/auth/member/request-otp')
      .send({ organizationSlug: slug, email })
      .expect(200);
    const verified = await http
      .post('/api/v1/auth/member/verify-otp')
      .send({ organizationSlug: slug, email, code: otp.body.devCode })
      .expect(200);
    return verified.body.accessToken as string;
  }

  beforeAll(async () => {
    pool = createPool(TEST_DATABASE_URL);
    await ensureRbacSeeded(pool);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    http = request(app.getHttpServer());

    slug = `stmt-${suffix}`;
    const saas = await http
      .post('/api/v1/auth/login')
      .send({ email: 'admin@coopengine.dev', password: ADMIN_PASSWORD })
      .expect(200);
    await http
      .post('/api/v1/organizations')
      .set({ Authorization: `Bearer ${saas.body.tokens.accessToken}` })
      .send({ name: `Statements ${suffix}`, slug, adminEmail: ADMIN.email, adminPassword: ADMIN.password })
      .expect(201);

    const login = await http
      .post('/api/v1/auth/login')
      .send({ email: ADMIN.email, password: ADMIN.password, organizationSlug: slug })
      .expect(200);
    staffToken = login.body.tokens.accessToken as string;

    // Two members; only the first funds a savings account.
    const ids: Record<string, string> = {};
    for (const [key, m, first] of [
      ['a', A, 'Ada'],
      ['b', B, 'Bola'],
    ] as const) {
      const created = await http
        .post('/api/v1/members')
        .set({ Authorization: `Bearer ${staffToken}` })
        .send({ firstName: first, lastName: 'Statement', email: m.email, phone: m.phone, joinedOn: '2026-02-01' })
        .expect(201);
      ids[key] = created.body.id as string;
      await http
        .post(`/api/v1/members/${ids[key]}/approve`)
        .set({ Authorization: `Bearer ${staffToken}` })
        .send({})
        .expect(200);
    }

    const account = await http
      .post(`/api/v1/savings/member/${ids.a}/account`)
      .set({ Authorization: `Bearer ${staffToken}` })
      .send({})
      .expect(201);
    const accountId = (account.body.id ?? account.body.accountId) as string;
    await http
      .post(`/api/v1/savings/accounts/${accountId}/deposits`)
      .set({ Authorization: `Bearer ${staffToken}` })
      .send({ amount: 5000, description: 'March savings' })
      .expect(201);

    tokenA = await memberToken(A.email);
    tokenB = await memberToken(B.email);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@coopengine.test')`);
    await pool.query(`DELETE FROM users WHERE email LIKE '%@coopengine.test'`);
    await app?.close();
    await pool.end();
  });

  it('shows the member their own balance and movements', async () => {
    const res = await http.get('/api/v1/member/savings').set({ Authorization: `Bearer ${tokenA}` });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.totalBalance).toBe(5000);
    expect(res.body.accounts).toHaveLength(1);
    expect(res.body.transactions.length).toBeGreaterThan(0);
    expect(res.body.transactions[0]).toHaveProperty('runningBalance');
  });

  it('shows a member with no account an empty (but valid) view', async () => {
    const res = await http.get('/api/v1/member/savings').set({ Authorization: `Bearer ${tokenB}` });
    expect(res.status).toBe(200);
    expect(res.body.accounts).toEqual([]);
    expect(res.body.totalBalance).toBe(0);
    expect(res.body.transactions).toEqual([]);
  });

  it('lists the statements the member can download', async () => {
    const res = await http.get('/api/v1/member/statements').set({ Authorization: `Bearer ${tokenA}` });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.map((d: { kind: string }) => d.kind)).toContain('SAVINGS');
    for (const doc of res.body) {
      expect(typeof doc.downloadPath).toBe('string');
    }

    const empty = await http.get('/api/v1/member/statements').set({ Authorization: `Bearer ${tokenB}` });
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual([]);
  });

  it('serves the member their own savings statement as a real PDF', async () => {
    const res = await http
      .get('/api/v1/member/statements/savings.pdf')
      .set({ Authorization: `Bearer ${tokenA}` })
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status, 'a funded member must get a statement').toBe(200);
    const body = res.body as Buffer;
    expect(body.subarray(0, 5).toString()).toBe('%PDF-');
    expect(body.length).toBeGreaterThan(1000);
    expect(String(res.headers['content-type'])).toContain('application/pdf');
  });

  it('rejects the document endpoints without a member session', async () => {
    await http.get('/api/v1/member/savings').expect(401);
    await http.get('/api/v1/member/statements').expect(401);
    await http.get('/api/v1/member/statements/savings.pdf').expect(401);
  });
});
