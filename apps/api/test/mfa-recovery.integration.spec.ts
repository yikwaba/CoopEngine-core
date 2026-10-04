import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { withTenant } from '@coopengine/db';
import { generateSync } from 'otplib/functional';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { mfaDigest } from '../src/auth/mfa-flow.service';
import { PasswordResetMailer } from '../src/auth/password-reset-mailer';
import { ADMIN_PASSWORD, TEST_DATABASE_URL, ensureRbacSeeded } from './helpers';

describe('limited enrollment, challenges and recovery (PostgreSQL)', () => {
  let app: INestApplication; let pool: Pool; let platform: string; let resetToken: string;
  const password = 'RecoveryFactorPass123!';
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL; pool = new Pool({ connectionString: TEST_DATABASE_URL }); await ensureRbacSeeded(pool);
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(PasswordResetMailer)
      .useValue({ send: async (_email: string, token: string) => { resetToken = token; } }).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api/v1'); app.useGlobalPipes(new ValidationPipe({ whitelist:true, transform:true, forbidNonWhitelisted:true })); await app.init();
    platform = (await login('admin@coopengine.dev', ADMIN_PASSWORD).expect(200)).body.tokens.accessToken;
  });
  afterAll(async () => { await app?.close(); await pool?.end(); });
  const login = (email: string, value = password) => request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password:value });
  const me = (token: string) => request(app.getHttpServer()).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
  const confirm = (token: string, secret: string) => request(app.getHttpServer()).post('/api/v1/auth/mfa/enroll').send({ mfaToken:token, code:generateSync({ secret }) });
  const verify = (token: string, secret: string) => request(app.getHttpServer()).post('/api/v1/auth/mfa/login-verify').send({ mfaToken:token, code:generateSync({ secret }) });
  const recover = (token: string, code: string) => request(app.getHttpServer()).post('/api/v1/auth/mfa/recover').send({ mfaToken:token, recoveryCode:code });
  async function staff() {
    const suffix=randomUUID().slice(0,8), email=`mfa-flow-${suffix}@coopengine.test`;
    const org=await request(app.getHttpServer()).post('/api/v1/organizations').set('Authorization',`Bearer ${platform}`)
      .send({ name:`MFA ${suffix}`, slug:`mfa-${suffix}`, adminEmail:email, adminPassword:password }).expect(201);
    const body=(await login(email).expect(200)).body;
    return { email, orgId:org.body.id as string, id:body.user.id as string, tokens:body.tokens };
  }
  async function policy(a:{orgId:string}) {
    await withTenant(pool,a.orgId,c=>c.query(`UPDATE organization_settings SET settings=jsonb_set(settings,'{security}','{"mfaRequiredForPrivilegedRoles":true}'::jsonb) WHERE organization_id=$1`,[a.orgId]));
  }
  async function enrolled() {
    const a=await staff(); const setup=(await request(app.getHttpServer()).post('/api/v1/auth/mfa/setup').set('Authorization',`Bearer ${a.tokens.accessToken}`).expect(201)).body;
    const outcome=(await confirm(setup.mfaToken,setup.secret).expect(200)).body;
    return { ...a, secret:setup.secret as string, codes:outcome.recoveryCodes as string[], tokens:outcome.tokens };
  }
  it('required staff can enroll without an ordinary session or setup lockout',async()=>{
    const a=await staff(); await policy(a);
    await me(a.tokens.accessToken).expect(401);
    await request(app.getHttpServer()).post('/api/v1/auth/refresh').send({refreshToken:a.tokens.refreshToken}).expect(403);
    const first=await login(a.email).expect(200);
    expect(first.body.requiresMfaEnrollment).toBe(true); expect(first.body.tokens).toBeUndefined();
    expect(first.headers['cache-control']).toBe('no-store');
    await me(first.body.mfaToken).expect(401);
    const enabled=(await confirm(first.body.mfaToken,first.body.enrollment.secret).expect(200)).body;
    expect(enabled.recoveryCodes).toHaveLength(10); await me(enabled.tokens.accessToken).expect(200);
    await confirm(first.body.mfaToken,first.body.enrollment.secret).expect(401);
    expect((await pool.query('SELECT mfa_verified FROM sessions WHERE user_id=$1 AND revoked_at IS NULL',[a.id])).rows).toEqual([{mfa_verified:true}]);
  });
  it('production platform privilege cannot opt out even with no tenant policy',async()=>{
    const env=process.env.NODE_ENV;
    try {
      process.env.NODE_ENV='production';
      const first=await login('admin@coopengine.dev',ADMIN_PASSWORD).expect(200);
      expect(first.body.requiresMfaEnrollment).toBe(true); expect(first.body.tokens).toBeUndefined();
      await me(platform).expect(401);
    } finally { process.env.NODE_ENV=env; }
  });
  it('multi-cooperative enrollment stays limited until a current membership is selected',async()=>{
    const a=await staff();
    const otherSlug=`mfa-other-${randomUUID().slice(0,8)}`;
    await request(app.getHttpServer()).post('/api/v1/organizations').set('Authorization',`Bearer ${platform}`)
      .send({name:'MFA second synthetic cooperative',slug:otherSlug,adminEmail:a.email,adminPassword:password}).expect(201);
    await policy(a);
    const first=(await login(a.email).expect(200)).body;
    const pending=(await confirm(first.mfaToken,first.enrollment.secret).expect(200)).body;
    expect(pending.requiresOrgSelection).toBe(true); expect(pending.tokens).toBeUndefined(); expect(pending.recoveryCodes).toBeUndefined();
    await request(app.getHttpServer()).post('/api/v1/auth/mfa/enroll')
      .send({mfaToken:first.mfaToken,code:generateSync({secret:first.enrollment.secret}),organizationSlug:'not-a-membership'}).expect(401);
    expect((await pool.query('SELECT mfa_enabled FROM users WHERE id=$1',[a.id])).rows[0].mfa_enabled).toBe(false);
    const enabled=(await request(app.getHttpServer()).post('/api/v1/auth/mfa/enroll')
      .send({mfaToken:first.mfaToken,code:generateSync({secret:first.enrollment.secret}),organizationSlug:otherSlug}).expect(200)).body;
    expect(enabled.recoveryCodes).toHaveLength(10);
    const identity=(await me(enabled.tokens.accessToken).expect(200)).body;
    expect(identity.organizationSlug).toBe(otherSlug);
  });
  it('enabled authenticator cannot be overwritten by setup; mandatory MFA cannot be disabled',async()=>{
    const a=await enrolled(); await policy(a);
    await request(app.getHttpServer()).post('/api/v1/auth/mfa/setup').set('Authorization',`Bearer ${a.tokens.accessToken}`).expect(409);
    await request(app.getHttpServer()).post('/api/v1/auth/mfa/disable').set('Authorization',`Bearer ${a.tokens.accessToken}`).send({code:generateSync({secret:a.secret})}).expect(403);
    expect((await pool.query('SELECT mfa_secret,mfa_enabled FROM users WHERE id=$1',[a.id])).rows[0]).toMatchObject({mfa_secret:a.secret,mfa_enabled:true});
  });
  it('custom withdrawal-only privilege cannot bypass mandatory MFA after role escalation',async()=>{
    const a=await staff();
    const role=(await pool.query("INSERT INTO roles(organization_id,code,name,scope) VALUES($1,$2,'Synthetic withdrawal role','org') RETURNING id",[a.orgId,`MFA_CUSTOM_${randomUUID().slice(0,8)}`])).rows[0].id;
    await pool.query("INSERT INTO role_permissions(role_id,permission_id) SELECT $1,id FROM permissions WHERE code='savings.withdraw'",[role]);
    await pool.query('DELETE FROM user_roles WHERE user_id=$1',[a.id]);
    await pool.query('INSERT INTO user_roles(user_id,organization_id,role_id) VALUES($1,$2,$3)',[a.id,a.orgId,role]);
    const env=process.env.NODE_ENV;
    try {
      process.env.NODE_ENV='production';
      await me(a.tokens.accessToken).expect(401);
      await request(app.getHttpServer()).post('/api/v1/auth/refresh').send({refreshToken:a.tokens.refreshToken}).expect(403);
      const first=(await login(a.email).expect(200)).body;
      expect(first.requiresMfaEnrollment).toBe(true); expect(first.tokens).toBeUndefined();
      const enabled=(await confirm(first.mfaToken,first.enrollment.secret).expect(200)).body;
      expect((await me(enabled.tokens.accessToken).expect(200)).body.permissions).toEqual(['savings.withdraw']);
    } finally { process.env.NODE_ENV=env; }
  });
  it('concurrent enrollment has one winner with one active session and code set',async()=>{
    const a=await staff(); await policy(a); const first=(await login(a.email).expect(200)).body;
    const results=await Promise.all([confirm(first.mfaToken,first.enrollment.secret),confirm(first.mfaToken,first.enrollment.secret)]);
    expect(results.map(r=>r.status).sort()).toEqual([200,401]);
    expect((await pool.query('SELECT count(*)::int AS n FROM sessions WHERE user_id=$1 AND revoked_at IS NULL',[a.id])).rows[0].n).toBe(1);
    expect((await pool.query('SELECT count(*)::int AS n FROM mfa_recovery_codes WHERE user_id=$1',[a.id])).rows[0].n).toBe(10);
  });
  it('twelve concurrent MFA submissions issue one session and reject replay',async()=>{
    const a=await enrolled(); const start=(await login(a.email).expect(200)).body;
    const before=(await pool.query('SELECT count(*)::int AS n FROM sessions WHERE user_id=$1',[a.id])).rows[0].n;
    const results=await Promise.all(Array.from({length:12},()=>verify(start.mfaToken,a.secret)));
    expect(results.filter(r=>r.status===200)).toHaveLength(1); expect(results.filter(r=>r.status===401)).toHaveLength(11);
    expect((await pool.query('SELECT count(*)::int AS n FROM sessions WHERE user_id=$1',[a.id])).rows[0].n).toBe(before+1);
    await verify(start.mfaToken,a.secret).expect(401);
  });
  it('five wrong codes exhaust a challenge; creating fresh challenges is capped',async()=>{
    const a=await enrolled(); const start=(await login(a.email).expect(200)).body;
    const wrong=generateSync({secret:a.secret})==='000000'?'111111':'000000';
    for(let n=0;n<5;n++) await request(app.getHttpServer()).post('/api/v1/auth/mfa/login-verify').send({mfaToken:start.mfaToken,code:wrong}).expect(401);
    await verify(start.mfaToken,a.secret).expect(401);
    for(let n=0;n<3;n++) await login(a.email).expect(200);
    await login(a.email).expect(429);
  });
  it('expired and wrong-purpose enrollment credentials grant no access',async()=>{
    const a=await staff(); const setup=(await request(app.getHttpServer()).post('/api/v1/auth/mfa/setup').set('Authorization',`Bearer ${a.tokens.accessToken}`).expect(201)).body;
    await verify(setup.mfaToken,setup.secret).expect(401); await recover(setup.mfaToken,'aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa').expect(401);
    await pool.query("UPDATE mfa_challenges SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",[mfaDigest(setup.mfaToken)]);
    await confirm(setup.mfaToken,setup.secret).expect(401);
    expect((await pool.query('SELECT mfa_enabled FROM users WHERE id=$1',[a.id])).rows[0].mfa_enabled).toBe(false);
  });
  it('password reset invalidates pending enrollment and does not silently enable MFA',async()=>{
    const a=await staff(); await policy(a); const first=(await login(a.email).expect(200)).body;
    await pool.query('DELETE FROM password_reset_requests');
    await request(app.getHttpServer()).post('/api/v1/auth/password-reset/request').send({email:a.email}).expect(202);
    await request(app.getHttpServer()).post('/api/v1/auth/password-reset/confirm').send({token:resetToken,password:'ChangedMfaPassword123!'}).expect(204);
    await confirm(first.mfaToken,first.enrollment.secret).expect(401);
    expect((await login(a.email,'ChangedMfaPassword123!').expect(200)).body.requiresMfaEnrollment).toBe(true);
  });
  it('backup recovery revokes sessions, grants enrollment only and replaces the factor',async()=>{
    const a=await enrolled(); await policy(a); const start=(await login(a.email).expect(200)).body;
    const recovered=(await recover(start.mfaToken,a.codes[0]).expect(200)).body;
    expect(recovered.requiresMfaEnrollment).toBe(true); expect(recovered.tokens).toBeUndefined();
    await me(a.tokens.accessToken).expect(401); await me(recovered.mfaToken).expect(401);
    await recover(start.mfaToken,a.codes[0]).expect(401);
    const next=(await confirm(recovered.mfaToken,recovered.enrollment.secret).expect(200)).body;
    expect(next.recoveryCodes).toHaveLength(10); expect(next.recoveryCodes).not.toContain(a.codes[0]); await me(next.tokens.accessToken).expect(200);
    const challenge=(await login(a.email).expect(200)).body;
    await recover(challenge.mfaToken,a.codes[0]).expect(401);
    const rows=(await pool.query('SELECT code_hash FROM mfa_recovery_codes WHERE user_id=$1',[a.id])).rows;
    expect(rows).toHaveLength(10); expect(rows.every(r=>/^[a-f0-9]{64}$/.test(r.code_hash))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(next.recoveryCodes[0]);
  });
  it('one backup code racing twice has one winner and leaves no ordinary session',async()=>{
    const a=await enrolled(); const challenge=(await login(a.email).expect(200)).body;
    const results=await Promise.all([recover(challenge.mfaToken,a.codes[0]),recover(challenge.mfaToken,a.codes[0])]);
    expect(results.map(r=>r.status).sort()).toEqual([200,401]);
    expect((await pool.query('SELECT count(*)::int AS n FROM sessions WHERE user_id=$1 AND revoked_at IS NULL',[a.id])).rows[0].n).toBe(0);
  });
  it('recovery codes require password plus current factor to regenerate; old codes expire',async()=>{
    const a=await enrolled(); const endpoint=()=>request(app.getHttpServer()).post('/api/v1/auth/mfa/recovery-codes').set('Authorization',`Bearer ${a.tokens.accessToken}`);
    await endpoint().send({password:'WrongPassword123!',code:generateSync({secret:a.secret})}).expect(401);
    const result=await endpoint().send({password,code:generateSync({secret:a.secret})}).expect(200);
    expect(result.headers['cache-control']).toBe('no-store'); expect(result.body.recoveryCodes).toHaveLength(10);
    const challenge=(await login(a.email).expect(200)).body; await recover(challenge.mfaToken,a.codes[0]).expect(401);
    await recover(challenge.mfaToken,result.body.recoveryCodes[0]).expect(200);
  });
});
