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

describe('payroll preview receipts (PostgreSQL)',()=>{
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
  const key=randomUUID(),payload={idempotencyKey:key,filename:'preview-retry.csv',csv:`memberNo,amount\n${members[0]!.memberNo},0.23`};
  const send=(body=payload,headers=auth)=>request(app.getHttpServer()).post('/api/v1/payroll/import/preview').set(headers).send(body);
  const snapshot=()=>tenant(async c=>{const result:Record<string,unknown>={};for(const table of ['payroll_batches','financial_write_receipts','audit_logs','journal_entries','journal_lines','member_savings_accounts','savings_transactions','org_counters'])result[table]=(await c.query(`SELECT * FROM ${table} WHERE organization_id=$1 ORDER BY ${table==='org_counters'?'organization_id':'id'}`,[org])).rows;return result;});
  return{org,auth,checker,members,tenant,preview,submit,approve,proof,actor,key,payload,send,snapshot};
 }

 it('concurrent identical uploads create one batch and replay the original preview without money',async()=>{const f=await fixture(1),before=await f.snapshot(),r=await Promise.all([f.send().expect(201),f.send().expect(201)]);expect(r[0].body).toEqual(r[1].body);const s=await f.snapshot();expect(s.payroll_batches).toHaveLength(1);expect(s.financial_write_receipts).toHaveLength(1);for(const table of ['audit_logs','journal_entries','journal_lines','member_savings_accounts','savings_transactions','org_counters'])expect(s[table]).toEqual(before[table]);await f.send().expect(201);expect(await f.snapshot()).toEqual(s);});
 it.each(['filename','csv'])('same key with changed %s conflicts',async field=>{const f=await fixture(1);await f.send().expect(201);const s=await f.snapshot();await f.send({...f.payload,[field]:field==='csv'?f.payload.csv+'\n999999,0.01':'changed.csv'}).expect(409);expect(await f.snapshot()).toEqual(s);});
 it('same key with changed actor conflicts',async()=>{const f=await fixture(1);await f.send().expect(201);const s=await f.snapshot();await f.send(f.payload,f.checker).expect(409);expect(await f.snapshot()).toEqual(s);});
 it('a new explicit key creates a deliberately separate batch for identical content',async()=>{const f=await fixture(1),a=(await f.send().expect(201)).body,b=(await f.send({...f.payload,idempotencyKey:randomUUID()}).expect(201)).body;expect(a.batchId).not.toBe(b.batchId);expect((await f.snapshot()).payroll_batches).toHaveLength(2);});
 it('same key remains isolated between organizations',async()=>{const f=await fixture(1),g=await fixture(1),a=(await f.send().expect(201)).body,b=(await g.send({...g.payload,idempotencyKey:f.key}).expect(201)).body;expect(a.batchId).not.toBe(b.batchId);expect((await f.snapshot()).payroll_batches).toHaveLength(1);expect((await g.snapshot()).payroll_batches).toHaveLength(1);});
 it('missing invalid and reserved keys are refused without batches or receipts',async()=>{const f=await fixture(1),s=await f.snapshot();for(const idempotencyKey of [undefined,null,'short',' '.repeat(20),'x'.repeat(101),'pay:'+randomUUID(),'withdrawal-request:'+randomUUID()])await f.send({...f.payload,idempotencyKey} as typeof f.payload).expect(400);expect(await f.snapshot()).toEqual(s);});
 it('current grants and scope gate completed preview replay',async()=>{const f=await fixture(1);await f.send().expect(201);let s=await f.snapshot();await f.send().set('X-CoopEngine-Financial-Scope',`${randomUUID()}:${f.actor}`).expect(409);expect(await f.snapshot()).toEqual(s);await pool.query('DELETE FROM user_roles WHERE user_id=$1',[f.actor]);s=await f.snapshot();await f.send().expect(401);expect(await f.snapshot()).toEqual(s);});
 it('header validation failure rolls back a claimed key and allows correction',async()=>{const f=await fixture(1),s=await f.snapshot();await f.send({...f.payload,csv:'wrong,columns\n1,0.23'}).expect(400);expect(await f.snapshot()).toEqual(s);await f.send().expect(201);});
 it('invalid rows replay their original errors and totals',async()=>{const f=await fixture(1),body={...f.payload,csv:`memberNo,amount\n${f.members[0]!.memberNo},0.23\n999999,0.01\n${f.members[0]!.memberNo},0.02\n1,0.001`},a=(await f.send(body).expect(201)).body;expect(a.totals).toEqual({totalRows:4,valid:1,invalid:3,totalAmount:0.23});expect(a.errors).toHaveLength(3);const s=await f.snapshot();expect((await f.send(body).expect(201)).body).toEqual(a);expect(await f.snapshot()).toEqual(s);});
 it('changed member eligibility cannot regenerate original preview',async()=>{const f=await fixture(1),a=(await f.send().expect(201)).body;await f.tenant(c=>c.query("UPDATE members SET status='EXITED' WHERE id=$1",[f.members[0]!.id]));const s=await f.snapshot();expect((await f.send().expect(201)).body).toEqual(a);expect(await f.snapshot()).toEqual(s);});
 it('receipt finalization failure rolls back batch creation and permits original retry',async()=>{const f=await fixture(1),s=await f.snapshot();await pool.query(`CREATE FUNCTION payroll_preview_test_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='payroll.preview' AND NEW.response IS NOT NULL AND NEW.organization_id='${f.org}'::uuid THEN RAISE EXCEPTION 'synthetic preview receipt failure'; END IF; RETURN NEW; END; $$`);await pool.query('CREATE TRIGGER payroll_preview_test_fault BEFORE UPDATE ON financial_write_receipts FOR EACH ROW EXECUTE FUNCTION payroll_preview_test_fault()');try{await f.send().expect(500);expect(await f.snapshot()).toEqual(s);}finally{await pool.query('DROP TRIGGER payroll_preview_test_fault ON financial_write_receipts');await pool.query('DROP FUNCTION payroll_preview_test_fault()');}await f.send().expect(201);expect((await f.snapshot()).payroll_batches).toHaveLength(1);});
 it('preview replay after submission posting and reversal never creates a replacement batch',async()=>{const f=await fixture(1),a=(await f.send().expect(201)).body;await f.submit(a.batchId).expect(200);let s=await f.snapshot();expect((await f.send().expect(201)).body).toEqual(a);expect(await f.snapshot()).toEqual(s);await f.approve(a.batchId).expect(200);s=await f.snapshot();expect((await f.send().expect(201)).body).toEqual(a);expect(await f.snapshot()).toEqual(s);await request(app.getHttpServer()).post(`/api/v1/payroll/batches/${a.batchId}/reverse`).set(f.auth).send({reason:'Synthetic reverse'}).expect(200);s=await f.snapshot();expect((await f.send().expect(201)).body).toEqual(a);expect(await f.snapshot()).toEqual(s);});
 it('preview replay after rejection never requeues the rejected batch',async()=>{const f=await fixture(1),a=(await f.send().expect(201)).body;await f.submit(a.batchId).expect(200);await request(app.getHttpServer()).post(`/api/v1/payroll/batches/${a.batchId}/reject`).set(f.checker).send({reason:'Synthetic reject'}).expect(200);const s=await f.snapshot();expect((await f.send().expect(201)).body).toEqual(a);expect(await f.snapshot()).toEqual(s);});
 it('incomplete receipt fails closed without a batch',async()=>{const f=await fixture(1);const {createHash}=await import('node:crypto');const fingerprint=createHash('sha256').update(JSON.stringify({actorUserId:f.actor,filename:f.payload.filename,csv:f.payload.csv})).digest('hex');await f.tenant(c=>c.query("INSERT INTO financial_write_receipts(organization_id,action,intent_key,fingerprint) VALUES ($1,'payroll.preview',$2,$3)",[f.org,f.key,fingerprint]));const s=await f.snapshot();await f.send().expect(409);expect(await f.snapshot()).toEqual(s);});
 it('oversized CSV validation leaves no batch or receipt',async()=>{const f=await fixture(1),s=await f.snapshot();await f.send({...f.payload,csv:'x'.repeat(16001)}).expect(400);expect(await f.snapshot()).toEqual(s);});
});
