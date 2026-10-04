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

describe('exact loan origination, schedule and journal amounts (PostgreSQL)',()=>{
 let app:INestApplication,pool:Pool,orgId:string,token:string,borrower:string,account:string,cash:string,asset:string;
 const guarantors:string[]=[];
 const auth=()=>({Authorization:`Bearer ${token}`});
 const apply=(principal:number,termMonths:number,productId=cash)=>request(app.getHttpServer()).post('/api/v1/loans').set(auth()).send({memberId:borrower,productId,principal,termMonths,guarantorIds:guarantors});
 const tenant=<T>(fn:Parameters<typeof withTenant<T>>[2])=>withTenant(pool,orgId,fn);
 beforeAll(async()=>{
  process.env.DATABASE_URL=TEST_DATABASE_URL;pool=new Pool({connectionString:TEST_DATABASE_URL});await ensureRbacSeeded(pool);
  const module=await Test.createTestingModule({imports:[AppModule]}).compile();app=module.createNestApplication();app.setGlobalPrefix('api/v1');app.useGlobalPipes(new ValidationPipe({whitelist:true,transform:true,forbidNonWhitelisted:true}));await app.init();
  const platform=(await request(app.getHttpServer()).post('/api/v1/auth/login').send({email:'admin@coopengine.dev',password:ADMIN_PASSWORD}).expect(200)).body.tokens.accessToken;
  const suffix=randomUUID().slice(0,8),email=`exact-money-${suffix}@coopengine.test`;
  orgId=(await request(app.getHttpServer()).post('/api/v1/organizations').set('Authorization',`Bearer ${platform}`).send({name:`Exact money ${suffix}`,slug:`exact-money-${suffix}`,adminEmail:email,adminPassword:'ExactMoneyPass123!'}).expect(201)).body.id;
  token=(await request(app.getHttpServer()).post('/api/v1/auth/login').send({email,password:'ExactMoneyPass123!'}).expect(200)).body.tokens.accessToken;
  for(let index=0;index<3;index++){
   const id=(await request(app.getHttpServer()).post('/api/v1/members').set(auth()).send({firstName:`Exact ${index}`,lastName:'Synthetic'}).expect(201)).body.id;
   await request(app.getHttpServer()).post(`/api/v1/members/${id}/approve`).set(auth()).expect(200);
   if(index===0)borrower=id;else guarantors.push(id);
  }
  account=(await request(app.getHttpServer()).post(`/api/v1/savings/member/${borrower}/account`).set(auth()).send({}).expect(201)).body.id;
  const products=(await request(app.getHttpServer()).get('/api/v1/loans/products').set(auth()).expect(200)).body;
  cash=products.find((p:{code:string})=>p.code==='CASH-LOAN').id;asset=products.find((p:{code:string})=>p.code==='ASSET-FINANCE').id;
 });
 afterAll(async()=>{await app?.close();await pool?.end();});
 async function qualifyingBalance(value:string){
  // Synthetic DB fixture only: this isolates loan arithmetic from the still-open savings posting work.
  await tenant(c=>c.query('UPDATE member_savings_accounts SET current_balance=$1 WHERE id=$2',[value,account]));
 }
 async function disburse(id:string){
  await request(app.getHttpServer()).post(`/api/v1/loans/${id}/approve`).set(auth()).expect(200);
  await request(app.getHttpServer()).post(`/api/v1/loans/${id}/disburse`).set(auth()).send({}).expect(200);
 }
 async function repaymentLoan(principal:number,rate:number,months:number){
  await qualifyingBalance('60000000000.00');
  await tenant(c=>c.query('UPDATE loan_products SET interest_rate_pa=$1 WHERE id=$2',[String(rate),cash]));
  const id=(await apply(principal,months).expect(201)).body.id;await disburse(id);return id;
 }
 const repay=(id:string,amount:number,key?:string)=>request(app.getHttpServer()).post(`/api/v1/loans/${id}/repayments`).set(auth()).send({amount,...(key?{idempotencyKey:key}:{})});
 async function repaymentProof(id:string){
  return tenant(async c=>(await c.query(`SELECT l.status,l.outstanding_principal,
   (SELECT sum(paid_principal)::text FROM loan_repayments WHERE loan_id=l.id) AS paid_principal,
   (SELECT sum(paid_interest)::text FROM loan_repayments WHERE loan_id=l.id) AS paid_interest,
   (SELECT sum(debit)::text FROM journal_lines WHERE journal_entry_id IN(SELECT id FROM journal_entries WHERE source_id=l.id AND source='LOAN_REPAYMENT')) AS debit,
   (SELECT sum(credit)::text FROM journal_lines WHERE journal_entry_id IN(SELECT id FROM journal_entries WHERE source_id=l.id AND source='LOAN_REPAYMENT')) AS credit,
   (SELECT count(*)::int FROM journal_entries WHERE source_id=l.id AND source='LOAN_REPAYMENT') AS entries
   FROM loans l WHERE id=$1`,[id])).rows[0]);
 }
 it('conserves 115 one-kobo repayments and closes exactly at zero',async()=>{
  const id=await repaymentLoan(1.15,0,5);
  for(let n=0;n<115;n++)await repay(id,0.01).expect(200);
  expect(await repaymentProof(id)).toEqual({status:'COMPLETED',outstanding_principal:'0.00',paid_principal:'1.15',paid_interest:'0.00',debit:'1.15',credit:'1.15',entries:115});
  await repay(id,0.01).expect(409);
 });
 it('allocates interest first in installment order with exact partial payments',async()=>{
  const id=await repaymentLoan(1.15,120,5); // total interest 0.58: four 0.11, final 0.14
  await repay(id,0.10).expect(200);await repay(id,0.24).expect(200);await repay(id,0.01).expect(200);
  const rows=await tenant(async c=>(await c.query('SELECT paid_principal,paid_interest,status FROM loan_repayments WHERE loan_id=$1 ORDER BY seq',[id])).rows);
  expect(rows[0]).toEqual({paid_principal:'0.23',paid_interest:'0.11',status:'PAID'});
  expect(rows[1]).toEqual({paid_principal:'0.00',paid_interest:'0.01',status:'PARTIAL'});
  const partial=await repaymentProof(id);expect(partial.outstanding_principal).toBe('0.92');expect(partial.debit).toBe('0.35');expect(partial.credit).toBe('0.35');
  await repay(id,1.38).expect(200);
  expect(await repaymentProof(id)).toEqual({status:'COMPLETED',outstanding_principal:'0.00',paid_principal:'1.15',paid_interest:'0.58',debit:'1.73',credit:'1.73',entries:4});
 });
 it('rejects one-kobo overpayment without changing balances or journals',async()=>{
  const id=await repaymentLoan(1.15,0,5),before=await repaymentProof(id);
  await repay(id,1.16).expect(400);expect(await repaymentProof(id)).toEqual(before);
 });
 it('posts the maximum supported numeric repayment without precision loss',async()=>{
  const id=await repaymentLoan(100000000000,0,60);await repay(id,99999999999.99).expect(200);
  expect((await repaymentProof(id)).outstanding_principal).toBe('0.01');await repay(id,0.01).expect(200);
  const proof=await repaymentProof(id);expect(proof.debit).toBe('100000000000.00');expect(proof.credit).toBe(proof.debit);expect(proof.status).toBe('COMPLETED');
 });
 it('rolls back allocation and outstanding balance when the accounting period is closed',async()=>{
  const id=await repaymentLoan(1.15,0,5),before=await repaymentProof(id);
  await tenant(c=>c.query("UPDATE ledger_periods SET status='CLOSED' WHERE status='OPEN'"));
  try{await repay(id,0.23).expect(409);expect(await repaymentProof(id)).toEqual(before);}
  finally{await tenant(c=>c.query("UPDATE ledger_periods SET status='OPEN' WHERE now()::date BETWEEN start_date AND end_date"));}
 });
 it('rejects duplicate repayment keys without another allocation',async()=>{
  const id=await repaymentLoan(1.15,0,5),key=randomUUID();await repay(id,0.23,key).expect(200);
  const before=await repaymentProof(id);await repay(id,0.23,key).expect(409);expect(await repaymentProof(id)).toEqual(before);
 });
 it('accepts the exact 3x boundary and rejects one additional kobo without persisting a loan',async()=>{
  await qualifyingBalance('1.15');await apply(3.45,5).expect(201);
  const before=await tenant(async c=>(await c.query('SELECT count(*)::int AS n FROM loans')).rows[0].n);
  await apply(3.46,5).expect(400);
  expect(await tenant(async c=>(await c.query('SELECT count(*)::int AS n FROM loans')).rows[0].n)).toBe(before);
 });
 it('persists five exact 23-kobo installments instead of floating-point floor drift',async()=>{
  await qualifyingBalance('1.15');await tenant(c=>c.query('UPDATE loan_products SET interest_rate_pa=0 WHERE id=$1',[cash]));
  const id=(await apply(1.15,5).expect(201)).body.id;await disburse(id);
  const rows=await tenant(async c=>(await c.query('SELECT principal_due,interest_due FROM loan_repayments WHERE loan_id=$1 ORDER BY seq',[id])).rows);
  expect(rows).toEqual(Array.from({length:5},()=>({principal_due:'0.23',interest_due:'0.00'})));
 });
 it.each([
  ['cash',15,50000,1],['cash',15,50000,12],['cash',15,50000,60],
  ['asset',12.5,50000,3],['cash',13.3333,17.29,7],['cash',6,1,1],['asset',12.3456,100000000000,60],
 ])('conserves %s principal/interest and balanced disbursement at %s%% for %s over %s months',async(kind,rate,principal,months)=>{
  await qualifyingBalance('60000000000.00');const product=kind==='asset'?asset:cash;
  await tenant(c=>c.query('UPDATE loan_products SET interest_rate_pa=$1 WHERE id=$2',[String(rate),product]));
  const id=(await apply(Number(principal),Number(months),product).expect(201)).body.id;await disburse(id);
  const proof=await tenant(async c=>(await c.query(`SELECT l.principal,l.outstanding_principal,
   round(l.principal*l.interest_rate_pa*l.term_months/1200,2)::text AS expected_interest,
   (SELECT sum(principal_due)::text FROM loan_repayments WHERE loan_id=l.id) AS schedule_principal,
   (SELECT sum(interest_due)::text FROM loan_repayments WHERE loan_id=l.id) AS schedule_interest,
   (SELECT sum(debit)::text FROM journal_lines WHERE journal_entry_id IN(SELECT id FROM journal_entries WHERE source_type='loan' AND source_id=l.id)) AS journal_debit,
   (SELECT sum(credit)::text FROM journal_lines WHERE journal_entry_id IN(SELECT id FROM journal_entries WHERE source_type='loan' AND source_id=l.id)) AS journal_credit
   FROM loans l WHERE id=$1`,[id])).rows[0]);
  expect(proof.schedule_principal).toBe(proof.principal);expect(proof.outstanding_principal).toBe(proof.principal);
  expect(proof.schedule_interest).toBe(proof.expected_interest);expect(proof.journal_debit).toBe(proof.principal);expect(proof.journal_credit).toBe(proof.principal);
 });
 it('uses the applied rate snapshot after the product rate changes',async()=>{
  await qualifyingBalance('60000000000.00');await tenant(c=>c.query('UPDATE loan_products SET interest_rate_pa=15 WHERE id=$1',[cash]));
  const id=(await apply(50000,12).expect(201)).body.id;
  await tenant(c=>c.query('UPDATE loan_products SET interest_rate_pa=99.9999 WHERE id=$1',[cash]));await disburse(id);
  const proof=await tenant(async c=>(await c.query('SELECT l.interest_rate_pa,(SELECT sum(interest_due)::text FROM loan_repayments WHERE loan_id=l.id) AS interest FROM loans l WHERE id=$1',[id])).rows[0]);
  expect(proof).toEqual({interest_rate_pa:'15.0000',interest:'7500.00'});
 });
 it('rejects overflow and rolls back the disbursement journal, schedule, status and counter',async()=>{
  const id=randomUUID();await tenant(c=>c.query(`INSERT INTO loans(id,organization_id,member_id,loan_product_id,principal,term_months,interest_rate_pa,interest_method,status)
   VALUES($1,$2,$3,$4,'99999999999999999.99',60,'999.9999','FLAT','APPROVED')`,[id,orgId,borrower,cash]));
  const before=await tenant(async c=>(await c.query('SELECT journal_seq FROM org_counters WHERE organization_id=$1',[orgId])).rows[0].journal_seq);
  await request(app.getHttpServer()).post(`/api/v1/loans/${id}/disburse`).set(auth()).send({}).expect(400);
  const proof=await tenant(async c=>(await c.query(`SELECT status,(SELECT count(*)::int FROM loan_repayments WHERE loan_id=$1) AS rows,
   (SELECT count(*)::int FROM journal_entries WHERE source_type='loan' AND source_id=$1) AS journals FROM loans WHERE id=$1`,[id])).rows[0]);
  expect(proof).toEqual({status:'APPROVED',rows:0,journals:0});
  expect(await tenant(async c=>(await c.query('SELECT journal_seq FROM org_counters WHERE organization_id=$1',[orgId])).rows[0].journal_seq)).toBe(before);
 });
 it('rejects over-precision and oversized number inputs before financial writes',async()=>{
  await apply(1.005,12).expect(400);await apply(100000000000.01,12).expect(400);
 });
});
