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

describe('exact payroll preview, allocation and posting (PostgreSQL)',()=>{
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
  const preview=(csv:string)=>request(app.getHttpServer()).post('/api/v1/payroll/import/preview').set(auth).send({filename:'exact-payroll.csv',csv});
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
  return{org,auth,checker,members,tenant,preview,submit,approve,staged,proof};
 }
 it('stores exact preview decimals and conserves multi-member posting amounts',async()=>{
  const f=await fixture(3),id=await f.staged(['0.01','0.23','1.15']);
  const stored=await f.tenant(async c=>(await c.query('SELECT rows,total_amount FROM payroll_batches WHERE id=$1',[id])).rows[0]);expect(stored.rows.map((r:{amount:string})=>r.amount)).toEqual(['0.01','0.23','1.15']);expect(stored.total_amount).toBe('1.39');
  const detail=await request(app.getHttpServer()).get(`/api/v1/payroll/batches/${id}`).set(f.auth).expect(200);expect(detail.body.rows[0].amount).toBe(0.01);
  await f.approve(id).expect(200);const p=await f.proof(id);expect(p.batch.status).toBe('POSTED');expect(p.journal).toEqual({entries:1,debit:'1.39',credit:'1.39'});
  expect(p.members.map(r=>r.current_balance).sort()).toEqual(['0.01','0.23','1.15']);for(const member of p.members){expect(member.movements).toBe(member.current_balance);expect(member.liability).toBe(member.current_balance);}
 });
 it('rejects non-decimal CSV money, overprecision and over-limit rows',async()=>{
  const f=await fixture(8),values=['0.01','0.001','1e2','0x10','NaN','Infinity','100000000.01','-0.01'];
  const p=await f.preview('memberNo,amount\n'+values.map((v,i)=>`${f.members[i]!.memberNo},${v}`).join('\n')).expect(201);expect(p.body.totals).toEqual({totalRows:8,valid:1,invalid:7,totalAmount:0.01});
  await f.submit(p.body.batchId).expect(200);await f.approve(p.body.batchId).expect(200);expect((await f.proof(p.body.batchId)).journal.debit).toBe('0.01');
 });
 it('accepts legacy numeric rows and groups their amounts without floating-point drift',async()=>{
  const f=await fixture(1),id=await f.staged(['0.30']),member=f.members[0]!;
  // Synthetic historical JSON shape: old batches contain numeric amounts rather than decimal strings.
  await f.tenant(c=>c.query('UPDATE payroll_batches SET rows=$1::jsonb WHERE id=$2',[JSON.stringify([{...{memberId:member.id,memberNo:member.memberNo},amount:0.1},{memberId:member.id,memberNo:member.memberNo,amount:0.2}]),id]));
  await f.approve(id).expect(200);const p=await f.proof(id);expect(p.journal.debit).toBe('0.30');expect(p.members[0].current_balance).toBe('0.30');expect(p.members[0].movements).toBe('0.30');
 });
 it('preserves a one-kobo payroll credit on a large existing balance',async()=>{
  const f=await fixture(1),member=f.members[0]!,account=(await request(app.getHttpServer()).post(`/api/v1/savings/member/${member.id}/account`).set(f.auth).send({}).expect(201)).body.id;
  // Synthetic opening balance isolates arithmetic, without modifying production/history.
  await f.tenant(c=>c.query('UPDATE member_savings_accounts SET current_balance=$1 WHERE id=$2',['90071992547409.91',account]));
  const id=await f.staged(['0.01']);await f.approve(id).expect(200);const p=await f.proof(id);expect(p.members[0].current_balance).toBe('90071992547409.92');expect(p.journal.debit).toBe('0.01');expect(p.journal.credit).toBe('0.01');
 });
 it('posts the maximum per-row amount and an additional kobo exactly',async()=>{
  const f=await fixture(),id=await f.staged(['100000000.00','0.01']);await f.approve(id).expect(200);const p=await f.proof(id);expect(p.batch.total_amount).toBe('100000000.01');expect(p.journal.debit).toBe('100000000.01');expect(p.journal.credit).toBe(p.journal.debit);
 });
 it('serializes two approvals of the same batch into exactly one posting',async()=>{
  const f=await fixture(1),id=await f.staged(['0.23']);const results=await Promise.all([f.approve(id),f.approve(id)]);expect(results.map(r=>r.status).sort()).toEqual([200,200]);expect(results[0].body).toEqual(results[1].body);const p=await f.proof(id);expect(p.journal.entries).toBe(1);expect(p.members[0].current_balance).toBe('0.23');
 });
 it('serializes duplicate submissions before approval',async()=>{
  const f=await fixture(1),preview=await f.preview(`memberNo,amount\n${f.members[0]!.memberNo},0.01`).expect(201),id=preview.body.batchId;
  const responses=await Promise.all([f.submit(id),f.submit(id)]);expect(responses.map(r=>r.status).sort()).toEqual([200,200]);expect(responses[0].body).toEqual(responses[1].body);await f.approve(id).expect(200);expect((await f.proof(id)).journal.entries).toBe(1);
 });
 it('conserves a concurrent payroll credit and ordinary savings deposit',async()=>{
  const f=await fixture(1),member=f.members[0]!,account=(await request(app.getHttpServer()).post(`/api/v1/savings/member/${member.id}/account`).set(f.auth).send({}).expect(201)).body.id;
  const id=await f.staged(['0.23']);await Promise.all([f.approve(id).expect(200),request(app.getHttpServer()).post(`/api/v1/savings/accounts/${account}/deposits`).set(f.auth).send({ idempotencyKey: randomUUID(),amount:0.01}).expect(201)]);
  const p=await f.proof(id);expect(p.members[0].current_balance).toBe('0.24');expect(p.members[0].movements).toBe('0.24');expect(p.members[0].liability).toBe('0.24');
 });
 it('rolls back all posting, counter and member changes if one balance overflows',async()=>{
  const f=await fixture(),member=f.members[0]!,account=(await request(app.getHttpServer()).post(`/api/v1/savings/member/${member.id}/account`).set(f.auth).send({}).expect(201)).body.id;
  await f.tenant(c=>c.query('UPDATE member_savings_accounts SET current_balance=$1 WHERE id=$2',['99999999999999999.99',account]));const id=await f.staged(['0.01','0.23']),before=await f.proof(id);
  await f.approve(id).expect(400);expect(await f.proof(id)).toEqual(before);
 });
 it('retains independent-checker enforcement and fails closed on a closed period',async()=>{
  const f=await fixture(1),id=await f.staged(['0.01']);await request(app.getHttpServer()).post(`/api/v1/payroll/batches/${id}/approve`).set(f.auth).expect(409);
  await f.tenant(c=>c.query("UPDATE ledger_periods SET status='CLOSED'"));const before=await f.proof(id);await f.approve(id).expect(409);expect(await f.proof(id)).toEqual(before);
 });
 it('skips a member who became inactive without allocating their amount',async()=>{
  const f=await fixture(),id=await f.staged(['0.23','1.15']);await f.tenant(c=>c.query("UPDATE members SET status='EXITED' WHERE id=$1",[f.members[1]!.id]));const result=await f.approve(id).expect(200);expect(result.body.committed).toBe(1);expect(result.body.totalAmount).toBe(0.23);expect(result.body.skipped).toHaveLength(1);const p=await f.proof(id);expect(p.journal.debit).toBe('0.23');expect(p.members).toHaveLength(1);
 });
});
