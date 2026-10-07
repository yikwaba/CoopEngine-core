import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { withTenant } from '@coopengine/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { SavingsService } from '../src/savings/savings.service';
import { ReconciliationService } from '../src/payments/reconciliation.service';
import { ADMIN_PASSWORD, TEST_DATABASE_URL, ensureRbacSeeded } from './helpers';

describe('atomic provider allocation and retries (PostgreSQL)',()=>{
 let app:INestApplication,pool:Pool,platform:string,service:ReconciliationService;
 beforeAll(async()=>{
  process.env.DATABASE_URL=TEST_DATABASE_URL;pool=new Pool({connectionString:TEST_DATABASE_URL});await ensureRbacSeeded(pool);
  const module=await Test.createTestingModule({imports:[AppModule]}).compile();app=module.createNestApplication();app.setGlobalPrefix('api/v1');app.useGlobalPipes(new ValidationPipe({whitelist:true,transform:true,forbidNonWhitelisted:true}));await app.init();service=app.get(ReconciliationService);
  platform=(await request(app.getHttpServer()).post('/api/v1/auth/login').send({email:'admin@coopengine.dev',password:ADMIN_PASSWORD}).expect(200)).body.tokens.accessToken;
 });
 afterAll(async()=>{await app?.close();await pool?.end();});
 async function fixture(count=2){
  const suffix=randomUUID().slice(0,8),email=`provider-atomic-${suffix}@coopengine.test`,password='ProviderAtomic123!';
  const org=(await request(app.getHttpServer()).post('/api/v1/organizations').set('Authorization',`Bearer ${platform}`).send({name:`Provider atomic ${suffix}`,slug:`provider-atomic-${suffix}`,adminEmail:email,adminPassword:password}).expect(201)).body.id;
  const login=(await request(app.getHttpServer()).post('/api/v1/auth/login').send({email,password}).expect(200)).body;
  const auth={Authorization:`Bearer ${login.tokens.accessToken}`},members:string[]=[];
  for(let i=0;i<count;i++){
   const m=(await request(app.getHttpServer()).post('/api/v1/members').set(auth).send({firstName:`Provider ${i}`,lastName:'Synthetic'}).expect(201)).body.id;
   await request(app.getHttpServer()).post(`/api/v1/members/${m}/approve`).set(auth).expect(200);members.push(m);
  }
  const tenant=<T>(fn:Parameters<typeof withTenant<T>>[2])=>withTenant(pool,org,fn);
  const intent=async(purpose='SAVINGS_DEPOSIT',expectedAmount=1,memberId=members[0])=>(await request(app.getHttpServer()).post('/api/v1/payments/intents').set(auth).send({memberId,purpose,expectedAmount}).expect(201)).body;
  const record=(body:unknown)=>request(app.getHttpServer()).post('/api/v1/payments/transactions').set(auth).send(body);
  const assign=(id:string,memberId=members[0],purpose='SAVINGS_DEPOSIT')=>request(app.getHttpServer()).post(`/api/v1/payments/exceptions/${id}/assign`).set(auth).send({memberId,purpose});
  const parked=async(amount=0.23)=>(await record({providerReference:randomUUID(),amount,narration:'unknown payer'}).expect(201)).body;
  const va=async(memberId=members[0])=>(await request(app.getHttpServer()).post('/api/v1/payments/virtual-accounts').set(auth).send({memberId}).expect(201)).body.accountNumber;
  return {org,auth,members,tenant,intent,record,assign,parked,va};
 }
 type F=Awaited<ReturnType<typeof fixture>>;
 async function proof(f:F){return f.tenant(async c=>({
  providers:(await c.query('SELECT id,status,member_id,payment_intent_id,journal_entry_id,amount FROM provider_transactions ORDER BY id')).rows,
  intents:(await c.query('SELECT id,status,received_amount FROM payment_intents ORDER BY id')).rows,
  savings:(await c.query('SELECT id,member_id,current_balance FROM member_savings_accounts ORDER BY id')).rows,
  shares:(await c.query('SELECT id,member_id,current_balance FROM member_share_accounts ORDER BY id')).rows,
  movements:(await c.query('SELECT id,signed_amount FROM savings_transactions ORDER BY id')).rows,
  shareMovements:(await c.query('SELECT id,signed_amount FROM share_transactions ORDER BY id')).rows,
  loans:(await c.query('SELECT id,status,outstanding_principal FROM loans ORDER BY id')).rows,
  schedule:(await c.query('SELECT id,status,paid_principal,paid_interest FROM loan_repayments ORDER BY id')).rows,
  journals:(await c.query('SELECT id,status,source,source_id,idempotency_key FROM journal_entries ORDER BY id')).rows,
  totals:(await c.query(`SELECT a.code,sum(jl.debit-jl.credit)::text AS net FROM journal_lines jl JOIN chart_of_accounts a ON a.id=jl.account_id GROUP BY a.code ORDER BY a.code`)).rows,
  notifications:(await c.query('SELECT id,status,journal_entry_id FROM payment_notifications ORDER BY id')).rows,
  queue:(await c.query('SELECT id FROM notifications ORDER BY id')).rows,
  receipts:(await c.query('SELECT id,action,response FROM financial_write_receipts ORDER BY id')).rows,
  audits:(await c.query('SELECT id FROM audit_logs ORDER BY id')).rows,
  counter:(await c.query('SELECT journal_seq,savings_seq FROM org_counters')).rows[0],
 }));}
 async function fault(f:F,table:string,event:string,condition:string,work:()=>Promise<void>){
  const name='provider_fault_'+randomUUID().replaceAll('-','');
  await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.organization_id='${f.org}'::uuid AND (${condition}) THEN RAISE EXCEPTION 'synthetic provider failure'; END IF; RETURN NEW; END; $$`);
  await pool.query(`CREATE TRIGGER ${name} BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`);
  try{await work();}finally{await pool.query(`DROP TRIGGER ${name} ON ${table}`);await pool.query(`DROP FUNCTION ${name}()`);}
 }
 function webhook(body:Record<string,unknown>){
  const raw=JSON.stringify(body),signature=createHash('sha512').update(`${process.env.MONNIFY_SECRET_KEY??'monnify-dev-secret'}|${raw}`).digest('hex');
  return request(app.getHttpServer()).post('/api/v1/payments/monnify/webhook').set('content-type','application/json').set('monnify-signature',signature).send(raw);
 }
 const net=(p:Awaited<ReturnType<typeof proof>>,code:string)=>p.totals.find(x=>x.code===code)?.net??'0.00';
 async function loan(f:F){
  const account=(await request(app.getHttpServer()).post(`/api/v1/savings/member/${f.members[0]}/account`).set(f.auth).send({}).expect(201)).body.id;
  await request(app.getHttpServer()).post(`/api/v1/savings/accounts/${account}/deposits`).set(f.auth).send({ idempotencyKey: randomUUID(),amount:1000}).expect(201);
  const product=(await request(app.getHttpServer()).get('/api/v1/loans/products').set(f.auth).expect(200)).body.find((p:{code:string})=>p.code==='CASH-LOAN').id;
  await f.tenant(c=>c.query('UPDATE loan_products SET interest_rate_pa=12 WHERE id=$1',[product]));
  const id=(await request(app.getHttpServer()).post('/api/v1/loans').set(f.auth).send({idempotencyKey:randomUUID(),memberId:f.members[0],productId:product,principal:1.15,termMonths:5,guarantorIds:f.members.slice(1)}).expect(201)).body.id;
  await request(app.getHttpServer()).post(`/api/v1/loans/${id}/approve`).set(f.auth).expect(200);
  await request(app.getHttpServer()).post(`/api/v1/loans/${id}/disburse`).set(f.auth).send({}).expect(200);return id;
 }
 it('five concurrent identical receipts post once and increment the intent once',async()=>{
  const f=await fixture(),intent=await f.intent(),body={provider:'MONNIFY',providerReference:randomUUID(),amount:0.23,narration:intent.reference};
  const replies=await Promise.all(Array.from({length:5},()=>f.record(body).expect(201)));
  expect(replies.filter(r=>!r.body.duplicate)).toHaveLength(1);expect(replies.every(r=>r.body.matched)).toBe(true);
  const p=await proof(f);expect(p.providers).toHaveLength(1);expect(p.journals).toHaveLength(1);expect(p.movements).toHaveLength(1);expect(p.receipts).toHaveLength(1);expect(p.intents[0].received_amount).toBe('0.23');expect(p.savings[0].current_balance).toBe('0.23');
  const before=await proof(f);await f.record(body).expect(201);expect(await proof(f)).toEqual(before);
 });
 it('distinct concurrent partial receipts conserve their exact intent total',async()=>{
  const f=await fixture(),i=await f.intent();await Promise.all([0.01,0.23,0.07].map(amount=>f.record({providerReference:randomUUID(),amount,narration:i.reference}).expect(201)));
  const p=await proof(f);expect(p.intents[0].received_amount).toBe('0.31');expect(p.intents[0].status).toBe('PARTIAL');expect(p.savings[0].current_balance).toBe('0.31');expect(p.journals).toHaveLength(3);
 });
 it('rejects changed amount or routing on a recorded reference without writes',async()=>{
  const f=await fixture(),i=await f.intent(),body={providerReference:randomUUID(),amount:0.23,narration:i.reference};await f.record(body).expect(201);const before=await proof(f);
  await f.record({...body,amount:0.24}).expect(409);await f.record({...body,narration:'other member'}).expect(409);await f.record({...body,virtualAccountNo:'1234567890'}).expect(409);expect(await proof(f)).toEqual(before);
 });
 it('late matching-state failure rolls back the receipt, account opening, money and intent total',async()=>{
  const f=await fixture(),i=await f.intent(),body={providerReference:randomUUID(),amount:0.23,narration:i.reference},before=await proof(f);
  await fault(f,'provider_transactions','UPDATE',"NEW.status='MATCHED'",async()=>{await f.record(body).expect(500);expect(await proof(f)).toEqual(before);});
  await f.record(body).expect(201);const p=await proof(f);expect(p.providers[0].status).toBe('MATCHED');expect(p.savings[0].current_balance).toBe('0.23');expect(p.intents[0].received_amount).toBe('0.23');
 });
 it('sweep/match retries of an existing unmatched row return one cached outcome',async()=>{
  const f=await fixture(),i=await f.intent();const id=await f.tenant(async c=>(await c.query(`INSERT INTO provider_transactions (organization_id,provider_reference,amount,narration) VALUES ($1,$2,'0.23',$3) RETURNING id`,[f.org,randomUUID(),i.reference])).rows[0].id);
  const outcomes=await Promise.all([service.match(f.org,null,id),service.match(f.org,null,id)]);expect(outcomes[0]).toEqual(outcomes[1]);const before=await proof(f);expect(await service.match(f.org,null,id)).toEqual(outcomes[0]);expect(await proof(f)).toEqual(before);
 });
 it('unknown receipt retries park the cash once; matching never posts a parked receipt from cash again',async()=>{
  const f=await fixture(),body={providerReference:randomUUID(),amount:0.23,narration:'nobody identified'};const replies=await Promise.all([f.record(body).expect(201),f.record(body).expect(201)]);expect(replies.every(r=>r.body.exception)).toBe(true);
  const before=await proof(f);expect(before.journals).toHaveLength(1);expect(before.savings).toHaveLength(0);expect(net(before,'2990')).toBe('-0.23');await service.match(f.org,null,before.providers[0].id);expect(await proof(f)).toEqual(before);
 });
 it('concurrent manual savings allocation replays one result, updates member balance and releases suspense with no extra cash',async()=>{
  const f=await fixture(),parked=await f.parked(),before=await proof(f);const results=await Promise.all([f.assign(parked.transactionId).expect(200),f.assign(parked.transactionId).expect(200)]);expect(results[0].body).toEqual(results[1].body);
  const after=await proof(f);expect(after.savings[0].current_balance).toBe('0.23');expect(after.movements).toHaveLength(1);expect(after.journals).toHaveLength(3);expect(net(after,'2990')).toBe('0.00');expect(net(after,'1000')).toBe(net(before,'1000'));expect(net(after,'2000')).toBe('-0.23');
  expect((await f.assign(parked.transactionId).expect(200)).body).toEqual(results[0].body);await f.assign(parked.transactionId,f.members[1]).expect(409);await f.assign(parked.transactionId,f.members[0],'SHARE_PURCHASE').expect(409);expect(await proof(f)).toEqual(after);
 });
 it('manual share allocation updates the share movement and balance exactly once',async()=>{
  const f=await fixture(),p=await f.parked(),results=await Promise.all([f.assign(p.transactionId,f.members[0],'SHARE_PURCHASE').expect(200),f.assign(p.transactionId,f.members[0],'SHARE_PURCHASE').expect(200)]);expect(results[0].body).toEqual(results[1].body);
  const state=await proof(f);expect(state.shares[0].current_balance).toBe('0.23');expect(state.shareMovements).toHaveLength(1);expect(net(state,'2990')).toBe('0.00');expect(net(state,'3000')).toBe('-0.23');
 });
 it('manual loan allocation updates interest, principal, schedule and notifications once',async()=>{
  const f=await fixture(4),id=await loan(f),p=await f.parked(),before=await proof(f);const replies=await Promise.all([f.assign(p.transactionId,f.members[0],'LOAN_REPAYMENT').expect(200),f.assign(p.transactionId,f.members[0],'LOAN_REPAYMENT').expect(200)]);expect(replies[0].body).toEqual(replies[1].body);
  const state=await proof(f);expect(state.loans.find(x=>x.id===id)?.outstanding_principal).toBe('0.93');expect(state.schedule.reduce((s,r)=>s+Number(r.paid_interest),0)).toBe(0.01);expect(net(state,'2990')).toBe('0.00');expect(net(state,'1000')).toBe(net(before,'1000'));expect(state.queue.length).toBe(before.queue.length+1);const stable=await proof(f);await f.assign(p.transactionId,f.members[0],'LOAN_REPAYMENT').expect(200);expect(await proof(f)).toEqual(stable);
 });
 it('allocation failure after domain posting rolls back both journals, member projection, audit and receipt',async()=>{
  const f=await fixture(),p=await f.parked(),before=await proof(f);
  await fault(f,'journal_entries','INSERT',"NEW.source='PAYMENT_ALLOCATED'",async()=>{await f.assign(p.transactionId).expect(500);expect(await proof(f)).toEqual(before);});
  await f.assign(p.transactionId).expect(200);expect((await proof(f)).savings[0].current_balance).toBe('0.23');
 });
 it('signed duplicate callbacks persist one notification and one payment',async()=>{
  const f=await fixture(),accountNumber=await f.va(),body={accountNumber,paymentReference:randomUUID(),transactionReference:randomUUID(),amountPaid:0.23,transactionStatus:'SUCCESSFUL',paymentDescription:'savings'};
  const results=await Promise.all(Array.from({length:4},()=>webhook(body).expect(200)));expect(results.every(r=>r.body.matched&&r.body.acknowledged)).toBe(true);
  const state=await proof(f);expect(state.notifications).toHaveLength(1);expect(state.notifications[0].status).toBe('POSTED');expect(state.notifications[0].journal_entry_id).toBe(state.providers[0].journal_entry_id);expect(state.movements).toHaveLength(1);const before=await proof(f);await webhook(body).expect(200);await webhook({...body,transactionReference:randomUUID()}).expect(409);expect(await proof(f)).toEqual(before);
 });
 it('notification persistence failure rolls back the entire callback; retry can safely finish',async()=>{
  const f=await fixture(),accountNumber=await f.va(),body={accountNumber,paymentReference:randomUUID(),transactionReference:randomUUID(),amountPaid:0.23,transactionStatus:'SUCCESSFUL'},before=await proof(f);
  await fault(f,'payment_notifications','INSERT','true',async()=>{await webhook(body).expect(500);expect(await proof(f)).toEqual(before);});
  await webhook(body).expect(200);const p=await proof(f);expect(p.notifications).toHaveLength(1);expect(p.providers).toHaveLength(1);expect(p.movements).toHaveLength(1);
 });
 it('direct share and loan matches preserve one projection and intent increment on retries',async()=>{
  const f=await fixture(4),id=await loan(f),si=await f.intent('SHARE_PURCHASE'),li=await f.intent('LOAN_REPAYMENT');
  for(const i of [si,li]){const body={providerReference:randomUUID(),amount:0.23,narration:i.reference};await Promise.all([f.record(body).expect(201),f.record(body).expect(201)]);}
  const p=await proof(f);expect(p.shares[0].current_balance).toBe('0.23');expect(p.shareMovements).toHaveLength(1);expect(p.loans.find(x=>x.id===id)?.outstanding_principal).toBe('0.93');expect(p.intents.every(i=>i.received_amount==='0.23')).toBe(true);
 });
 it('full-length references and equal references in separate tenants do not collide',async()=>{
  const a=await fixture(),b=await fixture(),ai=await a.intent(),bi=await b.intent(),prefix='R'.repeat(127);
  await a.record({providerReference:prefix+'1',amount:0.23,narration:ai.reference}).expect(201);await a.record({providerReference:prefix+'2',amount:0.23,narration:ai.reference}).expect(201);await b.record({providerReference:prefix+'1',amount:0.23,narration:bi.reference}).expect(201);
  expect((await proof(a)).savings[0].current_balance).toBe('0.46');expect((await proof(b)).savings[0].current_balance).toBe('0.23');const foreign=(await proof(a)).providers[0].id;await b.assign(foreign).expect(404);await expect(service.match(b.org,null,foreign)).rejects.toThrow('Transaction not found');
 });
 it('invalid allocation targets and contradictory virtual-account/intent routes leave money unchanged',async()=>{
  const f=await fixture(),other=await fixture(),p=await f.parked(),before=await proof(f);await f.assign(p.transactionId,other.members[0]).expect(404);await f.assign(p.transactionId,f.members[0],'LOAN_REPAYMENT').expect(409);expect(await proof(f)).toEqual(before);
  const accountNumber=await f.va(),i=await f.intent('SAVINGS_DEPOSIT',1,f.members[1]);const stable=await proof(f);await f.record({providerReference:randomUUID(),amount:0.23,virtualAccountNo:accountNumber,narration:i.reference}).expect(409);expect(await proof(f)).toEqual(stable);
 });
 it('historical partial postings fail closed instead of marking matched from an idempotency error',async()=>{
  const f=await fixture(),i=await f.intent(),reference=randomUUID();const account=(await request(app.getHttpServer()).post(`/api/v1/savings/member/${f.members[0]}/account`).set(f.auth).send({}).expect(201)).body.id;
  const actor=(await request(app.getHttpServer()).get('/api/v1/auth/me').set(f.auth).expect(200)).body.user.id;
  await app.get(SavingsService).deposit(f.org,actor,account,0.23,undefined,`pay:manual:${reference}`);
  const id=await f.tenant(async c=>(await c.query(`INSERT INTO provider_transactions (organization_id,provider_reference,amount,narration) VALUES ($1,$2,'0.23',$3) RETURNING id`,[f.org,reference,i.reference])).rows[0].id);
  const before=await proof(f);await expect(service.match(f.org,null,id)).rejects.toThrow(/Historical provider posting/);expect(await proof(f)).toEqual(before);
 });
 it('assignment receipt completion failure rolls back both entries and can retry with the same target',async()=>{
  const f=await fixture(),p=await f.parked(),before=await proof(f);
  await fault(f,'financial_write_receipts','UPDATE',"NEW.action='provider.assign' AND NEW.completed_at IS NOT NULL",async()=>{await f.assign(p.transactionId).expect(500);expect(await proof(f)).toEqual(before);});
  await f.assign(p.transactionId).expect(200);expect((await proof(f)).movements).toHaveLength(1);
 });
 it('closed periods block new postings but do not invalidate a completed allocation retry',async()=>{
  const f=await fixture(),p=await f.parked();const original=(await f.assign(p.transactionId).expect(200)).body;
  await f.tenant(c=>c.query("UPDATE ledger_periods SET status='SOFT_CLOSED' WHERE status='OPEN'"));
  const before=await proof(f);expect((await f.assign(p.transactionId).expect(200)).body).toEqual(original);
  await f.record({providerReference:randomUUID(),amount:0.23,narration:'unknown'}).expect(409);expect(await proof(f)).toEqual(before);
 });

});
