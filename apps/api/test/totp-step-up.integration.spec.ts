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
import { MfaClock } from '../src/auth/mfa-clock';
import { ADMIN_PASSWORD, TEST_DATABASE_URL, ensureRbacSeeded } from './helpers';

const clock={value:Math.floor(Date.now()/1000),now(){return this.value;}};
const password='SyntheticStepUpPass123!';
describe('global TOTP replay and sensitive-action enforcement (PostgreSQL)',()=>{
  let app:INestApplication,pool:Pool,platform:string;
  beforeAll(async()=>{
    process.env.DATABASE_URL=TEST_DATABASE_URL;pool=new Pool({connectionString:TEST_DATABASE_URL});await ensureRbacSeeded(pool);
    const module=await Test.createTestingModule({imports:[AppModule]}).overrideProvider(MfaClock).useValue(clock).compile();
    app=module.createNestApplication();app.setGlobalPrefix('api/v1');app.useGlobalPipes(new ValidationPipe({whitelist:true,transform:true,forbidNonWhitelisted:true}));await app.init();
    platform=(await login('admin@coopengine.dev',ADMIN_PASSWORD).expect(200)).body.tokens.accessToken;
  });
  afterAll(async()=>{await app?.close();await pool?.end();});
  const login=(email:string,pw=password)=>request(app.getHttpServer()).post('/api/v1/auth/login').send({email,password:pw});
  const code=(secret:string)=>generateSync({secret,epoch:clock.now()});
  async function staff(){
    const suffix=randomUUID().slice(0,8),email=`step-up-${suffix}@coopengine.test`;
    const org=(await request(app.getHttpServer()).post('/api/v1/organizations').set('Authorization',`Bearer ${platform}`)
      .send({name:`Step up ${suffix}`,slug:`step-up-${suffix}`,adminEmail:email,adminPassword:password}).expect(201)).body;
    const initial=(await login(email).expect(200)).body;
    const setup=(await request(app.getHttpServer()).post('/api/v1/auth/mfa/setup').set('Authorization',`Bearer ${initial.tokens.accessToken}`).expect(201)).body;
    const enabled=(await request(app.getHttpServer()).post('/api/v1/auth/mfa/enroll').send({mfaToken:setup.mfaToken,code:code(setup.secret)}).expect(200)).body;
    await withTenant(pool,org.id,c=>c.query(`UPDATE organization_settings SET settings=jsonb_set(settings,'{security}','{"requireStepUpForSensitiveMoney":true}'::jsonb) WHERE organization_id=$1`,[org.id]));
    return {email,id:initial.user.id as string,orgId:org.id as string,secret:setup.secret as string,token:enabled.tokens.accessToken as string};
  }
  const policy=(a:{token:string},otp?:string,threshold=0)=>{
    const req=request(app.getHttpServer()).patch('/api/v1/savings/settings/withdrawal-approval').set('Authorization',`Bearer ${a.token}`);
    if(otp)req.set('X-CoopEngine-Step-Up',otp);return req.send({threshold});
  };
  it('the enrollment code cannot be reused in a fresh login challenge or a money gate',async()=>{
    const a=await staff(),challenge=(await login(a.email).expect(200)).body;
    await request(app.getHttpServer()).post('/api/v1/auth/mfa/login-verify').send({mfaToken:challenge.mfaToken,code:code(a.secret)}).expect(401);
    const refusal=await policy(a,code(a.secret)).expect(403);expect(refusal.body.code).toBe('STEP_UP_INVALID');
    clock.value+=30;await policy(a,code(a.secret)).expect(200);
  });
  it('two different login challenges racing one time step issue exactly one session',async()=>{
    const a=await staff();clock.value+=30;
    const challenges=await Promise.all([login(a.email).expect(200),login(a.email).expect(200)]);
    const before=(await pool.query('SELECT count(*)::int AS n FROM sessions WHERE user_id=$1',[a.id])).rows[0].n;
    const results=await Promise.all(challenges.map(c=>request(app.getHttpServer()).post('/api/v1/auth/mfa/login-verify').send({mfaToken:c.body.mfaToken,code:code(a.secret)})));
    expect(results.map(r=>r.status).sort()).toEqual([200,401]);
    expect((await pool.query('SELECT count(*)::int AS n FROM sessions WHERE user_id=$1',[a.id])).rows[0].n).toBe(before+1);
  });
  it('a login and sensitive action racing the same code have one winner',async()=>{
    const a=await staff();clock.value+=30;const challenge=(await login(a.email).expect(200)).body;
    const [signin,action]=await Promise.all([
      request(app.getHttpServer()).post('/api/v1/auth/mfa/login-verify').send({mfaToken:challenge.mfaToken,code:code(a.secret)}),policy(a,code(a.secret))]);
    expect([signin.status,action.status].filter(s=>s===200)).toHaveLength(1);
    expect([signin.status,action.status].filter(s=>s===401||s===403)).toHaveLength(1);
  });
  it('concurrent different policy operations cannot reuse the same code',async()=>{
    const a=await staff();clock.value+=30;
    const results=await Promise.all([policy(a,code(a.secret),0),policy(a,code(a.secret),100)]);
    expect(results.map(r=>r.status).sort()).toEqual([200,403]);
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_logs WHERE actor_user_id=$1 AND action='stepup.verified'",[a.id])).rows[0].n).toBe(1);
  });
  it('wrong codes are counted globally across sessions/routes and block the sixth attempt',async()=>{
    const a=await staff();clock.value+=30;const wrong=code(a.secret)==='000000'?'111111':'000000';
    const results=await Promise.all(Array.from({length:8},()=>policy(a,wrong)));
    expect(results.filter(r=>r.status===403)).toHaveLength(5);expect(results.filter(r=>r.status===429)).toHaveLength(3);
    expect((await pool.query('SELECT count(*)::int AS n FROM mfa_stepup_failures WHERE user_id=$1',[a.id])).rows[0].n).toBe(5);
    await policy(a,code(a.secret)).expect(429);
    await pool.query("UPDATE mfa_stepup_failures SET attempted_at=clock_timestamp()-interval '16 minutes' WHERE user_id=$1",[a.id]);
    await policy(a,code(a.secret)).expect(200);
  });
  it('missing verification makes no change and permission denial happens before any code claim',async()=>{
    const a=await staff();clock.value+=30;
    expect((await policy(a).expect(403)).body.code).toBe('STEP_UP_REQUIRED');
    await pool.query('DELETE FROM user_roles WHERE user_id=$1',[a.id]);
    await pool.query("INSERT INTO user_roles(user_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code='MEMBER' AND organization_id IS NULL",[a.id,a.orgId]);
    await policy(a,code(a.secret)).expect(403);
    const previous=(await pool.query('SELECT last_step FROM mfa_used_steps WHERE user_id=$1',[a.id])).rows[0];
    expect(Number(previous.last_step)).toBeLessThan(Math.floor(clock.now()/30));
  });
  it('production sensitive-action policy cannot be disabled by a tenant setting',async()=>{
    const a=await staff();await withTenant(pool,a.orgId,c=>c.query("UPDATE organization_settings SET settings='{}'::jsonb WHERE organization_id=$1",[a.orgId]));
    const env=process.env.NODE_ENV;
    try{process.env.NODE_ENV='production';expect((await policy(a).expect(403)).body.code).toBe('STEP_UP_REQUIRED');}
    finally{process.env.NODE_ENV=env;}
  });
  it('an accepted code stays consumed when controller validation/business work fails',async()=>{
    const a=await staff();clock.value+=30;
    await request(app.getHttpServer()).post(`/api/v1/ledger/journals/${randomUUID()}/approve-post`).set('Authorization',`Bearer ${a.token}`)
      .set('X-CoopEngine-Step-Up',code(a.secret)).send({}).expect(404);
    expect((await policy(a,code(a.secret)).expect(403)).body.code).toBe('STEP_UP_INVALID');
    clock.value+=30;await policy(a,code(a.secret)).expect(200);
  });
  it('password reset/session revocation cannot reset the authenticator replay counter',async()=>{
    const a=await staff();const before=(await pool.query('SELECT secret_hash,last_step FROM mfa_used_steps WHERE user_id=$1',[a.id])).rows[0];
    await pool.query('UPDATE users SET auth_version=auth_version+1 WHERE id=$1',[a.id]);
    await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE user_id=$1',[a.id]);
    const challenge=(await login(a.email).expect(200)).body;
    await request(app.getHttpServer()).post('/api/v1/auth/mfa/login-verify').send({mfaToken:challenge.mfaToken,code:code(a.secret)}).expect(401);
    expect((await pool.query('SELECT secret_hash,last_step FROM mfa_used_steps WHERE user_id=$1',[a.id])).rows[0]).toEqual(before);
  });
});
