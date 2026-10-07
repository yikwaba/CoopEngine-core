import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { withTenant } from '@coopengine/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { ADMIN_PASSWORD, TEST_DATABASE_URL, ensureRbacSeeded } from './helpers';

describe('journal submission receipts (PostgreSQL)',()=>{
 let app:INestApplication,pool:Pool,platform:string;
 beforeAll(async()=>{
  process.env.DATABASE_URL=TEST_DATABASE_URL;pool=new Pool({connectionString:TEST_DATABASE_URL});await ensureRbacSeeded(pool);
  const module=await Test.createTestingModule({imports:[AppModule]}).compile();app=module.createNestApplication();app.setGlobalPrefix('api/v1');app.useGlobalPipes(new ValidationPipe({whitelist:true,transform:true,forbidNonWhitelisted:true}));await app.init();
  platform=(await request(app.getHttpServer()).post('/api/v1/auth/login').send({email:'admin@coopengine.dev',password:ADMIN_PASSWORD}).expect(200)).body.tokens.accessToken;
 });
 afterAll(async()=>{await app?.close();await pool?.end();});
 async function fixture(count=1){
  const suffix=randomUUID().slice(0,8),email=`journal-submit-${suffix}@coopengine.test`;
  const org=(await request(app.getHttpServer()).post('/api/v1/organizations').set('Authorization',`Bearer ${platform}`).send({name:`Journal submit ${suffix}`,slug:`journal-submit-${suffix}`,adminEmail:email,adminPassword:'ExactPayrollPass123!'}).expect(201)).body.id;
  const token=(await request(app.getHttpServer()).post('/api/v1/auth/login').send({email,password:'ExactPayrollPass123!'}).expect(200)).body.tokens.accessToken;
  const auth={Authorization:`Bearer ${token}`};
  const invited=(await request(app.getHttpServer()).post('/api/v1/users').set(auth).send({email:`checker-${suffix}@coopengine.test`,roleCodes:['COOP_ADMIN']}).expect(201)).body;
  const checkerToken=(await request(app.getHttpServer()).post('/api/v1/auth/login').send({email:invited.email,password:invited.tempPassword}).expect(200)).body.tokens.accessToken;
  const checker={Authorization:`Bearer ${checkerToken}`},members:{id:string;memberNo:number}[]=[];
  for(let i=0;i<count;i++){
   const member=(await request(app.getHttpServer()).post('/api/v1/members').set(auth).send({firstName:`Exact ${i}`,lastName:'Synthetic'}).expect(201)).body;
   await request(app.getHttpServer()).post(`/api/v1/members/${member.id}/approve`).set(auth).expect(200);members.push({id:member.id,memberNo:member.memberNo});
  }
  const tenant=<T>(fn:Parameters<typeof withTenant<T>>[2])=>withTenant(pool,org,fn);
  const actor=(await request(app.getHttpServer()).get('/api/v1/auth/me').set(auth).expect(200)).body.user.id as string;
  const key=randomUUID(),date=new Date().toISOString().slice(0,10);
  const account=(await request(app.getHttpServer()).post(`/api/v1/savings/member/${members[0]!.id}/account`).set(auth).send({}).expect(201)).body.id;
  await request(app.getHttpServer()).post(`/api/v1/savings/accounts/${account}/deposits`).set(auth).send({idempotencyKey:randomUUID(),amount:1.15}).expect(201);
  const journalBody={idempotencyKey:key,entryDate:date,description:'Synthetic draft',lines:[{accountCode:'5010',debit:0.23,memo:'Original memo'},{accountCode:'1000',credit:0.23}]};
  const send=(path:string,body:unknown,headers=auth)=>request(app.getHttpServer()).post('/api/v1'+path).set(headers).send(body);
  const snapshot=()=>tenant(async c=>{const result:Record<string,unknown>={};for(const table of ['ledger_periods','loans','loan_guarantors','loan_repayments','financial_write_receipts','audit_logs','journal_entries','journal_lines','member_savings_accounts','savings_transactions','org_counters'])result[table]=(await c.query(`SELECT * FROM ${table} WHERE organization_id=$1 ORDER BY ${table==='org_counters'?'organization_id':'id'}`,[org])).rows;return result;});
  const id=(await send('/ledger/journals',journalBody).expect(201)).body.id as string;
  const submit=(journalId=id,headers=auth)=>send(`/ledger/journals/${journalId}/submit`,{},headers);
  return{org,auth,checker,members,tenant,actor,key,journalBody,send,snapshot,id,submit};
 }

 it('concurrent submissions retain one original response and audit without money',async()=>{const f=await fixture(),before=await f.snapshot(),r=await Promise.all([f.submit().expect(200),f.submit().expect(200)]);expect(r[0].body).toEqual(r[1].body);expect(r[0].body.status).toBe('SUBMITTED');const after=await f.snapshot();expect((after.financial_write_receipts as {action:string}[]).filter(r=>r.action==='ledger.submit')).toHaveLength(1);expect((after.audit_logs as {action:string}[]).filter(r=>r.action==='journal.submitted')).toHaveLength(1);for(const table of ['journal_lines','member_savings_accounts','savings_transactions','org_counters','loans','loan_repayments'])expect(after[table]).toEqual(before[table]);await f.submit().expect(200);expect(await f.snapshot()).toEqual(after);});
 it('changed actor cannot replay original submission',async()=>{const f=await fixture();await f.submit().expect(200);const s=await f.snapshot();await f.submit(f.id,f.checker).expect(409);expect(await f.snapshot()).toEqual(s);});
 it('unauthenticated submission refuses without mutations',async()=>{const f=await fixture(),s=await f.snapshot();await request(app.getHttpServer()).post(`/api/v1/ledger/journals/${f.id}/submit`).send({}).expect(401);expect(await f.snapshot()).toEqual(s);});
 it('current grants gate completed replay',async()=>{const f=await fixture();await f.submit().expect(200);await pool.query('DELETE FROM user_roles WHERE user_id=$1',[f.actor]);const s=await f.snapshot();await f.submit().expect(401);expect(await f.snapshot()).toEqual(s);});
 it('changed account scope refuses before mutation',async()=>{const f=await fixture(),s=await f.snapshot();await f.submit().set('X-CoopEngine-Financial-Scope',`${randomUUID()}:${f.actor}`).expect(409);expect(await f.snapshot()).toEqual(s);});
 it('invalid unknown and foreign journal IDs leave no receipt',async()=>{const f=await fixture(),g=await fixture(),s=await f.snapshot();await f.submit('invalid').expect(400);await f.submit(randomUUID()).expect(404);await f.submit(g.id).expect(404);expect(await f.snapshot()).toEqual(s);});
 it('receipt finalization failure rolls back state and audit, then permits retry',async()=>{const f=await fixture(),s=await f.snapshot();await pool.query(`CREATE FUNCTION journal_submit_test_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ledger.submit' AND NEW.response IS NOT NULL AND NEW.organization_id='${f.org}'::uuid THEN RAISE EXCEPTION 'synthetic journal submission receipt failure'; END IF; RETURN NEW; END; $$`);await pool.query('CREATE TRIGGER journal_submit_test_fault BEFORE UPDATE ON financial_write_receipts FOR EACH ROW EXECUTE FUNCTION journal_submit_test_fault()');try{await f.submit().expect(500);expect(await f.snapshot()).toEqual(s);}finally{await pool.query('DROP TRIGGER journal_submit_test_fault ON financial_write_receipts');await pool.query('DROP FUNCTION journal_submit_test_fault()');}await f.submit().expect(200);});
 it('audit failure rolls back state and receipt',async()=>{const f=await fixture(),s=await f.snapshot();await pool.query(`CREATE FUNCTION journal_submit_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='journal.submitted' AND NEW.organization_id='${f.org}'::uuid THEN RAISE EXCEPTION 'synthetic journal submit audit failure'; END IF; RETURN NEW; END; $$`);await pool.query('CREATE TRIGGER journal_submit_audit_fault BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION journal_submit_audit_fault()');try{await f.submit().expect(500);expect(await f.snapshot()).toEqual(s);}finally{await pool.query('DROP TRIGGER journal_submit_audit_fault ON audit_logs');await pool.query('DROP FUNCTION journal_submit_audit_fault()');}await f.submit().expect(200);});
 it('replays after posting reversal and locking without resetting state or money',async()=>{const f=await fixture(),original=(await f.submit().expect(200)).body;await f.send(`/ledger/journals/${f.id}/approve-post`,{},f.checker).expect(200);let s=await f.snapshot();expect((await f.submit().expect(200)).body).toEqual(original);expect(await f.snapshot()).toEqual(s);await f.send(`/ledger/journals/${f.id}/reverse`,{reason:'Synthetic reversal'}).expect(200);await f.tenant(c=>c.query("UPDATE ledger_periods SET status='LOCKED'"));s=await f.snapshot();expect((await f.submit().expect(200)).body).toEqual(original);expect(await f.snapshot()).toEqual(s);});
 it('different journals and tenants retain distinct receipts',async()=>{const f=await fixture(),g=await fixture(),id=(await f.send('/ledger/journals',{...f.journalBody,idempotencyKey:randomUUID()}).expect(201)).body.id;const a=(await f.submit().expect(200)).body,b=(await f.submit(id).expect(200)).body,c=(await g.submit().expect(200)).body;expect(new Set([a.id,b.id,c.id]).size).toBe(3);});
 it('incomplete receipt requires reconciliation',async()=>{const f=await fixture();const {createHash}=await import('node:crypto');const fingerprint=createHash('sha256').update(JSON.stringify({actorUserId:f.actor,journalId:f.id})).digest('hex');await f.tenant(c=>c.query("INSERT INTO financial_write_receipts(organization_id,action,intent_key,fingerprint) VALUES ($1,'ledger.submit',$2,$3)",[f.org,`entity:${f.id}`,fingerprint]));const s=await f.snapshot();await f.submit().expect(409);expect(await f.snapshot()).toEqual(s);});
 it('historical SUBMITTED journal without receipt fails closed',async()=>{const f=await fixture();await f.tenant(c=>c.query("UPDATE journal_entries SET status='SUBMITTED' WHERE id=$1",[f.id]));const s=await f.snapshot();await f.submit().expect(409);expect(await f.snapshot()).toEqual(s);});
 it('historical POSTED and REVERSED journals without submission receipts fail closed',async()=>{const f=await fixture();await f.tenant(c=>c.query("UPDATE journal_entries SET status='SUBMITTED' WHERE id=$1",[f.id]));await f.send(`/ledger/journals/${f.id}/approve-post`,{},f.checker).expect(200);let s=await f.snapshot();await f.submit().expect(409);expect(await f.snapshot()).toEqual(s);await f.send(`/ledger/journals/${f.id}/reverse`,{reason:'Synthetic historical reversal'}).expect(200);s=await f.snapshot();await f.submit().expect(409);expect(await f.snapshot()).toEqual(s);});
});
