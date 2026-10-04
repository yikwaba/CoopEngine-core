import 'reflect-metadata';
import { randomUUID, createHash } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { PasswordResetMailer } from '../src/auth/password-reset-mailer';
import { RESET_RESPONSE } from '../src/auth/password-reset.service';
import { ADMIN_PASSWORD, TEST_DATABASE_URL, ensureRbacSeeded } from './helpers';

const oldPassword = 'CoopPass123!';
const newPassword = 'RecoveryPass123!';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
describe('staff password recovery (real PostgreSQL)', () => {
  let app: INestApplication;
  let pool: Pool;
  let platform: string;
  const deliveries: { email: string; token: string }[] = [];
  const send = vi.fn(async (email: string, token: string) => { deliveries.push({ email, token }); });
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    pool = new Pool({ connectionString: TEST_DATABASE_URL });
    await ensureRbacSeeded(pool);
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PasswordResetMailer).useValue({ send }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.init();
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: 'admin@coopengine.dev', password: ADMIN_PASSWORD }).expect(200);
    platform = login.body.tokens.accessToken;
  });
  beforeEach(() => { deliveries.length = 0; send.mockClear(); });
  afterAll(async () => { await app?.close(); await pool?.end(); });
  async function staff() {
    const suffix = randomUUID().slice(0, 8);
    const email = `reset-${suffix}@coopengine.test`;
    await request(app.getHttpServer()).post('/api/v1/organizations').set('Authorization', `Bearer ${platform}`)
      .send({ name: `Reset test ${suffix}`, slug: `reset-${suffix}`, adminEmail: email, adminPassword: oldPassword }).expect(201);
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password: oldPassword }).expect(200);
    const user = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
    return { email, id: user.rows[0].id, session: login.body.tokens };
  }
  async function ask(email: string) {
    return request(app.getHttpServer()).post('/api/v1/auth/password-reset/request').send({ email }).expect(202);
  }
  async function confirm(token: string, password = newPassword) {
    return request(app.getHttpServer()).post('/api/v1/auth/password-reset/confirm').send({ token, password });
  }
  it('returns the same generic response for active, unknown and inactive identities; hashes tokens at rest', async () => {
    const a = await staff();
    expect((await ask(a.email.toUpperCase())).body).toEqual(RESET_RESPONSE);
    expect((await ask(`unknown-${randomUUID()}@coopengine.test`)).body).toEqual(RESET_RESPONSE);
    await pool.query("UPDATE users SET status='SUSPENDED' WHERE id=$1", [a.id]);
    expect((await ask(a.email)).body).toEqual(RESET_RESPONSE);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].token).toMatch(/^[a-f0-9]{64}$/);
    const stored = await pool.query('SELECT * FROM password_reset_tokens WHERE user_id=$1', [a.id]);
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0].token_hash).toBe(hash(deliveries[0].token));
    expect(JSON.stringify(stored.rows)).not.toContain(deliveries[0].token);
  });
  it('changes only the token owner password, revokes existing sessions/refresh, and prevents replay', async () => {
    const a = await staff(); const b = await staff();
    const beforeB = await pool.query('SELECT password_hash FROM users WHERE id=$1', [b.id]);
    await ask(a.email); const token = deliveries[0].token;
    const result = await confirm(token);
    expect(result.status).toBe(204);
    expect(result.headers['set-cookie'].some((c: string) => c.startsWith('ce_at=;'))).toBe(true);
    expect((await confirm(token)).status).toBe(400);
    await request(app.getHttpServer()).get('/api/v1/auth/me').set('Authorization', `Bearer ${a.session.accessToken}`).expect(401);
    await request(app.getHttpServer()).post('/api/v1/auth/refresh').send({ refreshToken: a.session.refreshToken }).expect(401);
    await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: a.email, password: oldPassword }).expect(401);
    await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: a.email, password: newPassword }).expect(200);
    expect((await pool.query('SELECT password_hash FROM users WHERE id=$1', [b.id])).rows).toEqual(beforeB.rows);
    const audit = await pool.query("SELECT metadata FROM audit_logs WHERE actor_user_id=$1 AND action='auth.password.reset'", [a.id]);
    expect(audit.rows).toEqual([{ metadata: {} }]);
  });
  it('rejects expired, unknown and suspended-user links without changing credentials', async () => {
    const a = await staff(); await ask(a.email); const token = deliveries[0].token;
    const before = await pool.query('SELECT password_hash FROM users WHERE id=$1', [a.id]);
    await pool.query("UPDATE password_reset_tokens SET expires_at=now()-interval '1 second' WHERE user_id=$1", [a.id]);
    expect((await confirm(token)).status).toBe(400);
    expect((await confirm('f'.repeat(64))).status).toBe(400);
    await ask(a.email); const next = deliveries.at(-1)!.token;
    await pool.query("UPDATE users SET status='SUSPENDED' WHERE id=$1", [a.id]);
    expect((await confirm(next)).status).toBe(400);
    expect((await pool.query('SELECT password_hash FROM users WHERE id=$1', [a.id])).rows).toEqual(before.rows);
  });
  it('concurrent consumption has one winner and invalidates sibling links', async () => {
    const a = await staff(); await ask(a.email); await ask(a.email);
    const token = deliveries[0].token; const sibling = deliveries[1].token;
    const results = await Promise.all([confirm(token), confirm(token)]);
    expect(results.map(r => r.status).sort()).toEqual([204, 400]);
    expect((await confirm(sibling)).status).toBe(400);
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_logs WHERE actor_user_id=$1 AND action='auth.password.reset'", [a.id])).rows[0].n).toBe(1);
  });
  it('limits requests by normalized identity with no account-existence disclosure', async () => {
    // Other tests share a loopback IP: clear only this dedicated recovery attempt table.
    await pool.query('DELETE FROM password_reset_requests');
    const a = await staff();
    for (let i = 0; i < 6; i++) expect((await ask(i % 2 ? a.email.toUpperCase() : a.email)).body).toEqual(RESET_RESPONSE);
    expect(deliveries).toHaveLength(5);
    const attempts = await pool.query('SELECT * FROM password_reset_requests WHERE email_hash=$1', [hash(a.email)]);
    expect(attempts.rows).toHaveLength(5);
    expect(JSON.stringify(attempts.rows)).not.toContain(a.email);
  });
  it('IP bucket bounds distributed unknown-account requests', async () => {
    await pool.query('DELETE FROM password_reset_requests');
    for (let i = 0; i < 21; i++) expect((await ask(`unknown-${randomUUID()}@coopengine.test`)).body).toEqual(RESET_RESPONSE);
    expect((await pool.query('SELECT count(*)::int AS n FROM password_reset_requests')).rows[0].n).toBe(20);
    expect(send).not.toHaveBeenCalled();
    await pool.query('DELETE FROM password_reset_requests');
  });
  it('delivery failures invalidate undelivered tokens and preserve generic response', async () => {
    const a = await staff(); send.mockRejectedValueOnce(new Error('test provider failure'));
    expect((await ask(a.email)).body).toEqual(RESET_RESPONSE);
    expect((await pool.query('SELECT * FROM password_reset_tokens WHERE user_id=$1', [a.id])).rows).toHaveLength(0);
  });
  it('password recovery preserves MFA enrollment and login challenge', async () => {
    const a = await staff();
    await pool.query("UPDATE users SET mfa_enabled=true,mfa_secret='KEEP-MFA-SECRET' WHERE id=$1", [a.id]);
    await ask(a.email); expect((await confirm(deliveries[0].token)).status).toBe(204);
    const state = await pool.query('SELECT mfa_enabled,mfa_secret FROM users WHERE id=$1', [a.id]);
    expect(state.rows[0]).toEqual({ mfa_enabled: true, mfa_secret: 'KEEP-MFA-SECRET' });
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: a.email, password: newPassword }).expect(200);
    expect(login.body.requiresMfa).toBe(true); expect(login.body.tokens).toBeUndefined();
  });
  it('audit failure rolls back password, session revocation and token consumption together', async () => {
    const a = await staff(); await ask(a.email); const token = deliveries[0].token;
    const before = await pool.query('SELECT password_hash FROM users WHERE id=$1', [a.id]);
    await pool.query(`CREATE FUNCTION reset_test_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action='auth.password.reset' AND NEW.actor_user_id='${a.id}'::uuid THEN RAISE EXCEPTION 'test reset audit failure'; END IF; RETURN NEW; END $$`);
    await pool.query('CREATE TRIGGER reset_test_audit_failure BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reset_test_reject_audit()');
    try {
      expect((await confirm(token)).status).toBe(500);
      expect((await pool.query('SELECT password_hash FROM users WHERE id=$1', [a.id])).rows).toEqual(before.rows);
      expect((await pool.query('SELECT consumed_at FROM password_reset_tokens WHERE token_hash=$1', [hash(token)])).rows[0].consumed_at).toBeNull();
      await request(app.getHttpServer()).get('/api/v1/auth/me').set('Authorization', `Bearer ${a.session.accessToken}`).expect(200);
    } finally {
      await pool.query('DROP TRIGGER reset_test_audit_failure ON audit_logs');
      await pool.query('DROP FUNCTION reset_test_reject_audit()');
    }
  });
});
