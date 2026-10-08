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

describe('withdrawal policy precedence (PostgreSQL)',()=>{
 let app:INestApplication,pool:Pool,platform:string;
 beforeAll(async()=>{
  process.env.DATABASE_URL=TEST_DATABASE_URL;pool=new Pool({connectionString:TEST_DATABASE_URL});await ensureRbacSeeded(pool);
  const module=await Test.createTestingModule({imports:[AppModule]}).compile();app=module.createNestApplication();app.setGlobalPrefix('api/v1');app.useGlobalPipes(new ValidationPipe({whitelist:true,transform:true,forbidNonWhitelisted:true}));await app.init();
  platform=(await request(app.getHttpServer()).post('/api/v1/auth/login').send({email:'admin@coopengine.dev',password:ADMIN_PASSWORD}).expect(200)).body.tokens.accessToken;
 });
 afterAll(async()=>{await app?.close();await pool?.end();});
 async function fixture(count=1){
  const suffix=randomUUID().slice(0,8),email=`exact-reports-${suffix}@coopengine.test`;
  const org=(await request(app.getHttpServer()).post('/api/v1/organizations').set('Authorization',`Bearer ${platform}`).send({name:`Journal submit ${suffix}`,slug:`exact-reports-${suffix}`,adminEmail:email,adminPassword:'ExactPayrollPass123!'}).expect(201)).body.id;
  const token=(await request(app.getHttpServer()).post('/api/v1/auth/login').send({email,password:'ExactPayrollPass123!'}).expect(200)).body.tokens.accessToken;
  const auth={Authorization:`Bearer ${token}`};
  const invited=(await request(app.getHttpServer()).post('/api/v1/users').set(auth).send({email:`checker-${suffix}@coopengine.test`,roleCodes:['TREASURER']}).expect(201)).body;
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
  const snapshot=()=>tenant(async c=>{const result:Record<string,unknown>={};for(const table of ['ledger_periods','loans','loan_guarantors','loan_repayments','financial_write_receipts','audit_logs','journal_entries','journal_lines','member_savings_accounts','savings_transactions','org_counters','savings_withdrawal_requests','approval_requests','approval_steps','approval_actions'])result[table]=(await c.query(`SELECT * FROM ${table} WHERE organization_id=$1 ORDER BY ${table==='org_counters'?'organization_id':'id'}`,[org])).rows;return result;});
  const id=(await send('/ledger/journals',journalBody).expect(201)).body.id as string;
  const submit=(journalId=id,headers=auth)=>send(`/ledger/journals/${journalId}/submit`,{},headers);
  return{org,auth,checker,members,tenant,actor,key,journalBody,send,snapshot,id,submit,account};
 }

 const read=(f:Awaited<ReturnType<typeof fixture>>,path:string)=>request(app.getHttpServer()).get('/api/v1'+path).set(f.auth);
 const balance=async(f:Awaited<ReturnType<typeof fixture>>)=>(await read(f,'/reports/savings-book').expect(200)).body.rows.find((r:{memberId:string})=>r.memberId===f.members[0]!.id).balanceDecimal;
 async function policy(f:Awaited<ReturnType<typeof fixture>>,min='0.00',max:string|null=null,steps=true,active=true){
  return f.tenant(async c=>{const id=(await c.query("INSERT INTO approval_policies (organization_id,kind,min_amount,max_amount,version,is_active) VALUES ($1,'WITHDRAWAL',$2,$3,1,$4) RETURNING id",[f.org,min,max,active])).rows[0].id as string;
   if(steps)await c.query("INSERT INTO approval_policy_steps (organization_id,policy_id,step_no,approver_role_code) VALUES ($1,$2,1,'TREASURER'),($1,$2,2,'CHAIRMAN')",[f.org,id]);return id;});
 }
 async function chair(f:Awaited<ReturnType<typeof fixture>>){const u=(await f.send('/users',{email:`chair-${randomUUID()}@coopengine.test`,roleCodes:['CHAIRMAN']}).expect(201)).body;const t=(await request(app.getHttpServer()).post('/api/v1/auth/login').send({email:u.email,password:u.tempPassword}).expect(200)).body.tokens.accessToken;return{Authorization:`Bearer ${t}`};}
 const withdrawal=(f:Awaited<ReturnType<typeof fixture>>,key=randomUUID(),amount=0.01)=>f.send(`/savings/accounts/${f.account}/withdrawals`,{idempotencyKey:key,amount,description:'Policy precedence regression'});
 const decision=(f:Awaited<ReturnType<typeof fixture>>,id:string,headers=f.checker,step=1,action='approve')=>f.send(`/savings/withdrawals/${id}/${action}`,{expectedStepNo:step},headers);
 it('null legacy threshold cannot bypass active policy, ordered maker/checker steps or retry protection',async()=>{
  const f=await fixture(),final=await chair(f);await policy(f);
  for(const headers of [f.checker,final])await request(app.getHttpServer()).get('/api/v1/savings/settings/withdrawal-approval').set(headers).expect(200);
  const key=randomUUID();
  const [a,b]=await Promise.all([withdrawal(f,key).expect(200),withdrawal(f,key).expect(200)]);expect(a.body).toEqual(b.body);expect(a.body.kind).toBe('PENDING');const id=a.body.requestId;
  expect(await balance(f)).toBe('1.15');await withdrawal(f,key,0.02).expect(409);
  await decision(f,id,f.auth).expect(409);await decision(f,id,final).expect(403);expect(await balance(f)).toBe('1.15');
  const step=(await decision(f,id).expect(200)).body;expect(step).toMatchObject({approvalStatus:'PENDING',currentStep:2});expect(await balance(f)).toBe('1.15');
  await decision(f,id,final,1).expect(409);
  const [posted,replayed]=await Promise.all([decision(f,id,final,2).expect(200),decision(f,id,final,2).expect(200)]);expect(posted.body).toEqual(replayed.body);expect(posted.body.approvalStatus).toBe('APPROVED');expect(await balance(f)).toBe('1.14');
  const proof=await f.tenant(async c=>({requests:(await c.query('SELECT count(*)::int AS n FROM savings_withdrawal_requests')).rows[0].n,chains:(await c.query('SELECT count(*)::int AS n FROM approval_requests')).rows[0].n,journals:(await c.query("SELECT count(*)::int AS n FROM journal_entries WHERE id=$1",[posted.body.journalEntryId])).rows[0].n}));expect(proof).toEqual({requests:1,chains:1,journals:1});
 });
 it('active policy takes precedence below and at the legacy threshold with inclusive amount boundaries',async()=>{
  const f=await fixture();await policy(f,'0.00','0.01');
  for(const threshold of [0.02,0.01]){await request(app.getHttpServer()).patch('/api/v1/savings/settings/withdrawal-approval').set(f.auth).send({threshold}).expect(200);const r=(await withdrawal(f).expect(200)).body;expect(r.kind).toBe('PENDING');await decision(f,r.requestId,f.checker,1,'reject').expect(200);expect(await balance(f)).toBe('1.15');}
 });
 it('policy gaps, overlapping policies and missing steps roll back requests, receipts and financial state',async()=>{
  for(const mode of ['gap','overlap','steps']){const f=await fixture();await policy(f,mode==='gap'?'0.02':'0.00',null,mode!=='steps');if(mode==='overlap')await policy(f,'0.01');const before=await f.snapshot();await withdrawal(f).expect(409);expect(await f.snapshot()).toEqual(before);expect(await balance(f)).toBe('1.15');}
 });
 it('no active policy retains immediate staff posting and legacy threshold maker/checker behavior',async()=>{
  const f=await fixture();await policy(f,'0.00',null,true,false);expect((await withdrawal(f).expect(200)).body.kind).toBe('POSTED');expect(await balance(f)).toBe('1.14');
  await request(app.getHttpServer()).patch('/api/v1/savings/settings/withdrawal-approval').set(f.auth).send({threshold:0}).expect(200);const r=(await withdrawal(f).expect(200)).body;expect(r.kind).toBe('PENDING');await f.send(`/savings/withdrawals/${r.requestId}/approve`,{},f.auth).expect(409);await f.send(`/savings/withdrawals/${r.requestId}/approve`,{},f.checker).expect(200);expect(await balance(f)).toBe('1.13');
 });
 it('policy activation and withdrawal decisions remain isolated to their tenant',async()=>{
  const f=await fixture(),g=await fixture();await policy(f);const r=(await withdrawal(f).expect(200)).body;expect(r.kind).toBe('PENDING');expect((await withdrawal(g).expect(200)).body.kind).toBe('POSTED');await decision(f,r.requestId,g.checker).expect(404);expect(await balance(f)).toBe('1.15');expect(await balance(g)).toBe('1.14');
 });
});
