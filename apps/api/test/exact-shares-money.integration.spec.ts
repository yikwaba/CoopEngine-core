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

describe('exact share purchases, redemptions and balances (PostgreSQL)',()=>{
 let app:INestApplication,pool:Pool,platform:string;
 beforeAll(async()=>{
  process.env.DATABASE_URL=TEST_DATABASE_URL;pool=new Pool({connectionString:TEST_DATABASE_URL});await ensureRbacSeeded(pool);
  const module=await Test.createTestingModule({imports:[AppModule]}).compile();app=module.createNestApplication();app.setGlobalPrefix('api/v1');app.useGlobalPipes(new ValidationPipe({whitelist:true,transform:true,forbidNonWhitelisted:true}));await app.init();
  platform=(await request(app.getHttpServer()).post('/api/v1/auth/login').send({email:'admin@coopengine.dev',password:ADMIN_PASSWORD}).expect(200)).body.tokens.accessToken;
 });
 afterAll(async()=>{await app?.close();await pool?.end();});
 async function fixture(){
  const suffix=randomUUID().slice(0,8),email=`exact-share-${suffix}@coopengine.test`;
  const org=(await request(app.getHttpServer()).post('/api/v1/organizations').set('Authorization',`Bearer ${platform}`).send({name:`Exact shares ${suffix}`,slug:`exact-share-${suffix}`,adminEmail:email,adminPassword:'ExactSharesPass123!'}).expect(201)).body.id;
  const token=(await request(app.getHttpServer()).post('/api/v1/auth/login').send({email,password:'ExactSharesPass123!'}).expect(200)).body.tokens.accessToken;
  const auth={Authorization:`Bearer ${token}`};
  const member=(await request(app.getHttpServer()).post('/api/v1/members').set(auth).send({firstName:'Exact',lastName:'Synthetic'}).expect(201)).body.id;
  await request(app.getHttpServer()).post(`/api/v1/members/${member}/approve`).set(auth).expect(200);
  const tenant=<T>(fn:Parameters<typeof withTenant<T>>[2])=>withTenant(pool,org,fn);
  const purchase=(amount:number,key?:string)=>request(app.getHttpServer()).post(`/api/v1/shares/member/${member}/purchases`).set(auth).send({amount,idempotencyKey:key??randomUUID()});
  const redeem=(amount:number,key?:string)=>request(app.getHttpServer()).post(`/api/v1/shares/member/${member}/redemptions`).set(auth).send({amount,idempotencyKey:key??randomUUID()});
  async function proof(){return tenant(async c=>(await c.query(`SELECT a.current_balance,
   (SELECT sum(signed_amount)::text FROM share_transactions WHERE account_id=a.id) AS movements,
   (SELECT count(*)::int FROM share_transactions WHERE account_id=a.id) AS transactions,
   (SELECT sum(debit)::text FROM journal_lines WHERE journal_entry_id IN(SELECT journal_entry_id FROM share_transactions WHERE account_id=a.id)) AS debit,
   (SELECT sum(credit)::text FROM journal_lines WHERE journal_entry_id IN(SELECT journal_entry_id FROM share_transactions WHERE account_id=a.id)) AS credit,
   (SELECT sum(credit-debit)::text FROM journal_lines jl JOIN chart_of_accounts coa ON coa.id=jl.account_id WHERE coa.code='3000' AND jl.member_id=a.member_id) AS equity
   FROM member_share_accounts a WHERE a.member_id=$1`,[member])).rows[0]);}
  return {org,auth,member,tenant,purchase,redeem,proof};
 }
 it('conserves 115 one-kobo purchases and redemptions down to exactly zero',async()=>{
  const f=await fixture();for(let n=0;n<115;n++)await f.purchase(0.01).expect(201);
  let p=await f.proof();expect(p.current_balance).toBe('1.15');expect(p.movements).toBe('1.15');expect(p.equity).toBe('1.15');expect(p.debit).toBe(p.credit);
  await f.redeem(0.23).expect(201);expect((await f.proof()).current_balance).toBe('0.92');await f.redeem(0.92).expect(201);
  p=await f.proof();expect(p.current_balance).toBe('0.00');expect(p.movements).toBe('0.00');expect(p.equity).toBe('0.00');expect(p.debit).toBe(p.credit);
  await f.redeem(0.01).expect(400);expect(await f.proof()).toEqual(p);
 });
 it('serializes simultaneous first purchases into one account without losing kobo',async()=>{
  const f=await fixture();await Promise.all(Array.from({length:20},()=>f.purchase(0.01).expect(201)));
  const p=await f.proof();expect(p.current_balance).toBe('0.20');expect(p.movements).toBe('0.20');expect(p.equity).toBe('0.20');expect(p.transactions).toBe(20);expect(p.debit).toBe(p.credit);
  expect(await f.tenant(async c=>(await c.query('SELECT count(*)::int AS n FROM member_share_accounts WHERE member_id=$1',[f.member])).rows[0].n)).toBe(1);
 });
 it('conserves concurrent purchases and redemptions on an existing account',async()=>{
  const f=await fixture();await f.purchase(0.20).expect(201);
  await Promise.all(Array.from({length:20},(_,n)=>n%2===0?f.purchase(0.01).expect(201):f.redeem(0.01).expect(201)));
  const p=await f.proof();expect(p.current_balance).toBe('0.20');expect(p.movements).toBe('0.20');expect(p.equity).toBe('0.20');expect(p.transactions).toBe(21);expect(p.debit).toBe(p.credit);
 });
 it('allows only one of two redemptions that together exceed the balance',async()=>{
  const f=await fixture();await f.purchase(0.05).expect(201);
  const responses=await Promise.all([f.redeem(0.03),f.redeem(0.03)]);expect(responses.map(r=>r.status).sort()).toEqual([201,400]);
  const p=await f.proof();expect(p.current_balance).toBe('0.02');expect(p.movements).toBe('0.02');expect(p.equity).toBe('0.02');expect(p.transactions).toBe(2);expect(p.debit).toBe(p.credit);
 });
 it('preserves one-kobo changes to balances beyond binary-number precision',async()=>{
  const f=await fixture();await f.purchase(0.01).expect(201);
  // Synthetic opening fixture isolates arithmetic; no production balances are rewritten.
  await f.tenant(c=>c.query('UPDATE member_share_accounts SET current_balance=$1 WHERE member_id=$2',['90071992547409.91',f.member]));
  await f.purchase(0.01).expect(201);expect((await f.proof()).current_balance).toBe('90071992547409.92');await f.redeem(0.01).expect(201);
  const p=await f.proof();expect(p.current_balance).toBe('90071992547409.91');expect(p.movements).toBe('0.01');expect(p.equity).toBe('0.01');expect(p.debit).toBe(p.credit);
 });
 it('posts and redeems the maximum supported numeric input exactly',async()=>{
  const f=await fixture();await f.purchase(100000000000).expect(201);await f.redeem(99999999999.99).expect(201);expect((await f.proof()).current_balance).toBe('0.01');await f.redeem(0.01).expect(201);
  const p=await f.proof();expect(p.current_balance).toBe('0.00');expect(p.equity).toBe('0.00');expect(p.debit).toBe('200000000000.00');expect(p.credit).toBe(p.debit);
 });
 it('rejects invalid amounts and replays repeated keys without extra writes',async()=>{
  const f=await fixture(),key=randomUUID();const bought=await f.purchase(0.23,key).expect(201);const sold=await f.redeem(0.01,'redeem-'+key).expect(201);const before=await f.proof();
  expect((await f.purchase(0.23,key).expect(201)).body).toEqual(bought.body);expect((await f.redeem(0.01,'redeem-'+key).expect(201)).body).toEqual(sold.body);await f.purchase(0.001).expect(400);await f.redeem(0.001).expect(400);await f.purchase(100000000000.01).expect(400);expect(await f.proof()).toEqual(before);
  await f.tenant(c=>c.query('UPDATE member_share_accounts SET current_balance=$1 WHERE member_id=$2',['99999999999999999.99',f.member]));const max=await f.proof();await f.purchase(0.01).expect(400);expect(await f.proof()).toEqual(max);
 });
 it('rolls back account creation and journal counter if the accounting period is closed',async()=>{
  const f=await fixture();await f.tenant(c=>c.query("UPDATE ledger_periods SET status='CLOSED'"));
  const before=await f.tenant(async c=>(await c.query('SELECT journal_seq FROM org_counters')).rows[0].journal_seq);
  await f.purchase(0.01).expect(409);expect(await f.proof()).toBeUndefined();
  expect(await f.tenant(async c=>(await c.query('SELECT journal_seq FROM org_counters')).rows[0].journal_seq)).toBe(before);
 });
 it('retains active-member restrictions for both money operations',async()=>{
  const f=await fixture();await f.purchase(0.23).expect(201);const before=await f.proof();await f.tenant(c=>c.query("UPDATE members SET status='EXITED' WHERE id=$1",[f.member]));
  await f.purchase(0.01).expect(409);await f.redeem(0.01).expect(409);expect(await f.proof()).toEqual(before);
 });
 it('denies purchases, redemptions and account reads across tenants',async()=>{
  const a=await fixture(),b=await fixture();await b.purchase(0.23).expect(201);const before=await b.proof();
  await request(app.getHttpServer()).post(`/api/v1/shares/member/${b.member}/purchases`).set(a.auth).send({ idempotencyKey: randomUUID(),amount:0.01}).expect(404);
  await request(app.getHttpServer()).post(`/api/v1/shares/member/${b.member}/redemptions`).set(a.auth).send({ idempotencyKey: randomUUID(),amount:0.01}).expect(404);
  await request(app.getHttpServer()).get(`/api/v1/shares/member/${b.member}`).set(a.auth).expect(404);expect(await b.proof()).toEqual(before);
 });
});
