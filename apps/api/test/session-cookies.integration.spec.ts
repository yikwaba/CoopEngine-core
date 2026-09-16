/**
 * Session cookies.
 *
 * The point of moving tokens into httpOnly cookies is that a cross-site scripting bug can no
 * longer read a session out of browser storage. That only counts if it is actually enforced, so
 * this spec pins down:
 *   - the cookies are httpOnly and SameSite, and Secure in production;
 *   - a browser with nothing but the cookie can work — no Authorization header at all;
 *   - a bearer token still works, because scripts, tests and provider callbacks are not browsers;
 *   - refresh rotates from the cookie alone and the old refresh token then dies;
 *   - logout clears the cookies AND kills the session, so the old cookie is worthless;
 *   - a failed sign-in hands out no session at all.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { createPool } from '@coopengine/db';
import { ADMIN_PASSWORD, ensureRbacSeeded, TEST_DATABASE_URL } from './helpers';
import { ACCESS_COOKIE, REFRESH_COOKIE, setSessionCookies } from '../src/common/auth-cookies';

const suffix = Math.random().toString(36).slice(2, 8);
const slug = `cookies-${suffix}`;
const ADMIN = { email: `cookies-${suffix}@coopengine.test`, password: 'AdminPass123!' };

const setCookieLines = (res: request.Response): string[] =>
  ([] as string[]).concat((res.headers['set-cookie'] as unknown as string[]) ?? []);

const cookieFor = (res: request.Response, name: string): string => {
  const line = setCookieLines(res).find((c) => c.startsWith(`${name}=`));
  if (!line) throw new Error(`no ${name} cookie in ${JSON.stringify(setCookieLines(res))}`);
  return line.split(';')[0];
};

describe('session cookies', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(TEST_DATABASE_URL);
    await ensureRbacSeeded(pool);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    http = request(app.getHttpServer());

    const saas = await http
      .post('/api/v1/auth/login')
      .send({ email: 'admin@coopengine.dev', password: ADMIN_PASSWORD })
      .expect(200);
    await http
      .post('/api/v1/organizations')
      .set({ Authorization: [process.env.AUTH_SCHEME ?? 'Bearer', saas.body.tokens.accessToken].join(' ') })
      .send({ name: `Cookies ${suffix}`, slug, adminEmail: ADMIN.email, adminPassword: ADMIN.password })
      .expect(201);
  });

  afterAll(async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.internal_scan', 'on', true)`);
      const { rows } = await client.query(`SELECT id FROM organizations WHERE slug = $1`, [slug]);
      await client.query('COMMIT');
      const orgId = (rows[0] as { id: string } | undefined)?.id;
      if (orgId) {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [orgId]);
        await client.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
        await client.query('COMMIT');
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.internal_scan', 'on', true)`);
        await client.query(`DELETE FROM org_lookups WHERE slug = $1`, [slug]);
        await client.query('COMMIT');
      }
    } finally {
      client.release();
    }
    await pool.query(
      `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@coopengine.test')`,
    );
    await pool.query(`DELETE FROM users WHERE email LIKE '%@coopengine.test'`);
    await app?.close();
    await pool.end();
  });

  it('sign-in sets httpOnly, SameSite cookies — and Secure in production', async () => {
    const res = await http
      .post('/api/v1/auth/login')
      .send({ email: ADMIN.email, password: ADMIN.password, organizationSlug: slug })
      .expect(200);

    const access = setCookieLines(res).find((c) => c.startsWith(`${ACCESS_COOKIE}=`));
    const refresh = setCookieLines(res).find((c) => c.startsWith(`${REFRESH_COOKIE}=`));
    expect(access, JSON.stringify(setCookieLines(res))).toBeDefined();
    expect(refresh).toBeDefined();
    expect(access).toMatch(/HttpOnly/i);
    expect(access).toMatch(/SameSite=Lax/i);
    // A cookie the scripts can read is the thing we are removing, so assert it is not exposed.
    expect(access).not.toMatch(/HttpOnly=false/i);
    expect(JSON.stringify(res.body)).not.toMatch(/ce_at/i);

    // The Secure flag only when the API runs as production (the test process does not).
    const captured: { name: string; options?: Record<string, unknown> }[] = [];
    const fakeRes = {
      cookie: (name: string, _value: string, options?: Record<string, unknown>) => {
        captured.push({ name, options });
      },
    } as unknown as Parameters<typeof setSessionCookies>[0];
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    setSessionCookies(fakeRes, { accessToken: 'a', refreshToken: 'b' }, 900);
    process.env.NODE_ENV = original;
    expect(captured.every((c) => c.options?.secure === true)).toBe(true);
    expect(captured.every((c) => c.options?.httpOnly === true)).toBe(true);
  });

  it('a browser with only the cookie is authenticated — no Authorization header', async () => {
    const login = await http
      .post('/api/v1/auth/login')
      .send({ email: ADMIN.email, password: ADMIN.password, organizationSlug: slug })
      .expect(200);
    const cookie = cookieFor(login, ACCESS_COOKIE);

    const me = await http.get('/api/v1/auth/me').set('Cookie', cookie).expect(200);
    expect(me.body.userId ?? me.body.user?.id ?? me.body.id).toBeTruthy();

    const members = await http.get('/api/v1/members').set('Cookie', cookie).expect(200);
    expect(Array.isArray(members.body) || Array.isArray(members.body.rows)).toBe(true);

    await http.get('/api/v1/members').expect(401);
  });

  it('a bearer token still works: scripts and callbacks are not browsers', async () => {
    const login = await http
      .post('/api/v1/auth/login')
      .send({ email: ADMIN.email, password: ADMIN.password, organizationSlug: slug })
      .expect(200);
    const token = login.body.tokens.accessToken as string;
    await http.get('/api/v1/members').set('Authorization', ['Bearer', token].join(' ')).expect(200);
  });

  it('refresh rotates from the cookie alone, and the old refresh token then dies', async () => {
    const login = await http
      .post('/api/v1/auth/login')
      .send({ email: ADMIN.email, password: ADMIN.password, organizationSlug: slug })
      .expect(200);
    const refreshCookie = cookieFor(login, REFRESH_COOKIE);
    const oldRefresh = login.body.tokens.refreshToken as string;

    const rotated = await http
      .post('/api/v1/auth/refresh')
      .set('Cookie', refreshCookie)
      .send({})
      .expect(200);
    expect(rotated.body.accessToken).toBeTruthy();
    expect(rotated.body.refreshToken).not.toBe(oldRefresh);
    expect(setCookieLines(rotated).some((c) => c.startsWith(`${ACCESS_COOKIE}=`))).toBe(true);

    // the replaced refresh token is no longer accepted
    const reused = await http.post('/api/v1/auth/refresh').send({ refreshToken: oldRefresh });
    expect(reused.status).toBeGreaterThanOrEqual(400);
  });

  it('logout clears the cookies and kills the session behind them', async () => {
    const login = await http
      .post('/api/v1/auth/login')
      .send({ email: ADMIN.email, password: ADMIN.password, organizationSlug: slug })
      .expect(200);
    const access = cookieFor(login, ACCESS_COOKIE);
    await http.get('/api/v1/auth/me').set('Cookie', access).expect(200);

    const out = await http.post('/api/v1/auth/logout').set('Cookie', access).expect(204);
    const cleared = setCookieLines(out);
    expect(cleared.some((c) => c.startsWith(`${ACCESS_COOKIE}=`))).toBe(true);
    expect(cleared.some((c) => /Expires=Thu, 01 Jan 1970|Max-Age=0/i.test(c))).toBe(true);

    // revocation, not just deletion: replaying the old cookie must fail
    await http.get('/api/v1/auth/me').set('Cookie', access).expect(401);
  });

  it('a failed sign-in hands out no session', async () => {
    const res = await http
      .post('/api/v1/auth/login')
      .send({ email: ADMIN.email, password: 'wrong-password', organizationSlug: slug });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(setCookieLines(res).some((c) => c.startsWith(`${ACCESS_COOKIE}=`))).toBe(false);
  });
});
