import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { Pool } from 'pg';
import { generateSecret, generateSync } from 'otplib/functional';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { PasswordResetMailer } from '../src/auth/password-reset-mailer';
import { ENV } from '../src/config/env';
import { ADMIN_PASSWORD, TEST_DATABASE_URL, ensureRbacSeeded } from './helpers';

describe('current grants and session lifecycle (PostgreSQL)', () => {
  let app: INestApplication;
  let pool: Pool;
  let auth: AuthService;
  let jwt: JwtService;
  let platform: string;
  let resetToken: string;
  const password = 'AuthorityPass123!';
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    pool = new Pool({ connectionString: TEST_DATABASE_URL });
    await ensureRbacSeeded(pool);
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PasswordResetMailer).useValue({ send: async (_email: string, token: string) => { resetToken = token; } }).compile();
    auth = module.get(AuthService); jwt = module.get(JwtService);
    app = module.createNestApplication(); app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.init();
    platform = (await login('admin@coopengine.dev', ADMIN_PASSWORD)).tokens.accessToken;
  });
  afterAll(async () => { await app?.close(); await pool?.end(); });
  async function login(email: string, suppliedPassword = password) {
    return (await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password: suppliedPassword }).expect(200)).body;
  }
  async function staff() {
    const suffix = randomUUID().slice(0, 8); const email = `authority-${suffix}@coopengine.test`;
    const org = await request(app.getHttpServer()).post('/api/v1/organizations').set('Authorization', `Bearer ${platform}`)
      .send({ name: `Authority ${suffix}`, slug: `authority-${suffix}`, adminEmail: email, adminPassword: password }).expect(201);
    const body = await login(email);
    return { email, id: body.user.id, orgId: org.body.id, tokens: body.tokens };
  }
  const me = (token: string) => request(app.getHttpServer()).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
  const products = (token: string) => request(app.getHttpServer()).get('/api/v1/products/savings').set('Authorization', `Bearer ${token}`);
  const refresh = (token: string) => request(app.getHttpServer()).post('/api/v1/auth/refresh').send({ refreshToken: token });
  const logout = (token: string) => request(app.getHttpServer()).post('/api/v1/auth/logout').set('Authorization', `Bearer ${token}`);
  async function reset(email: string) {
    await pool.query('DELETE FROM password_reset_requests');
    await request(app.getHttpServer()).post('/api/v1/auth/password-reset/request').send({ email }).expect(202);
    await request(app.getHttpServer()).post('/api/v1/auth/password-reset/confirm').send({ token: resetToken, password: 'UpdatedAuthorityPass123!' }).expect(204);
  }
  async function ownRole(a: { id: string; orgId: string }, codes: string[]) {
    const role = (await pool.query("INSERT INTO roles (organization_id,code,name,scope) VALUES ($1,$2,'Authority fixture','org') RETURNING id",
      [a.orgId, `FIXTURE_${randomUUID().slice(0, 8)}`])).rows[0].id;
    await pool.query('INSERT INTO role_permissions(role_id,permission_id) SELECT $1,id FROM permissions WHERE code=ANY($2::text[])', [role, codes]);
    await pool.query('DELETE FROM user_roles WHERE user_id=$1 AND organization_id=$2', [a.id, a.orgId]);
    await pool.query('INSERT INTO user_roles(user_id,organization_id,role_id) VALUES ($1,$2,$3)', [a.id, a.orgId, role]);
    return role;
  }
  it('old JWT immediately loses a permission removed from the current role', async () => {
    const a = await staff(); const role = await ownRole(a, ['products.view']);
    expect((await products(a.tokens.accessToken)).status).toBe(200);
    await pool.query('DELETE FROM role_permissions WHERE role_id=$1', [role]);
    expect((await products(a.tokens.accessToken)).status).toBe(403);
    const result = await me(a.tokens.accessToken); expect(result.status).toBe(200);
    expect(result.body.permissions).toEqual([]);
    // A current grant also becomes available without waiting for JWT refresh.
    await pool.query("INSERT INTO role_permissions(role_id,permission_id) SELECT $1,id FROM permissions WHERE code='products.view'", [role]);
    expect((await products(a.tokens.accessToken)).status).toBe(200);
  });
  it('role replacement takes effect on bearer and cookie requests immediately', async () => {
    const a = await staff(); await ownRole(a, ['members.view']);
    expect((await products(a.tokens.accessToken)).status).toBe(403);
    const result = await request(app.getHttpServer()).get('/api/v1/auth/me').set('Cookie', `ce_at=${a.tokens.accessToken}`).expect(200);
    expect(result.body.permissions).toEqual(['members.view']);
  });
  it('removed membership denies access even when another tenant has the same grants', async () => {
    const a = await staff(); const b = await staff();
    const role = (await pool.query("SELECT id FROM roles WHERE code='COOP_ADMIN' AND organization_id IS NULL")).rows[0].id;
    await pool.query('INSERT INTO user_roles(user_id,organization_id,role_id) VALUES ($1,$2,$3)', [a.id, b.orgId, role]);
    await pool.query('DELETE FROM user_roles WHERE user_id=$1 AND organization_id=$2', [a.id, a.orgId]);
    expect((await me(a.tokens.accessToken)).status).toBe(401);
    expect((await products(a.tokens.accessToken)).status).toBe(401);
    expect((await refresh(a.tokens.refreshToken)).status).toBe(401);
  });
  it('JWT organization must match its persisted session context', async () => {
    const a = await staff(); const b = await staff();
    const claims = jwt.decode(a.tokens.accessToken) as { sub: string; sid: string; perms: string[] };
    const forgedContext = jwt.sign({ sub: claims.sub, sid: claims.sid, org: b.orgId, perms: claims.perms }, { secret: ENV.jwtAccessSecret });
    expect((await me(forgedContext)).status).toBe(401);
    expect((await logout(forgedContext)).status).toBe(401);
  });
  it('a login proof verified before password reset cannot issue a session afterward', async () => {
    const a = await staff(); const checked = await auth.authenticate(a.email, password);
    await reset(a.email);
    await expect(auth.issueForUser(a.id, undefined, undefined, undefined, { authVersion: checked.authVersion, mfaVerified: false })).rejects.toMatchObject({ status: 401 });
    expect((await pool.query('SELECT count(*)::int AS n FROM sessions WHERE user_id=$1 AND revoked_at IS NULL', [a.id])).rows[0].n).toBe(0);
    expect((await login(a.email, 'UpdatedAuthorityPass123!')).tokens.accessToken).toBeTruthy();
  });
  it('password reset invalidates a pending MFA challenge while preserving enrollment', async () => {
    const a = await staff(); const secret = generateSecret();
    await pool.query('UPDATE users SET mfa_enabled=true,mfa_secret=$1 WHERE id=$2', [secret, a.id]);
    const challenge = await login(a.email); expect(challenge.requiresMfa).toBe(true);
    await reset(a.email);
    await request(app.getHttpServer()).post('/api/v1/auth/mfa/login-verify').send({ mfaToken: challenge.mfaToken, code: generateSync({ secret }) }).expect(401);
    const next = await login(a.email, 'UpdatedAuthorityPass123!'); expect(next.requiresMfa).toBe(true);
    const verified = await request(app.getHttpServer()).post('/api/v1/auth/mfa/login-verify').send({ mfaToken: next.mfaToken, code: generateSync({ secret }) }).expect(200);
    expect(verified.body.tokens.accessToken).toBeTruthy();
  });
  it('enabling MFA after password verification cannot bypass the second factor', async () => {
    const a = await staff(); const checked = await auth.authenticate(a.email, password);
    await pool.query('UPDATE users SET mfa_enabled=true,mfa_secret=$1 WHERE id=$2', [generateSecret(), a.id]);
    await expect(auth.issueForUser(a.id, undefined, undefined, undefined, { authVersion: checked.authVersion, mfaVerified: false })).rejects.toMatchObject({ status: 401 });
  });
  it('a predecessor logs out its replacements, but preserves an independent device login', async () => {
    const a = await staff(); const independent = (await login(a.email)).tokens;
    const first = (await refresh(a.tokens.refreshToken).expect(200)).body;
    const second = (await refresh(first.refreshToken).expect(200)).body;
    const rows = (await pool.query('SELECT family_id FROM sessions WHERE user_id=$1 ORDER BY created_at', [a.id])).rows;
    expect(new Set(rows.map(r => r.family_id)).size).toBe(2);
    expect((await me(a.tokens.accessToken)).status).toBe(401);
    await logout(a.tokens.accessToken).expect(204);
    expect((await me(second.accessToken)).status).toBe(401);
    expect((await refresh(second.refreshToken)).status).toBe(401);
    expect((await me(independent.accessToken)).status).toBe(200);
    await logout(a.tokens.accessToken).expect(204); // idempotent within JWT lifetime
  });
  it('logout racing refresh leaves no live replacement in the logged-out family', async () => {
    const a = await staff();
    const results = await Promise.all([refresh(a.tokens.refreshToken), logout(a.tokens.accessToken)]);
    expect(results[1].status).toBe(204); expect([200, 401]).toContain(results[0].status);
    expect((await pool.query('SELECT count(*)::int AS n FROM sessions WHERE user_id=$1 AND revoked_at IS NULL', [a.id])).rows[0].n).toBe(0);
    if (results[0].status === 200) expect((await me(results[0].body.accessToken)).status).toBe(401);
  });
  it('removing membership still permits logout, and never restores ordinary access', async () => {
    const a = await staff(); const replacement = (await refresh(a.tokens.refreshToken).expect(200)).body;
    await pool.query('DELETE FROM user_roles WHERE user_id=$1', [a.id]);
    await logout(a.tokens.accessToken).expect(204);
    expect((await me(replacement.accessToken)).status).toBe(401);
    expect((await refresh(replacement.refreshToken)).status).toBe(401);
  });
});
