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

describe('payroll submission receipts (PostgreSQL)',()=>{
 let app:INestApplication,pool:Pool,platform:string;
 beforeAll(async()=>{
  process.env.DATABASE_URL=TEST_DATABASE_URL;pool=new Pool({connectionString:TEST_DATABASE_URL});await ensureRbacSeeded(pool);
  const module=await Test.createTestingModule({imports:[AppModule]}).compile();app=module.createNestApplication();app.setGlobalPrefix('api/v1');app.useGlobalPipes(new ValidationPipe({whitelist:true,transform:true,forbidNonWhitelisted:true}));await app.init();
  platform=(await request(app.getHttpServer()).post('/api/v1/auth/login').send({email:'admin@coopengine.dev',password:ADMIN_PASSWORD}).expect(200)).body.tokens.accessToken;
 });
 afterAll(async()=>{await app?.close();await pool?.end();});
 async function fixture(count=2){
  const suffix=randomUUID().slice(0,8),email=`exact-payroll-${suffix}@coopengine.test`;
  const org=(await request(app.getHttpServer()).post('/api/v1/organizations').set('Authorization',`Bearer ${platform}`).send({name:`Exact payroll ${suffix}`,slug:`exact-payroll-${suffix}`,adminEmail:email,adminPassword:'ExactPayrollPass123!'}).expect(201)).body.id;
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
  const preview=(csv:string)=>request(app.getHttpServer()).post('/api/v1/payroll/import/preview').set(auth).send({idempotencyKey:randomUUID(),filename:'exact-payroll.csv',csv});
  const submit=(id:string)=>request(app.getHttpServer()).post('/api/v1/payroll/import/commit').set(auth).send({batchId:id});
  const approve=(id:string)=>request(app.getHttpServer()).post(`/api/v1/payroll/batches/${id}/approve`).set(checker);
  async function staged(amounts:string[]){const result=await preview('memberNo,amount\n'+amounts.map((value,i)=>`${members[i]!.memberNo},${value}`).join('\n')).expect(201);await submit(result.body.batchId).expect(200);return result.body.batchId as string;}
  async function proof(id:string){return tenant(async c=>({
   batch:(await c.query('SELECT status,total_amount FROM payroll_batches WHERE id=$1',[id])).rows[0],
   members:(await c.query(`SELECT a.member_id,a.current_balance,(SELECT sum(signed_amount)::text FROM savings_transactions WHERE account_id=a.id) AS movements,
    (SELECT sum(credit-debit)::text FROM journal_lines jl JOIN chart_of_accounts coa ON coa.id=jl.account_id WHERE coa.code='2000' AND jl.member_id=a.member_id) AS liability
    FROM member_savings_accounts a ORDER BY a.member_id`)).rows,
   journal:(await c.query(`SELECT count(DISTINCT je.id)::int AS entries,sum(jl.debit)::text AS debit,sum(jl.credit)::text AS credit
    FROM journal_entries je LEFT JOIN journal_lines jl ON jl.journal_entry_id=je.id WHERE je.source_type='payroll_batch' AND je.source_id=$1`,[id])).rows[0],
   counter:(await c.query('SELECT journal_seq,savings_seq FROM org_counters')).rows[0],
  }));}
  const actor=(await request(app.getHttpServer()).get('/api/v1/auth/me').set(auth).expect(200)).body.user.id as string;
  const id=(await preview(`memberNo,amount\n${members[0]!.memberNo},0.23`).expect(201)).body.batchId as string;
  const send=()=>submit(id);
  const snapshot=()=>tenant(async c=>{const result:Record<string,unknown>={};for(const table of ['payroll_batches','financial_write_receipts','audit_logs','journal_entries','journal_lines','member_savings_accounts','savings_transactions','org_counters'])result[table]=(await c.query(`SELECT * FROM ${table} WHERE organization_id=$1 ORDER BY ${table==='org_counters'?'organization_id':'id'}`,[org])).rows;return result;});
  return{org,auth,checker,members,tenant,preview,submit,approve,staged,proof,actor,id,send,snapshot};
 }

 it('concurrent submissions replay one original response with one audit and no money',async()=>{const f=await fixture(1),before=await f.proof(f.id),r=await Promise.all([f.send().expect(200),f.send().expect(200)]);expect(r[0].body).toEqual(r[1].body);const s=await f.snapshot();expect((s.audit_logs as {action:string}[]).filter(a=>a.action==='payroll.submitted')).toHaveLength(1);expect((s.financial_write_receipts as {action:string}[]).filter(a=>a.action==='payroll.submit')).toHaveLength(1);const after=await f.proof(f.id);expect(after.members).toEqual(before.members);expect(after.journal).toEqual(before.journal);expect(after.counter).toEqual(before.counter);await f.send().expect(200);expect(await f.snapshot()).toEqual(s);});
 it('changed actor refuses original receipt replay',async()=>{const f=await fixture(1);await f.send().expect(200);const s=await f.snapshot();await request(app.getHttpServer()).post('/api/v1/payroll/import/commit').set(f.checker).send({batchId:f.id}).expect(409);expect(await f.snapshot()).toEqual(s);});
 it('current grants gate completed replay',async()=>{const f=await fixture(1);await f.send().expect(200);await pool.query('DELETE FROM user_roles WHERE user_id=$1',[f.actor]);const s=await f.snapshot();await f.send().expect(401);expect(await f.snapshot()).toEqual(s);});
 it('changed scope refuses without writes',async()=>{const f=await fixture(1),s=await f.snapshot();await f.send().set('X-CoopEngine-Financial-Scope',`${randomUUID()}:${f.actor}`).expect(409);expect(await f.snapshot()).toEqual(s);});
 it('missing, invalid, unknown and foreign batches cannot claim receipts',async()=>{const f=await fixture(1),other=await fixture(1),s=await f.snapshot();for(const batchId of [undefined,null,'bad'])await request(app.getHttpServer()).post('/api/v1/payroll/import/commit').set(f.auth).send({batchId}).expect(400);await f.submit(randomUUID()).expect(404);await f.submit(other.id).expect(404);expect(await f.snapshot()).toEqual(s);});
 it('zero valid rows leave no receipt',async()=>{const f=await fixture(1),p=await f.preview('memberNo,amount\n999999,0.23').expect(201),s=await f.snapshot();await f.submit(p.body.batchId).expect(409);expect(await f.snapshot()).toEqual(s);});
 it('receipt finalization fault rolls back submission state and audit and permits retry',async()=>{const f=await fixture(1),s=await f.snapshot();await pool.query(`CREATE FUNCTION payroll_submit_test_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='payroll.submit' AND NEW.response IS NOT NULL AND NEW.organization_id='${f.org}'::uuid THEN RAISE EXCEPTION 'synthetic submission receipt failure'; END IF; RETURN NEW; END; $$`);await pool.query('CREATE TRIGGER payroll_submit_test_fault BEFORE UPDATE ON financial_write_receipts FOR EACH ROW EXECUTE FUNCTION payroll_submit_test_fault()');try{await f.send().expect(500);expect(await f.snapshot()).toEqual(s);}finally{await pool.query('DROP TRIGGER payroll_submit_test_fault ON financial_write_receipts');await pool.query('DROP FUNCTION payroll_submit_test_fault()');}await f.send().expect(200);});
 it('replays after rejection without requeueing or changing rejection evidence',async()=>{const f=await fixture(1),original=(await f.send().expect(200)).body;await request(app.getHttpServer()).post(`/api/v1/payroll/batches/${f.id}/reject`).set(f.checker).send({reason:'Synthetic correction required'}).expect(200);const s=await f.snapshot();expect((await f.send().expect(200)).body).toEqual(original);expect(await f.snapshot()).toEqual(s);expect((await f.proof(f.id)).batch.status).toBe('REJECTED');});
 it('replays after posting and reversal without money effects and preserves maker-checker',async()=>{const f=await fixture(1),original=(await f.send().expect(200)).body;await request(app.getHttpServer()).post(`/api/v1/payroll/batches/${f.id}/approve`).set(f.auth).expect(409);await f.approve(f.id).expect(200);let s=await f.snapshot();expect((await f.send().expect(200)).body).toEqual(original);expect(await f.snapshot()).toEqual(s);await request(app.getHttpServer()).post(`/api/v1/payroll/batches/${f.id}/reverse`).set(f.auth).send({reason:'Synthetic reverse'}).expect(200);s=await f.snapshot();expect((await f.send().expect(200)).body).toEqual(original);expect(await f.snapshot()).toEqual(s);});
 it.each(['SUBMITTED','POSTED','REVERSED','REJECTED'])('historical %s without a submission receipt fails closed',async status=>{const f=await fixture(1);await f.tenant(c=>c.query('UPDATE payroll_batches SET status=$1 WHERE id=$2',[status,f.id]));const s=await f.snapshot();await f.send().expect(409);expect(await f.snapshot()).toEqual(s);});
 it('incomplete submission receipt requires reconciliation',async()=>{const f=await fixture(1);const {createHash}=await import('node:crypto');const fingerprint=createHash('sha256').update(JSON.stringify({actorUserId:f.actor,batchId:f.id})).digest('hex');await f.tenant(c=>c.query("INSERT INTO financial_write_receipts(organization_id,action,intent_key,fingerprint) VALUES ($1,'payroll.submit',$2,$3)",[f.org,`entity:${f.id}`,fingerprint]));const s=await f.snapshot();await f.send().expect(409);expect(await f.snapshot()).toEqual(s);});
});
