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

describe('exact savings postings, balances and interest (PostgreSQL)',()=>{
 let app:INestApplication,pool:Pool,platform:string;
 beforeAll(async()=>{
  process.env.DATABASE_URL=TEST_DATABASE_URL;pool=new Pool({connectionString:TEST_DATABASE_URL});await ensureRbacSeeded(pool);
  const module=await Test.createTestingModule({imports:[AppModule]}).compile();app=module.createNestApplication();app.setGlobalPrefix('api/v1');app.useGlobalPipes(new ValidationPipe({whitelist:true,transform:true,forbidNonWhitelisted:true}));await app.init();
  platform=(await request(app.getHttpServer()).post('/api/v1/auth/login').send({email:'admin@coopengine.dev',password:ADMIN_PASSWORD}).expect(200)).body.tokens.accessToken;
 });
 afterAll(async()=>{await app?.close();await pool?.end();});
 async function fixture(){
  const suffix=randomUUID().slice(0,8),email=`exact-saving-${suffix}@coopengine.test`;
  const org=(await request(app.getHttpServer()).post('/api/v1/organizations').set('Authorization',`Bearer ${platform}`).send({name:`Exact savings ${suffix}`,slug:`exact-saving-${suffix}`,adminEmail:email,adminPassword:'ExactSavingsPass123!'}).expect(201)).body.id;
  const token=(await request(app.getHttpServer()).post('/api/v1/auth/login').send({email,password:'ExactSavingsPass123!'}).expect(200)).body.tokens.accessToken;
  const auth={Authorization:`Bearer ${token}`};
  const member=(await request(app.getHttpServer()).post('/api/v1/members').set(auth).send({firstName:'Exact',lastName:'Synthetic'}).expect(201)).body.id;
  await request(app.getHttpServer()).post(`/api/v1/members/${member}/approve`).set(auth).expect(200);
  const account=(await request(app.getHttpServer()).post(`/api/v1/savings/member/${member}/account`).set(auth).send({}).expect(201)).body.id;
  const tenant=<T>(fn:Parameters<typeof withTenant<T>>[2])=>withTenant(pool,org,fn);
  const deposit=(amount:number,key?:string)=>request(app.getHttpServer()).post(`/api/v1/savings/accounts/${account}/deposits`).set(auth).send({amount,idempotencyKey:key??randomUUID()});
  const withdraw=(amount:number)=>request(app.getHttpServer()).post(`/api/v1/savings/accounts/${account}/withdrawals`).set(auth).send({ idempotencyKey: randomUUID(),amount});
  const interest=()=>request(app.getHttpServer()).post('/api/v1/savings/interest/post').set(auth).send({period:new Date().toISOString().slice(0,7)});
  async function proof(){return tenant(async c=>(await c.query(`SELECT a.current_balance,
   (SELECT sum(signed_amount)::text FROM savings_transactions WHERE account_id=a.id) AS movements,
   (SELECT count(*)::int FROM savings_transactions WHERE account_id=a.id) AS transactions,
   (SELECT sum(debit)::text FROM journal_lines WHERE journal_entry_id IN(SELECT journal_entry_id FROM savings_transactions WHERE account_id=a.id)) AS debit,
   (SELECT sum(credit)::text FROM journal_lines WHERE journal_entry_id IN(SELECT journal_entry_id FROM savings_transactions WHERE account_id=a.id)) AS credit,
   (SELECT sum(credit-debit)::text FROM journal_lines jl JOIN chart_of_accounts coa ON coa.id=jl.account_id WHERE coa.code='2000' AND jl.member_id=a.member_id) AS liability
   FROM member_savings_accounts a WHERE a.id=$1`,[account])).rows[0]);}
  return {org,auth,account,tenant,deposit,withdraw,interest,proof};
 }
 it('conserves 115 one-kobo deposits, partial withdrawals and exact zero balance',async()=>{
  const f=await fixture();for(let n=0;n<115;n++)await f.deposit(0.01).expect(201);
  let p=await f.proof();expect(p.current_balance).toBe('1.15');expect(p.movements).toBe('1.15');expect(p.liability).toBe('1.15');expect(p.debit).toBe(p.credit);
  await f.withdraw(0.23).expect(200);expect((await f.proof()).current_balance).toBe('0.92');await f.withdraw(0.92).expect(200);
  p=await f.proof();expect(p.current_balance).toBe('0.00');expect(p.movements).toBe('0.00');expect(p.liability).toBe('0.00');expect(p.debit).toBe(p.credit);
  const before=await f.proof();await f.withdraw(0.01).expect(400);expect(await f.proof()).toEqual(before);
 });
 it('serializes concurrent deposits and withdrawals without lost kobo',async()=>{
  const f=await fixture();await f.deposit(0.20).expect(201);
  await Promise.all(Array.from({length:20},(_,n)=>n%2===0?f.deposit(0.01).expect(201):f.withdraw(0.01).expect(200)));
  const p=await f.proof();expect(p.current_balance).toBe('0.20');expect(p.movements).toBe('0.20');expect(p.liability).toBe('0.20');expect(p.transactions).toBe(21);expect(p.debit).toBe(p.credit);
 });
 it('retains a one-kobo movement on a database balance beyond binary-number precision',async()=>{
  const f=await fixture(); // Synthetic opening fixture isolates arithmetic; no production history is rewritten.
  await f.tenant(c=>c.query('UPDATE member_savings_accounts SET current_balance=$1 WHERE id=$2',['90071992547409.91',f.account]));
  await f.deposit(0.01).expect(201);expect((await f.proof()).current_balance).toBe('90071992547409.92');await f.withdraw(0.01).expect(200);
  const p=await f.proof();expect(p.current_balance).toBe('90071992547409.91');expect(p.movements).toBe('0.00');expect(p.debit).toBe(p.credit);
 });
 it('posts the largest supported numeric input and withdraws it exactly',async()=>{
  const f=await fixture();await f.deposit(100000000000).expect(201);await f.withdraw(99999999999.99).expect(200);
  expect((await f.proof()).current_balance).toBe('0.01');await f.withdraw(0.01).expect(200);const p=await f.proof();expect(p.current_balance).toBe('0.00');expect(p.liability).toBe('0.00');expect(p.debit).toBe('200000000000.00');expect(p.credit).toBe(p.debit);
 });
 it('rejects invalid amounts and replays repeated keys without extra projections',async()=>{
  const f=await fixture();await f.deposit(0.23,randomUUID()).expect(201);const key=randomUUID();const original=await f.deposit(0.23,key).expect(201);
  const before=await f.proof();expect((await f.deposit(0.23,key).expect(201)).body).toEqual(original.body);await f.deposit(0.001).expect(400);await f.deposit(100000000000.01).expect(400);expect(await f.proof()).toEqual(before);
  await f.tenant(c=>c.query('UPDATE member_savings_accounts SET current_balance=$1 WHERE id=$2',['99999999999999999.99',f.account]));
  const max=await f.proof();await f.deposit(0.01).expect(400);expect(await f.proof()).toEqual(max);
 });
 it('rolls back a deposit when there is no open accounting period',async()=>{
  const f=await fixture();const before=await f.proof();await f.tenant(c=>c.query("UPDATE ledger_periods SET status='CLOSED'"));await f.deposit(0.01).expect(409);expect(await f.proof()).toEqual(before);
 });
 it.each([['1.00','6.0000'],['17.29','13.3333'],['90071992547409.91','999.9999']])('posts exact monthly interest for %s at %s percent',async(balance,rate)=>{
  const f=await fixture();await f.tenant(async c=>{await c.query('UPDATE member_savings_accounts SET current_balance=$1 WHERE id=$2',[balance,f.account]);await c.query('UPDATE savings_products SET interest_rate_pa=$1',[rate]);});
  const oracle=await f.tenant(async c=>(await c.query('SELECT round($1::numeric*$2::numeric/1200,2)::text AS amount,($1::numeric+round($1::numeric*$2::numeric/1200,2))::text AS balance',[balance,rate])).rows[0]);
  const preview=await request(app.getHttpServer()).get('/api/v1/savings/interest/preview').set(f.auth).expect(200);expect(preview.body.total).toBe(Number(oracle.amount));
  await f.interest().expect(200);const p=await f.proof();expect(p.current_balance).toBe(oracle.balance);expect(p.movements).toBe(oracle.amount);expect(p.debit).toBe(oracle.amount);expect(p.credit).toBe(oracle.amount);expect(p.liability).toBe(oracle.amount);
  const posting=await f.tenant(async c=>(await c.query('SELECT total_amount FROM savings_interest_postings')).rows[0]);expect(posting.total_amount).toBe(oracle.amount);
  await f.interest().expect(200);expect(await f.proof()).toEqual(p);
 });
 it('conserves a concurrent deposit and monthly interest posting',async()=>{
  const f=await fixture();await f.deposit(1).expect(201);await f.tenant(c=>c.query('UPDATE savings_products SET interest_rate_pa=6'));
  await Promise.all([f.interest().expect(200),f.deposit(0.01).expect(201)]);
  const p=await f.proof();expect(p.current_balance).toBe('1.02');expect(p.movements).toBe('1.02');expect(p.liability).toBe('1.02');expect(p.debit).toBe(p.credit);
 });
 it('rolls back interest journal, posting marker and balance on account overflow',async()=>{
  const f=await fixture();await f.tenant(async c=>{await c.query('UPDATE member_savings_accounts SET current_balance=$1 WHERE id=$2',['99999999999999999.99',f.account]);await c.query('UPDATE savings_products SET interest_rate_pa=120');});
  const before=await f.proof();await f.interest().expect(400);expect(await f.proof()).toEqual(before);
  expect(await f.tenant(async c=>(await c.query('SELECT count(*)::int AS n FROM savings_interest_postings')).rows[0].n)).toBe(0);
 });
 it('compares withdrawal approval thresholds exactly and rejects excess precision',async()=>{
  const f=await fixture();await f.deposit(1.15).expect(201);
  await request(app.getHttpServer()).patch('/api/v1/savings/settings/withdrawal-approval').set(f.auth).send({threshold:0.23}).expect(200);
  const parked=await f.withdraw(0.24).expect(200);expect(parked.body.kind).toBe('PENDING');expect((await f.proof()).current_balance).toBe('1.15');
  const stored=await f.tenant(async c=>(await c.query('SELECT amount FROM savings_withdrawal_requests')).rows[0]);expect(stored.amount).toBe('0.24');
  const posted=await f.withdraw(0.23).expect(200);expect(posted.body.kind).toBe('POSTED');expect((await f.proof()).current_balance).toBe('0.92');
  await request(app.getHttpServer()).patch('/api/v1/savings/settings/withdrawal-approval').set(f.auth).send({threshold:0.001}).expect(400);
 });
});
