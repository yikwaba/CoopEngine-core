/**
 * Auth + RBAC integration tests (real PostgreSQL + seeded RBAC).
 *
 * Covers: SaaS admin login, tenant onboarding, coop-admin login with org
 * context, permission denial (no saas.tenants.manage), /auth/me, logout,
 * refresh rotation.
 *
 * Prerequisites: local Postgres, migrations applied, `db:seed` run.
 * Run: pnpm --filter @coopengine/api test:integration
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

beforeAll(async () => {
  process.env.DATABASE_URL =
    TEST_DATABASE_URL;

  pool = createPool(process.env.DATABASE_URL);
  await ensureRbacSeeded(pool);

  try {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await app.init();
  } catch (error) {
    console.error('beforeAll failed:', error);
    throw error;
  }
});

afterAll(async () => {
  if (pool) {
    // Test-only cleanup. RBAC template rows and seeded users are preserved.
    await pool.query(`DELETE FROM users WHERE email LIKE '%@coopengine.test'`);
    await pool.query(`DELETE FROM sessions`);
    await pool.end();
  }
  if (app) await app.close();
});

async function login(email: string, password: string, slug?: string) {
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send(slug ? { email, password, organizationSlug: slug } : { email, password });
  expect(res.status).toBe(200);
  return res.body as {
    user: { id: string; email: string };
    organizations: { id: string; slug: string }[];
    requiresOrgSelection: boolean;
    tokens?: {
      accessToken: string;
      refreshToken: string;
      organization: { id: string; slug: string } | null;
      permissions: string[];
    };
  };
}

describe('auth + RBAC (HTTP)', () => {
  it('logs in the SaaS admin with platform permissions (no org)', async () => {
    const body = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    expect(body.requiresOrgSelection).toBe(false);
    expect(body.organizations).toHaveLength(0);
    expect(body.tokens?.organization).toBeNull();
    expect(body.tokens?.permissions).toContain('saas.tenants.manage');
  });

  it('onboards a cooperative workspace (tenant + settings + HQ + coop admin)', async () => {
    const saas = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    const slug = `test-coop-${randomUUID().slice(0, 8)}`;
    const adminEmail = `admin-${randomUUID().slice(0, 8)}@coopengine.test`;

    const res = await request(app.getHttpServer())
      .post('/api/v1/organizations')
      .set('Authorization', `Bearer ${saas.tokens?.accessToken}`)
      .send({
        name: 'Test Cooperative',
        slug,
        adminEmail,
        adminPassword: 'CoopPass123!',
      });
    if (res.status !== 201) {
      throw new Error(`ONBOARD RESP: ${JSON.stringify(res.body)}`);
    }
    const onboardBody = res.body as Record<string, unknown>;
    expect(onboardBody).toMatchObject({ slug, status: 'ACTIVE' });
    const orgId = res.body.id as string;

    // Coop admin can log in with org context
    const coopAdmin = await login(adminEmail, 'CoopPass123!', slug);
    expect(coopAdmin.tokens?.organization?.slug).toBe(slug);
    expect(coopAdmin.tokens?.permissions).toContain('settings.manage');
    expect(coopAdmin.tokens?.permissions).not.toContain('saas.tenants.manage');

    // /auth/me reflects org + permissions
    const me = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${coopAdmin.tokens?.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.organizationId).toBe(orgId);
    expect(me.body.permissions).toContain('settings.manage');

    // Coop admin lacks saas.tenants.manage -> 403 on onboarding
    const denied = await request(app.getHttpServer())
      .post('/api/v1/organizations')
      .set('Authorization', `Bearer ${coopAdmin.tokens?.accessToken}`)
      .send({
        name: 'Rogue Cooperative',
        slug: `rogue-${randomUUID().slice(0, 8)}`,
        adminEmail: `rogue-${randomUUID().slice(0, 8)}@coopengine.test`,
        adminPassword: 'RoguePass123!',
      });
    expect(denied.status).toBe(403);

    // Missing/invalid token -> 401
    const unauth = await request(app.getHttpServer())
      .get('/api/v1/auth/me');
    expect(unauth.status).toBe(401);

    // Refresh rotation issues new tokens and revokes the old session
    const refreshed = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: coopAdmin.tokens?.refreshToken });
    expect(refreshed.status).toBe(200);
    const refreshedTokens = refreshed.body as {
      accessToken: string;
      refreshToken: string;
      organization: { slug: string } | null;
    };
    expect(refreshedTokens.accessToken).toBeDefined();
    expect(refreshedTokens.organization?.slug).toBe(slug);

    // Logout (fresh session) revokes it -> its access token is rejected
    const logout = await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${refreshedTokens.accessToken}`);
    expect(logout.status).toBe(204);
    const meAfterLogout = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${refreshedTokens.accessToken}`);
    expect(meAfterLogout.status).toBe(401);
  });

  it('rejects duplicate slugs with 409', async () => {
    const saas = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    const slug = `dup-coop-${randomUUID().slice(0, 8)}`;
    const email = `dup-${randomUUID().slice(0, 8)}@coopengine.test`;
    const payload = {
      name: 'Duplicate Cooperative',
      slug,
      adminEmail: email,
      adminPassword: 'DupPass123!',
    };
    const first = await request(app.getHttpServer())
      .post('/api/v1/organizations')
      .set('Authorization', `Bearer ${saas.tokens?.accessToken}`)
      .send(payload);
    expect(first.status).toBe(201);
    const second = await request(app.getHttpServer())
      .post('/api/v1/organizations')
      .set('Authorization', `Bearer ${saas.tokens?.accessToken}`)
      .send(payload);
    expect(second.status).toBe(409);
  });
});
