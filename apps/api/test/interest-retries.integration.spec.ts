import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { withTenant } from '@coopengine/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { ADMIN_PASSWORD, TEST_DATABASE_URL, ensureRbacSeeded } from './helpers';

describe('monthly interest retry receipts (PostgreSQL)',()=>{
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
  const period=new Date().toISOString().slice(0,7),actor=(await request(app.getHttpServer()).get('/api/v1/auth/me').set(auth).expect(200)).body.user.id as string;
  const interest=(body:unknown={period})=>request(app.getHttpServer()).post('/api/v1/savings/interest/post').set(auth).send(body as object);
  await deposit(1).expect(201);await tenant(c=>c.query('UPDATE savings_products SET interest_rate_pa=6'));
  const snapshot=()=>tenant(async c=>({
   accounts:(await c.query('SELECT id,current_balance FROM member_savings_accounts ORDER BY id')).rows,
   transactions:(await c.query('SELECT * FROM savings_transactions ORDER BY id')).rows,
   postings:(await c.query('SELECT * FROM savings_interest_postings ORDER BY id')).rows,
   journals:(await c.query('SELECT * FROM journal_entries ORDER BY id')).rows,
   lines:(await c.query('SELECT * FROM journal_lines ORDER BY id')).rows,
   receipts:(await c.query('SELECT * FROM financial_write_receipts ORDER BY id')).rows,
   audit:(await c.query('SELECT * FROM audit_logs ORDER BY id')).rows,
   counters:(await c.query('SELECT * FROM org_counters')).rows,
  }));
  async function proof(){return tenant(async c=>(await c.query(`SELECT a.current_balance,
   (SELECT sum(signed_amount)::text FROM savings_transactions WHERE account_id=a.id) AS movements,
   (SELECT count(*)::int FROM savings_transactions WHERE account_id=a.id) AS transactions,
   (SELECT sum(debit)::text FROM journal_lines WHERE journal_entry_id IN(SELECT journal_entry_id FROM savings_transactions WHERE account_id=a.id)) AS debit,
   (SELECT sum(credit)::text FROM journal_lines WHERE journal_entry_id IN(SELECT journal_entry_id FROM savings_transactions WHERE account_id=a.id)) AS credit,
   (SELECT sum(credit-debit)::text FROM journal_lines jl JOIN chart_of_accounts coa ON coa.id=jl.account_id WHERE coa.code='2000' AND jl.member_id=a.member_id) AS liability
   FROM member_savings_accounts a WHERE a.id=$1`,[account])).rows[0]);}
  return {org,auth,account,tenant,deposit,withdraw,interest,proof,period,actor,snapshot};
 }
 it('concurrent identical period posts return one original receipt and one financial effect',async()=>{
  const f=await fixture(),results=await Promise.all([f.interest().expect(200),f.interest().expect(200)]);expect(results[0].body).toEqual(results[1].body);expect(results[0].body.total).toBe(0.01);
  const p=await f.snapshot();expect(p.postings).toHaveLength(1);expect(p.journals.filter(x=>x.source==='SAVINGS_INTEREST')).toHaveLength(1);expect(p.transactions.filter(x=>x.type==='INTEREST')).toHaveLength(1);expect(p.accounts[0].current_balance).toBe('1.01');expect(p.receipts.filter(x=>x.action==='savings.interest.post')).toHaveLength(1);
  await f.interest().expect(200);expect(await f.snapshot()).toEqual(p);
 });
 it('replays the original result after balances and product rates change',async()=>{
  const f=await fixture(),original=(await f.interest().expect(200)).body;await f.deposit(0.23).expect(201);await f.tenant(c=>c.query('UPDATE savings_products SET interest_rate_pa=120'));const p=await f.snapshot();expect((await f.interest().expect(200)).body).toEqual(original);expect(await f.snapshot()).toEqual(p);
 });
 it('replays a completed receipt after the accounting month closes',async()=>{
  const f=await fixture(),original=(await f.interest().expect(200)).body;await f.tenant(c=>c.query("UPDATE ledger_periods SET status='CLOSED' WHERE code=$1",[f.period]));const p=await f.snapshot();expect((await f.interest().expect(200)).body).toEqual(original);expect(await f.snapshot()).toEqual(p);
 });
 it('refuses a changed actor without duplicating a completed monthly posting',async()=>{
  const f=await fixture();await f.interest().expect(200);const p=await f.snapshot();
  const {SavingsService}=await import('../src/savings/savings.service');await expect(app.get(SavingsService).postInterest(f.org,randomUUID(),f.period)).rejects.toThrow(/different details/);expect(await f.snapshot()).toEqual(p);
 });
 it('current session and grants still gate a completed receipt',async()=>{
  const f=await fixture();await f.interest().expect(200);const p=await f.snapshot();await pool.query('DELETE FROM user_roles WHERE user_id=$1',[f.actor]);await f.interest().expect(401);expect(await f.snapshot()).toEqual(p);
 });
 it('refuses changed browser account scope before the financial transaction',async()=>{
  const f=await fixture(),p=await f.snapshot();await f.interest().set('X-CoopEngine-Financial-Scope',`${randomUUID()}:${f.actor}`).expect(409);expect(await f.snapshot()).toEqual(p);
 });
 it('missing and invalid explicit periods refuse without a receipt or financial change',async()=>{
  const f=await fixture(),p=await f.snapshot();for(const period of [undefined,null,'','2026-00','2026-13','2026-1','2026-10\n',202610,{}])await f.interest(period===undefined?{}:{period}).expect(400);expect(await f.snapshot()).toEqual(p);
 });
 it('a refused first attempt leaves no receipt and can succeed when the period reopens',async()=>{
  const f=await fixture();await f.tenant(c=>c.query("UPDATE ledger_periods SET status='CLOSED' WHERE code=$1",[f.period]));const p=await f.snapshot();await f.interest().expect(409);expect(await f.snapshot()).toEqual(p);await f.tenant(c=>c.query("UPDATE ledger_periods SET status='OPEN' WHERE code=$1",[f.period]));await f.interest().expect(200);
 });
 it('receipt finalization failure rolls back journals, balances, markers, audits and counters',async()=>{
  const f=await fixture(),p=await f.snapshot();await pool.query(`CREATE FUNCTION interest_test_fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.response IS NOT NULL AND NEW.action='savings.interest.post' AND NEW.organization_id='${f.org}'::uuid THEN RAISE EXCEPTION 'synthetic interest receipt failure'; END IF; RETURN NEW; END; $$`);await pool.query('CREATE TRIGGER interest_test_fail_receipt BEFORE UPDATE ON financial_write_receipts FOR EACH ROW EXECUTE FUNCTION interest_test_fail_receipt()');
  try {await f.interest().expect(500);expect(await f.snapshot()).toEqual(p);}finally{await pool.query('DROP TRIGGER interest_test_fail_receipt ON financial_write_receipts');await pool.query('DROP FUNCTION interest_test_fail_receipt()');}
  await f.interest().expect(200);
 });
 it('historical posting without a receipt fails closed instead of guessing an original response',async()=>{
  const f=await fixture();await f.interest().expect(200);
  // Synthetic historical fixture only: the isolated test DB explicitly permits maintenance.
  await f.tenant(async c=>{await c.query("SET LOCAL app.maintenance='on'");await c.query("DELETE FROM financial_write_receipts WHERE action='savings.interest.post'");});
  const p=await f.snapshot();await f.interest().expect(409);expect(await f.snapshot()).toEqual(p);
 });
 it('incomplete receipts require reconciliation and cannot create a new monthly effect',async()=>{
  const f=await fixture(),fingerprint=createHash('sha256').update(JSON.stringify({actorUserId:f.actor,period:f.period})).digest('hex');await f.tenant(c=>c.query("INSERT INTO financial_write_receipts (organization_id,action,intent_key,fingerprint) VALUES ($1,'savings.interest.post',$2,$3)",[f.org,`interest-period:${f.period}`,fingerprint]));const p=await f.snapshot();await f.interest().expect(409);expect(await f.snapshot()).toEqual(p);
 });
 it('separate tenants can post the same month without sharing receipts',async()=>{
  const a=await fixture(),b=await fixture();await Promise.all([a.interest().expect(200),b.interest().expect(200)]);const pa=await a.snapshot(),pb=await b.snapshot();expect(pa.postings).toHaveLength(1);expect(pb.postings).toHaveLength(1);expect(pa.postings[0].id).not.toBe(pb.postings[0].id);expect(pa.postings[0].organization_id).toBe(a.org);expect(pb.postings[0].organization_id).toBe(b.org);
 });
});
