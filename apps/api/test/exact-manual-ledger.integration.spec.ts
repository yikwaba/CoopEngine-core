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

describe('exact manual ledger (PostgreSQL)',()=>{
 let app:INestApplication,pool:Pool,platform:string;
 beforeAll(async()=>{
  process.env.DATABASE_URL=TEST_DATABASE_URL;pool=new Pool({connectionString:TEST_DATABASE_URL});await ensureRbacSeeded(pool);
  const module=await Test.createTestingModule({imports:[AppModule]}).compile();app=module.createNestApplication();app.setGlobalPrefix('api/v1');app.useGlobalPipes(new ValidationPipe({whitelist:true,transform:true,forbidNonWhitelisted:true}));await app.init();
  platform=(await request(app.getHttpServer()).post('/api/v1/auth/login').send({email:'admin@coopengine.dev',password:ADMIN_PASSWORD}).expect(200)).body.tokens.accessToken;
 });
 afterAll(async()=>{await app?.close();await pool?.end();});
 async function fixture(count=1){
  const suffix=randomUUID().slice(0,8),email=`exact-ledger-${suffix}@coopengine.test`;
  const org=(await request(app.getHttpServer()).post('/api/v1/organizations').set('Authorization',`Bearer ${platform}`).send({name:`Journal submit ${suffix}`,slug:`exact-ledger-${suffix}`,adminEmail:email,adminPassword:'ExactPayrollPass123!'}).expect(201)).body.id;
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

 it('stores and posts huge decimal strings exactly, retains creation replay and mirrors reversal',async()=>{
  const f=await fixture();const body={...f.journalBody,idempotencyKey:randomUUID(),lines:[{accountCode:'5010',debit:'90071992547409.91'},{accountCode:'5010',debit:'0.01'},{accountCode:'1000',credit:'90071992547409.92'}]};
  const original=(await f.send('/ledger/journals',body).expect(201)).body;
  const read=()=>request(app.getHttpServer()).get(`/api/v1/ledger/journals/${original.id}`).set(f.auth).expect(200);
  const detail=(await read()).body;
  expect(detail.lines.map((l:{debitDecimal:string;creditDecimal:string})=>[l.debitDecimal,l.creditDecimal]).sort()).toEqual([['90071992547409.91','0.00'],['0.01','0.00'],['0.00','90071992547409.92']].sort());
  await f.submit(original.id).expect(200);await f.send(`/ledger/journals/${original.id}/approve-post`,{},f.checker).expect(200);
  const tb=(await request(app.getHttpServer()).get('/api/v1/ledger/trial-balance').set(f.auth).expect(200)).body;
  expect(tb.netDecimal).toBe('0.00');expect(tb.net).toBe(0);expect(tb.rows.find((r:{code:string})=>r.code==='5010').balanceDecimal).toBe('90071992547409.92');
  const snapshot=await f.snapshot();expect((await f.send('/ledger/journals',body).expect(201)).body).toEqual(original);expect(await f.snapshot()).toEqual(snapshot);
  const reversal=(await f.send(`/ledger/journals/${original.id}/reverse`,{reason:'Exact synthetic mirror'}).expect(200)).body.reversal;
  const reverse=(await request(app.getHttpServer()).get(`/api/v1/ledger/journals/${reversal.id}`).set(f.auth).expect(200)).body;
  expect(reverse.lines.map((l:{debitDecimal:string;creditDecimal:string})=>[l.creditDecimal,l.debitDecimal]).sort()).toEqual(detail.lines.map((l:{debitDecimal:string;creditDecimal:string})=>[l.debitDecimal,l.creditDecimal]).sort());
 });
 it('rejects one-kobo imbalance without receipt or line writes',async()=>{
  const f=await fixture(),before=await f.snapshot();await f.send('/ledger/journals',{...f.journalBody,idempotencyKey:randomUUID(),lines:[{accountCode:'5010',debit:'90071992547409.91'},{accountCode:'1000',credit:'90071992547409.92'}]}).expect(400);expect(await f.snapshot()).toEqual(before);
 });
 it('allows aggregate line totals beyond individual NUMERIC capacity',async()=>{
  const f=await fixture(),max='99999999999999999.99';const id=(await f.send('/ledger/journals',{...f.journalBody,idempotencyKey:randomUUID(),lines:[{accountCode:'5010',debit:max},{accountCode:'5010',debit:max},{accountCode:'1000',credit:max},{accountCode:'1000',credit:max}]}).expect(201)).body.id;
  await f.submit(id).expect(200);await f.send(`/ledger/journals/${id}/approve-post`,{},f.checker).expect(200);
  const tb=(await request(app.getHttpServer()).get('/api/v1/ledger/trial-balance').set(f.auth).expect(200)).body;
  expect(tb.netDecimal).toBe('0.00');expect(tb.rows.find((r:{code:string})=>r.code==='5010').balanceDecimal).toBe('199999999999999999.98');
 });
 it('retains numeric receipt identity and rejects changed string intent on its key',async()=>{
  const f=await fixture(),before=await f.snapshot();expect((await f.send('/ledger/journals',f.journalBody).expect(201)).body.id).toBe(f.id);expect(await f.snapshot()).toEqual(before);
  await f.send('/ledger/journals',{...f.journalBody,lines:[{accountCode:'5010',debit:'0.23',memo:'Original memo'},{accountCode:'1000',credit:'0.23'}]}).expect(409);expect(await f.snapshot()).toEqual(before);
 });
});
