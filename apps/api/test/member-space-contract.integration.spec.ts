/**
 * Member-space response contract.
 *
 * Regression guard for a real outage: /member/virtual-account returned HTTP 200 with a
 * completely EMPTY body when a member had no virtual account yet (Nest turns a null
 * return into no content). The member app calls it on its landing page, so the browser's
 * `res.json()` threw "Unexpected end of JSON input" and the app appeared broken.
 *
 * Every endpoint the member app calls on load must return a body that JSON.parse accepts.
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
const ADMIN = { email: `mem-space-${suffix}@coopengine.test`, password: 'AdminPass123!' };
const MEMBER = {
  email: `mem-space-member-${suffix}@coopengine.test`,
  phone: '+2348039990001',
};

describe('member-space responses are always parseable JSON', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let pool: Pool;
  let memberToken = '';

  beforeAll(async () => {
    pool = createPool(TEST_DATABASE_URL);
    await ensureRbacSeeded(pool);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    http = request(app.getHttpServer());

    const slug = `mems-${suffix}`;
    const saas = await http
      .post('/api/v1/auth/login')
      .send({ email: 'admin@coopengine.dev', password: ADMIN_PASSWORD })
      .expect(200);
    await http
      .post('/api/v1/organizations')
      .set({ Authorization: `Bearer ${saas.body.tokens.accessToken}` })
      .send({ name: `MemberSpace ${suffix}`, slug, adminEmail: ADMIN.email, adminPassword: ADMIN.password })
      .expect(201);

    const login = await http
      .post('/api/v1/auth/login')
      .send({ email: ADMIN.email, password: ADMIN.password, organizationSlug: slug })
      .expect(200);
    const staff = login.body.tokens.accessToken as string;

    const created = await http
      .post('/api/v1/members')
      .set({ Authorization: `Bearer ${staff}` })
      .send({
        firstName: 'Ada',
        lastName: 'Member',
        email: MEMBER.email,
        phone: MEMBER.phone,
        joinedOn: '2026-02-01',
      })
      .expect(201);
    await http
      .post(`/api/v1/members/${created.body.id}/approve`)
      .set({ Authorization: `Bearer ${staff}` })
      .send({})
      .expect(200);

    const otp = await http
      .post('/api/v1/auth/member/request-otp')
      .send({ organizationSlug: slug, email: MEMBER.email })
      .expect(200);
    expect(otp.body.devCode, 'dev mode must return the code so this test can run').toBeTruthy();

    const verified = await http
      .post('/api/v1/auth/member/verify-otp')
      .send({ organizationSlug: slug, email: MEMBER.email, code: otp.body.devCode })
      .expect(200);
    memberToken = verified.body.accessToken as string;
    expect(memberToken).toBeTruthy();
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@coopengine.test')`);
    await pool.query(`DELETE FROM users WHERE email LIKE '%@coopengine.test'`);
    await app?.close();
    await pool.end();
  });

  const endpoints = ['/member/dashboard', '/member/virtual-account', '/member/payments'];

  for (const path of endpoints) {
    it(`${path} returns a body the browser can parse`, async () => {
      const res = await http.get(`/api/v1${path}`).set({ Authorization: `Bearer ${memberToken}` });
      expect(res.status, `${path} status`).toBe(200);
      const raw = res.text ?? '';
      expect(raw.length, `${path} must not have an empty body`).toBeGreaterThan(0);
      expect(() => JSON.parse(raw), `${path} body must be valid JSON`).not.toThrow();
    });
  }

  it('reports "no virtual account" as JSON null, not as no content', async () => {
    const res = await http
      .get('/api/v1/member/virtual-account')
      .set({ Authorization: `Bearer ${memberToken}` });
    expect(res.status).toBe(200);
    expect(res.text).toBe('null');
  });
});
