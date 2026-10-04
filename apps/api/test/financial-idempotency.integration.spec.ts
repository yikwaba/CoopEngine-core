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

describe('durable financial retry receipts (PostgreSQL)',()=>{
 let app:INestApplication,pool:Pool,platform:string;
 beforeAll(async()=>{
  process.env.DATABASE_URL=TEST_DATABASE_URL;pool=new Pool({connectionString:TEST_DATABASE_URL});await ensureRbacSeeded(pool);
  const module=await Test.createTestingModule({imports:[AppModule]}).compile();app=module.createNestApplication();app.setGlobalPrefix('api/v1');app.useGlobalPipes(new ValidationPipe({whitelist:true,transform:true,forbidNonWhitelisted:true}));await app.init();
  platform=(await request(app.getHttpServer()).post('/api/v1/auth/login').send({email:'admin@coopengine.dev',password:ADMIN_PASSWORD}).expect(200)).body.tokens.accessToken;
 });
 afterAll(async()=>{await app?.close();await pool?.end();});
 async function fixture(count=2){
  const suffix=randomUUID().slice(0,8),email=`financial-retry-${suffix}@coopengine.test`;
  const org=(await request(app.getHttpServer()).post('/api/v1/organizations').set('Authorization',`Bearer ${platform}`).send({name:`Exact payroll ${suffix}`,slug:`financial-retry-${suffix}`,adminEmail:email,adminPassword:'ExactPayrollPass123!'}).expect(201)).body.id;
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
  const preview=(csv:string)=>request(app.getHttpServer()).post('/api/v1/payroll/import/preview').set(auth).send({filename:'financial-retry.csv',csv});
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
 async function savings(count=1){const f=await fixture(count),account=(await request(app.getHttpServer()).post(`/api/v1/savings/member/${f.members[0]!.id}/account`).set(f.auth).send({}).expect(201)).body.id;return{...f,account};}
 type F=Awaited<ReturnType<typeof savings>>;
 const deposit=(f:F,key:string,amount=0.23)=>request(app.getHttpServer()).post(`/api/v1/savings/accounts/${f.account}/deposits`).set(f.auth).send({amount,idempotencyKey:key});
 const withdrawal=(f:F,key:string,amount=0.01)=>request(app.getHttpServer()).post(`/api/v1/savings/accounts/${f.account}/withdrawals`).set(f.auth).send({amount,idempotencyKey:key});
 const purchase=(f:F,key:string,amount=0.23)=>request(app.getHttpServer()).post(`/api/v1/shares/member/${f.members[0]!.id}/purchases`).set(f.auth).send({amount,idempotencyKey:key});
 const redemption=(f:F,key:string,amount=0.01)=>request(app.getHttpServer()).post(`/api/v1/shares/member/${f.members[0]!.id}/redemptions`).set(f.auth).send({amount,idempotencyKey:key});
 async function state(f:F){return f.tenant(async c=>({
  savings:(await c.query('SELECT current_balance FROM member_savings_accounts ORDER BY id')).rows,
  shares:(await c.query('SELECT current_balance FROM member_share_accounts ORDER BY id')).rows,
  journals:(await c.query('SELECT id,source,idempotency_key FROM journal_entries ORDER BY id')).rows,
  movements:(await c.query('SELECT id,signed_amount FROM savings_transactions ORDER BY id')).rows,
  shareMovements:(await c.query('SELECT id,signed_amount FROM share_transactions ORDER BY id')).rows,
  receipts:(await c.query('SELECT id,action,intent_key,fingerprint,response,completed_at FROM financial_write_receipts ORDER BY id')).rows,
  requests:(await c.query('SELECT id,status FROM savings_withdrawal_requests ORDER BY id')).rows,
  audits:(await c.query('SELECT id FROM audit_logs ORDER BY id')).rows,
  counter:(await c.query('SELECT journal_seq FROM org_counters')).rows[0],
 }));}
 it('returns the committed deposit response after response loss and later account activity',async()=>{
  const f=await savings(),key=randomUUID(),original=await deposit(f,key).expect(201);await deposit(f,randomUUID(),0.01).expect(201);const before=await state(f);const retry=await deposit(f,key).expect(201);expect(retry.body).toEqual(original.body);expect(retry.body.currentBalance).toBe(0.23);expect(await state(f)).toEqual(before);
 });
 it('concurrent identical deposits return one effect and identical responses',async()=>{
  const f=await savings(),key=randomUUID();const responses=await Promise.all(Array.from({length:5},()=>deposit(f,key).expect(201)));for(const r of responses)expect(r.body).toEqual(responses[0].body);const s=await state(f);expect(s.journals).toHaveLength(1);expect(s.movements).toHaveLength(1);expect(s.receipts).toHaveLength(1);expect(s.savings[0].current_balance).toBe('0.23');
 });
 it('rejects changed amounts, description, targets or actor for a used action/key',async()=>{
  const f=await savings(2),key=randomUUID();await deposit(f,key).expect(201);const second=(await request(app.getHttpServer()).post(`/api/v1/savings/member/${f.members[1]!.id}/account`).set(f.auth).send({}).expect(201)).body.id,before=await state(f);await deposit(f,key,0.24).expect(409);
  await request(app.getHttpServer()).post(`/api/v1/savings/accounts/${f.account}/deposits`).set(f.auth).send({amount:0.23,description:'changed',idempotencyKey:key}).expect(409);
  await request(app.getHttpServer()).post(`/api/v1/savings/accounts/${second}/deposits`).set(f.auth).send({amount:0.23,idempotencyKey:key}).expect(409);
  await request(app.getHttpServer()).post(`/api/v1/savings/accounts/${f.account}/deposits`).set(f.checker).send({amount:0.23,idempotencyKey:key}).expect(409);expect(await state(f)).toEqual(before);
 });
 it('allows genuinely new identical payments with different keys',async()=>{
  const f=await savings();await deposit(f,randomUUID()).expect(201);await deposit(f,randomUUID()).expect(201);const s=await state(f);expect(s.savings[0].current_balance).toBe('0.46');expect(s.journals).toHaveLength(2);
 });
 it('scopes keys by action and tenant while journaling unique source keys',async()=>{
  const a=await savings(),b=await savings(),key=randomUUID();await Promise.all([deposit(a,key).expect(201),purchase(a,key).expect(201)]);await deposit(b,key).expect(201);const s=await state(a);expect(s.receipts).toHaveLength(2);expect(new Set(s.journals.map(j=>j.idempotency_key)).size).toBe(2);expect((await state(b)).receipts).toHaveLength(1);
  const leaked=await b.tenant(async c=>(await c.query('SELECT id FROM financial_write_receipts WHERE organization_id=$1',[a.org])).rows);expect(leaked).toHaveLength(0);
 });
 it('replays immediate withdrawals even if policy changes after commit',async()=>{
  const f=await savings(),key=randomUUID();await deposit(f,randomUUID()).expect(201);const original=await withdrawal(f,key).expect(200);await f.tenant(c=>c.query('UPDATE organizations SET withdrawal_approval_threshold=0 WHERE id=$1',[f.org]));const before=await state(f);expect((await withdrawal(f,key).expect(200)).body).toEqual(original.body);expect(await state(f)).toEqual(before);expect(before.requests).toHaveLength(0);
 });
 it('concurrent duplicate pending withdrawals create one request and replay it after a policy change',async()=>{
  const f=await savings(),key=randomUUID();await f.tenant(c=>c.query('UPDATE organizations SET withdrawal_approval_threshold=0 WHERE id=$1',[f.org]));const results=await Promise.all([withdrawal(f,key).expect(200),withdrawal(f,key).expect(200)]);expect(results[0].body).toEqual(results[1].body);expect(results[0].body.kind).toBe('PENDING');await f.tenant(c=>c.query('UPDATE organizations SET withdrawal_approval_threshold=NULL WHERE id=$1',[f.org]));const before=await state(f);expect((await withdrawal(f,key).expect(200)).body).toEqual(results[0].body);expect(await state(f)).toEqual(before);expect(before.requests).toHaveLength(1);expect(before.journals).toHaveLength(0);
 });
 it('concurrent share purchase and redemption retries post each intent once',async()=>{
  const f=await savings(),buy=randomUUID(),sell=randomUUID();const buys=await Promise.all([purchase(f,buy).expect(201),purchase(f,buy).expect(201)]);expect(buys[0].body).toEqual(buys[1].body);const sells=await Promise.all([redemption(f,sell).expect(201),redemption(f,sell).expect(201)]);expect(sells[0].body).toEqual(sells[1].body);const s=await state(f);expect(s.shares[0].current_balance).toBe('0.22');expect(s.shareMovements).toHaveLength(2);expect(s.journals).toHaveLength(2);
 });
 it('rolls back the receipt and financial writes if completing the receipt fails',async()=>{
  const f=await savings(),key=randomUUID(),before=await state(f);
  await pool.query(`CREATE FUNCTION intent_test_fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.completed_at IS NOT NULL AND NEW.organization_id='${f.org}'::uuid THEN RAISE EXCEPTION 'synthetic receipt completion failure'; END IF; RETURN NEW; END; $$`);
  await pool.query('CREATE TRIGGER intent_test_fail_receipt BEFORE UPDATE ON financial_write_receipts FOR EACH ROW EXECUTE FUNCTION intent_test_fail_receipt()');
  try{await deposit(f,key).expect(500);expect(await state(f)).toEqual(before);}finally{await pool.query('DROP TRIGGER intent_test_fail_receipt ON financial_write_receipts');await pool.query('DROP FUNCTION intent_test_fail_receipt()');}
  await deposit(f,key).expect(201);expect((await state(f)).journals).toHaveLength(1);
 });
 it('a rejected withdrawal leaves no receipt and may succeed with the same key later',async()=>{
  const f=await savings(),key=randomUUID(),before=await state(f);await withdrawal(f,key).expect(400);expect(await state(f)).toEqual(before);await deposit(f,randomUUID()).expect(201);await withdrawal(f,key).expect(200);expect((await state(f)).savings[0].current_balance).toBe('0.22');
 });
 it('does not reconstruct or repost a historical journal-only key',async()=>{
  const f=await savings(),key='pay:synthetic:'+randomUUID();await deposit(f,key).expect(201);const before=await state(f);await deposit(f,key).expect(409);expect(await state(f)).toEqual(before);
 });
 it('serializes concurrent provider-reference postings without changing their journal key',async()=>{
  const f=await savings(),key='pay:synthetic:'+randomUUID();const results=await Promise.all([deposit(f,key),deposit(f,key)]);expect(results.map(r=>r.status).sort()).toEqual([201,409]);const s=await state(f);expect(s.journals).toHaveLength(1);expect(s.journals[0].idempotency_key).toBe(key);
 });
 it('repayment replay after loan completion returns its first response without another allocation',async()=>{
  const f=await savings(4);await deposit(f,randomUUID(),1000).expect(201);const product=(await request(app.getHttpServer()).get('/api/v1/loans/products').set(f.auth).expect(200)).body.find((p:{code:string})=>p.code==='CASH-LOAN').id;await f.tenant(c=>c.query('UPDATE loan_products SET interest_rate_pa=0 WHERE id=$1',[product]));
  const loan=(await request(app.getHttpServer()).post('/api/v1/loans').set(f.auth).send({memberId:f.members[0]!.id,productId:product,principal:1.15,termMonths:5,guarantorIds:f.members.slice(1).map(m=>m.id)}).expect(201)).body.id;
  await request(app.getHttpServer()).post(`/api/v1/loans/${loan}/approve`).set(f.auth).expect(200);const disburse=()=>request(app.getHttpServer()).post(`/api/v1/loans/${loan}/disburse`).set(f.auth).send({});const ds=await Promise.all([disburse(),disburse()]);expect(ds.map(r=>r.status).sort()).toEqual([200,409]);
  const key=randomUUID(),repay=(amount=1.15)=>request(app.getHttpServer()).post(`/api/v1/loans/${loan}/repayments`).set(f.auth).send({amount,idempotencyKey:key});const results=await Promise.all([repay().expect(200),repay().expect(200)]);expect(results[0].body).toEqual(results[1].body);expect(results[0].body.loan.status).toBe('COMPLETED');const before=await state(f);expect((await repay().expect(200)).body).toEqual(results[0].body);await repay(1.14).expect(409);expect(await state(f)).toEqual(before);
  const proof=await f.tenant(async c=>(await c.query("SELECT count(*)::int AS entries FROM journal_entries WHERE source='LOAN_REPAYMENT' AND source_id=$1",[loan])).rows[0]);expect(proof.entries).toBe(1);
 });
 it('member-originated withdrawal retries create only one pending request',async()=>{
  const f=await savings(),key=randomUUID();
  const service=app.get((await import('../src/savings/savings-withdrawals.service')).SavingsWithdrawalsService);
  const call=()=>service.request(f.org,null,'MEMBER',f.members[0]!.id,f.account,5,'Member request',key);
  const replies=await Promise.all([call(),call()]);expect(replies[0]).toEqual(replies[1]);const before=await state(f);expect(before.requests).toHaveLength(1);expect(await call()).toEqual(replies[0]);expect(await state(f)).toEqual(before);
 });
 it('completed receipts cannot be changed by an ordinary tenant transaction',async()=>{
  const f=await savings(),key=randomUUID();await deposit(f,key).expect(201);const before=await state(f);
  await expect(f.tenant(async c=>{await c.query("SET LOCAL app.maintenance='off'");await c.query("UPDATE financial_write_receipts SET response='{}'::jsonb");})).rejects.toThrow(/immutable/);expect(await state(f)).toEqual(before);
 });

});
