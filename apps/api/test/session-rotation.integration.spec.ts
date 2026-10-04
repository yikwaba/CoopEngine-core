import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { withTenant } from '@coopengine/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { PasswordResetMailer } from '../src/auth/password-reset-mailer';
import { ENV } from '../src/config/env';
import { ADMIN_PASSWORD, TEST_DATABASE_URL, ensureRbacSeeded } from './helpers';

const password = 'SessionPass123!';
describe('atomic staff session rotation (PostgreSQL)', () => {
  let app: INestApplication;
  let pool: Pool;
  let platform: string;
  let resetToken: string;
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    pool = new Pool({ connectionString: TEST_DATABASE_URL });
    await ensureRbacSeeded(pool);
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PasswordResetMailer).useValue({ send: async (_email: string, token: string) => { resetToken = token; } }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.init();
    platform = (await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: 'admin@coopengine.dev', password: ADMIN_PASSWORD }).expect(200)).body.tokens.accessToken;
  });
  afterAll(async () => { await app?.close(); await pool?.end(); });
  async function staff() {
    const suffix = randomUUID().slice(0, 8); const email = `rotation-${suffix}@coopengine.test`; const slug = `rotation-${suffix}`;
    const org = await request(app.getHttpServer()).post('/api/v1/organizations').set('Authorization', `Bearer ${platform}`)
      .send({ name: `Rotation ${suffix}`, slug, adminEmail: email, adminPassword: password }).expect(201);
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password }).expect(200);
    const id = (await pool.query('SELECT id FROM users WHERE email=$1', [email])).rows[0].id;
    return { email, slug, orgId: org.body.id, id, tokens: login.body.tokens };
  }
  const refresh = (token: string) => request(app.getHttpServer()).post('/api/v1/auth/refresh').send({ refreshToken: token });
  const me = (token: string) => request(app.getHttpServer()).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
  it('twelve simultaneous refresh requests have one winner, without pool starvation', async () => {
    const a = await staff();
    const results = await Promise.all(Array.from({ length: 12 }, () => refresh(a.tokens.refreshToken)));
    expect(results.filter(r => r.status === 200)).toHaveLength(1);
    expect(results.filter(r => r.status === 401)).toHaveLength(11);
    const winner = results.find(r => r.status === 200)!;
    expect(winner.body.organization.id).toBe(a.orgId);
    expect(winner.body.expiresInSeconds).toBe(ENV.jwtAccessTtlSeconds);
    expect((await pool.query('SELECT count(*)::int AS n FROM sessions WHERE user_id=$1', [a.id])).rows[0].n).toBe(2);
    expect((await pool.query('SELECT count(*)::int AS n FROM sessions WHERE user_id=$1 AND revoked_at IS NULL', [a.id])).rows[0].n).toBe(1);
    expect((await me(a.tokens.accessToken)).status).toBe(401);
    expect((await me(winner.body.accessToken)).status).toBe(200);
    expect((await refresh(a.tokens.refreshToken)).status).toBe(401);
  });
  it('logout revokes both bearer/cookie access and refresh', async () => {
    const a = await staff();
    await request(app.getHttpServer()).post('/api/v1/auth/logout').set('Cookie', `ce_at=${a.tokens.accessToken}`).expect(204);
    expect((await me(a.tokens.accessToken)).status).toBe(401);
    await request(app.getHttpServer()).get('/api/v1/auth/me').set('Cookie', `ce_at=${a.tokens.accessToken}`).expect(401);
    expect((await refresh(a.tokens.refreshToken)).status).toBe(401);
  });
  it('database session expiry denies still-valid JWT and refresh', async () => {
    const a = await staff();
    await pool.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1", [a.id]);
    expect((await me(a.tokens.accessToken)).status).toBe(401);
    expect((await refresh(a.tokens.refreshToken)).status).toBe(401);
    expect((await pool.query('SELECT count(*)::int AS n FROM sessions WHERE user_id=$1', [a.id])).rows[0].n).toBe(1);
  });
  it('inactive global users cannot keep accessing or refreshing', async () => {
    const a = await staff(); await pool.query("UPDATE users SET status='SUSPENDED' WHERE id=$1", [a.id]);
    expect((await me(a.tokens.accessToken)).status).toBe(401);
    expect((await refresh(a.tokens.refreshToken)).status).toBe(401);
  });
  it('removed membership cannot refresh into another tenant/platform context', async () => {
    const a = await staff();
    await pool.query('DELETE FROM user_roles WHERE user_id=$1 AND organization_id=$2', [a.id, a.orgId]);
    expect((await refresh(a.tokens.refreshToken)).status).toBe(401);
    expect((await pool.query('SELECT count(*)::int AS n FROM sessions WHERE user_id=$1', [a.id])).rows[0].n).toBe(1);
  });
  it('failed replacement insertion rolls back consumption of the old session', async () => {
    const a = await staff();
    await pool.query(`CREATE FUNCTION rotation_test_reject_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.user_id='${a.id}'::uuid THEN RAISE EXCEPTION 'test replacement failure'; END IF; RETURN NEW; END; $$`);
    await pool.query('CREATE TRIGGER rotation_test_failure BEFORE INSERT ON sessions FOR EACH ROW EXECUTE FUNCTION rotation_test_reject_session()');
    try {
      expect((await refresh(a.tokens.refreshToken)).status).toBe(500);
      expect((await me(a.tokens.accessToken)).status).toBe(200);
      expect((await pool.query('SELECT revoked_at FROM sessions WHERE user_id=$1', [a.id])).rows).toEqual([{ revoked_at: null }]);
    } finally {
      await pool.query('DROP TRIGGER rotation_test_failure ON sessions'); await pool.query('DROP FUNCTION rotation_test_reject_session()');
    }
    expect((await refresh(a.tokens.refreshToken)).status).toBe(200);
  });
  it('refreshes two tenants concurrently while retaining tenant context and permissions', async () => {
    const a = await staff(); const b = await staff();
    const results = await Promise.all([refresh(a.tokens.refreshToken), refresh(b.tokens.refreshToken)]);
    expect(results.map(r => r.status)).toEqual([200, 200]);
    expect(results.map(r => r.body.organization.id)).toEqual([a.orgId, b.orgId]);
    for (let i = 0; i < results.length; i++) {
      const response = await me(results[i].body.accessToken);
      expect(response.body.organizationId).toBe(i === 0 ? a.orgId : b.orgId);
      expect(results[i].body.permissions).toContain('products.manage');
    }
  });
  it('MFA policy blocks refresh without losing its security audit on rollback', async () => {
    const a = await staff();
    await withTenant(pool, a.orgId, c => c.query(`UPDATE organization_settings
      SET settings=jsonb_set(settings,'{security}','{"mfaRequiredForPrivilegedRoles":true}'::jsonb)
      WHERE organization_id=$1`, [a.orgId]));
    expect((await refresh(a.tokens.refreshToken)).status).toBe(403);
    expect((await pool.query('SELECT revoked_at FROM sessions WHERE user_id=$1', [a.id])).rows).toEqual([{ revoked_at: null }]);
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_logs WHERE actor_user_id=$1 AND action='mfa.login_blocked'", [a.id])).rows[0].n).toBe(1);
  });
  it('a password reset racing refresh leaves no surviving session after reset commits', async () => {
    const a = await staff();
    await pool.query('DELETE FROM password_reset_requests');
    await request(app.getHttpServer()).post('/api/v1/auth/password-reset/request').send({ email: a.email }).expect(202);
    const results = await Promise.all([
      refresh(a.tokens.refreshToken),
      request(app.getHttpServer()).post('/api/v1/auth/password-reset/confirm').send({ token: resetToken, password: 'NewSessionPass123!' }),
    ]);
    expect(results[1].status).toBe(204); expect([200, 401]).toContain(results[0].status);
    expect((await pool.query('SELECT count(*)::int AS n FROM sessions WHERE user_id=$1 AND revoked_at IS NULL', [a.id])).rows[0].n).toBe(0);
    if (results[0].status === 200) expect((await me(results[0].body.accessToken)).status).toBe(401);
    expect((await refresh(a.tokens.refreshToken)).status).toBe(401);
  });
});
