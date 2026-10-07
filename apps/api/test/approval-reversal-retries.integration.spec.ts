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

describe('approval and reversal retry receipts (PostgreSQL)',()=>{
 let app:INestApplication,pool:Pool,platform:string;
 beforeAll(async()=>{
  process.env.DATABASE_URL=TEST_DATABASE_URL;pool=new Pool({connectionString:TEST_DATABASE_URL});await ensureRbacSeeded(pool);
  const module=await Test.createTestingModule({imports:[AppModule]}).compile();app=module.createNestApplication();app.setGlobalPrefix('api/v1');app.useGlobalPipes(new ValidationPipe({whitelist:true,transform:true,forbidNonWhitelisted:true}));await app.init();
  platform=(await request(app.getHttpServer()).post('/api/v1/auth/login').send({email:'admin@coopengine.dev',password:ADMIN_PASSWORD}).expect(200)).body.tokens.accessToken;
 });
 afterAll(async()=>{await app?.close();await pool?.end();});
 async function fixture(count=2){
  const suffix=randomUUID().slice(0,8),email=`retry-decisions-${suffix}@approval-retry.invalid`;
  const org=(await request(app.getHttpServer()).post('/api/v1/organizations').set('Authorization',`Bearer ${platform}`).send({name:`Exact payroll ${suffix}`,slug:`retry-decisions-${suffix}`,adminEmail:email,adminPassword:'ExactPayrollPass123!'}).expect(201)).body.id;
  const token=(await request(app.getHttpServer()).post('/api/v1/auth/login').send({email,password:'ExactPayrollPass123!'}).expect(200)).body.tokens.accessToken;
  const auth={Authorization:`Bearer ${token}`};
  const invited=(await request(app.getHttpServer()).post('/api/v1/users').set(auth).send({email:`checker-${suffix}@approval-retry.invalid`,roleCodes:['COOP_ADMIN']}).expect(201)).body;
  const checkerToken=(await request(app.getHttpServer()).post('/api/v1/auth/login').send({email:invited.email,password:invited.tempPassword}).expect(200)).body.tokens.accessToken;
  const checker={Authorization:`Bearer ${checkerToken}`},members:{id:string;memberNo:number}[]=[];
  for(let i=0;i<count;i++){
   const member=(await request(app.getHttpServer()).post('/api/v1/members').set(auth).send({firstName:`Exact ${i}`,lastName:'Synthetic'}).expect(201)).body;
   await request(app.getHttpServer()).post(`/api/v1/members/${member.id}/approve`).set(auth).expect(200);members.push({id:member.id,memberNo:member.memberNo});
  }
  const tenant=<T>(fn:Parameters<typeof withTenant<T>>[2])=>withTenant(pool,org,fn);
  const preview=(csv:string)=>request(app.getHttpServer()).post('/api/v1/payroll/import/preview').set(auth).send({idempotencyKey:randomUUID(),filename:'atomic-payroll.csv',csv});
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

 const post=(f:Awaited<ReturnType<typeof fixture>>,path:string,body:unknown={},checker=false)=>request(app.getHttpServer()).post('/api/v1'+path).set(checker?f.checker:f.auth).send(body);
 async function state(f:Awaited<ReturnType<typeof fixture>>){return f.tenant(async c=>{
  const result:Record<string,unknown>={};
  for(const table of ['payroll_batches','journal_entries','journal_lines','member_savings_accounts','savings_transactions','savings_withdrawal_requests','approval_requests','approval_steps','approval_actions','audit_logs','org_counters','financial_write_receipts'])
   result[table]=(await c.query(`SELECT * FROM ${table} WHERE organization_id=$1 ORDER BY ${table==='org_counters'?'organization_id':'id'}`,[f.org])).rows;
  return result;
 });}
 async function failReceipt(f:Awaited<ReturnType<typeof fixture>>,action:string,run:()=>Promise<void>){
  await pool.query(`CREATE FUNCTION retry_test_fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.response IS NOT NULL AND NEW.action='${action}' AND NEW.organization_id='${f.org}'::uuid THEN RAISE EXCEPTION 'synthetic receipt finalization failure'; END IF; RETURN NEW; END; $$`);
  await pool.query('CREATE TRIGGER retry_test_fail_receipt BEFORE UPDATE ON financial_write_receipts FOR EACH ROW EXECUTE FUNCTION retry_test_fail_receipt()');
  try{await run();}finally{await pool.query('DROP TRIGGER retry_test_fail_receipt ON financial_write_receipts');await pool.query('DROP FUNCTION retry_test_fail_receipt()');}
 }
 async function journal(f:Awaited<ReturnType<typeof fixture>>){
  const id=(await post(f,'/ledger/journals',{entryDate:new Date().toISOString().slice(0,10),description:'Synthetic recovery expense',lines:[{accountCode:'5010',debit:0.23},{accountCode:'1000',credit:0.23}]}).expect(201)).body.id;
  await post(f,`/ledger/journals/${id}/submit`).expect(200);return id as string;
 }
 async function withdrawal(stepped=false){
  const f=await fixture(1),account=(await post(f,`/savings/member/${f.members[0]!.id}/account`).expect(201)).body.id;
  await post(f,`/savings/accounts/${account}/deposits`,{idempotencyKey:randomUUID(),amount:1.15}).expect(201);
  await request(app.getHttpServer()).patch('/api/v1/savings/settings/withdrawal-approval').set(f.auth).send({threshold:0}).expect(200);
  if(stepped)await f.tenant(async c=>{
   const policy=(await c.query("INSERT INTO approval_policies (organization_id,kind,min_amount,max_amount,version,description) VALUES ($1,'WITHDRAWAL',0,NULL,1,'Synthetic same checker chain') RETURNING id",[f.org])).rows[0].id;
   await c.query("INSERT INTO approval_policy_steps (organization_id,policy_id,step_no,approver_role_code) VALUES ($1,$2,1,'COOP_ADMIN'),($1,$2,2,'COOP_ADMIN')",[f.org,policy]);
  });
  const id=(await post(f,`/savings/accounts/${account}/withdrawals`,{idempotencyKey:randomUUID(),amount:0.23}).expect(200)).body.requestId as string;
  return {f,account,id};
 }
 it('payroll approval aliases replay the original result even after reversal',async()=>{
  const f=await fixture(1),id=await f.staged(['0.23']);const results=await Promise.all([post(f,`/payroll/batches/${id}/approve`,{},true).expect(200),post(f,`/approvals/payroll/${id}/approve`,{},true).expect(200)]);expect(results[0].body).toEqual(results[1].body);expect((await f.proof(id)).journal.entries).toBe(1);
  await post(f,`/payroll/batches/${id}/reverse`,{reason:'Synthetic correction'}).expect(200);const before=await state(f);expect((await f.approve(id).expect(200)).body).toEqual(results[0].body);expect(await state(f)).toEqual(before);
 });
 it('payroll approval receipt failure rolls back balances, journal, batch, counters and audit',async()=>{
  const f=await fixture(1),id=await f.staged(['0.23']),before=await state(f);await failReceipt(f,'payroll.approve',async()=>{await f.approve(id).expect(500);expect(await state(f)).toEqual(before);});await f.approve(id).expect(200);expect((await f.proof(id)).journal.entries).toBe(1);
 });
 it('payroll rejection aliases replay once and changed reasons conflict',async()=>{
  const f=await fixture(1),id=await f.staged(['0.23']);const responses=await Promise.all([post(f,`/payroll/batches/${id}/reject`,{reason:'Missing minutes'},true).expect(200),post(f,`/approvals/payroll/${id}/reject`,{reason:'Missing minutes'},true).expect(200)]);expect(responses[0].body).toEqual(responses[1].body);const before=await state(f);await post(f,`/payroll/batches/${id}/reject`,{reason:'Different reason'},true).expect(409);await f.approve(id).expect(409);expect(await state(f)).toEqual(before);
 });
 it('opposite payroll decisions cannot both commit',async()=>{
  const f=await fixture(1),id=await f.staged(['0.23']);const responses=await Promise.all([f.approve(id),post(f,`/payroll/batches/${id}/reject`,{reason:'Reject'},true)]);expect(responses.map(r=>r.status).sort()).toEqual([200,409]);const proof=await f.proof(id);expect(proof.journal.entries).toBe(proof.batch.status==='POSTED'?1:0);
 });
 it('payroll reversal rejects changed reason or actor and replays after period closure',async()=>{
  const f=await fixture(1),id=await f.staged(['0.23']);await f.approve(id).expect(200);const path=`/payroll/batches/${id}/reverse`,body={reason:'Correction'};const first=await post(f,path,body).expect(200);await f.tenant(c=>c.query("UPDATE ledger_periods SET status='CLOSED'"));const before=await state(f);expect((await post(f,path,body).expect(200)).body).toEqual(first.body);await post(f,path,{reason:'Changed'}).expect(409);await post(f,path,body,true).expect(409);expect(await state(f)).toEqual(before);
 });
 it('payroll reversal receipt finalization failure rolls back everything and can retry',async()=>{
  const f=await fixture(1),id=await f.staged(['0.23']);await f.approve(id).expect(200);const before=await state(f),path=`/payroll/batches/${id}/reverse`,body={reason:'Correction'};await failReceipt(f,'payroll.reverse',async()=>{await post(f,path,body).expect(500);expect(await state(f)).toEqual(before);});await post(f,path,body).expect(200);
 });
 it('journal approval aliases serialize and replay the posted snapshot after reversal',async()=>{
  const f=await fixture(1),id=await journal(f);const results=await Promise.all([post(f,`/ledger/journals/${id}/approve-post`,{},true).expect(200),post(f,`/approvals/journals/${id}/approve`,{},true).expect(200)]);expect(results[0].body).toEqual(results[1].body.journal);await post(f,`/ledger/journals/${id}/reverse`,{reason:'Correction'}).expect(200);const before=await state(f);expect((await post(f,`/ledger/journals/${id}/approve-post`,{},true).expect(200)).body).toEqual(results[0].body);expect(await state(f)).toEqual(before);
 });
 it('journal approval receipt failure leaves the entry submitted and counter unchanged',async()=>{
  const f=await fixture(1),id=await journal(f),before=await state(f);await failReceipt(f,'ledger.approve',async()=>{await post(f,`/ledger/journals/${id}/approve-post`).expect(500);expect(await state(f)).toEqual(before);});await post(f,`/ledger/journals/${id}/approve-post`).expect(200);
 });
 it('journal reversal duplicates return one correction; changed details conflict',async()=>{
  const f=await fixture(1),id=await journal(f);await post(f,`/ledger/journals/${id}/approve-post`).expect(200);const path=`/ledger/journals/${id}/reverse`,body={reason:'Correction'};const responses=await Promise.all([post(f,path,body).expect(200),post(f,path,body).expect(200)]);expect(responses[0].body).toEqual(responses[1].body);const before=await state(f);await post(f,path,{reason:'Changed'}).expect(409);await post(f,path,body,true).expect(409);expect(await state(f)).toEqual(before);
 });
 it('journal reversal receipt failure rolls back journal, counter and audits',async()=>{
  const f=await fixture(1),id=await journal(f);await post(f,`/ledger/journals/${id}/approve-post`).expect(200);const before=await state(f),path=`/ledger/journals/${id}/reverse`,body={reason:'Correction'};await failReceipt(f,'ledger.reverse',async()=>{await post(f,path,body).expect(500);expect(await state(f)).toEqual(before);});await post(f,path,body).expect(200);
 });
 it('legacy withdrawal concurrent approval has one payout and replays the original balance',async()=>{
  const {f,id,account}=await withdrawal(),path=`/savings/withdrawals/${id}/approve`;const results=await Promise.all([post(f,path,{},true).expect(200),post(f,path,{},true).expect(200)]);expect(results[0].body).toEqual(results[1].body);await post(f,`/savings/accounts/${account}/deposits`,{idempotencyKey:randomUUID(),amount:0.01}).expect(201);const before=await state(f);expect((await post(f,path,{},true).expect(200)).body).toEqual(results[0].body);expect(await state(f)).toEqual(before);
  expect(await f.tenant(async c=>(await c.query("SELECT count(*)::int AS n FROM savings_transactions WHERE type='WITHDRAWAL'")).rows[0].n)).toBe(1);
 });
 it('withdrawal rejection retries preserve one outcome and refuse changed notes',async()=>{
  const {f,id}=await withdrawal(),path=`/savings/withdrawals/${id}/reject`,body={notes:'Missing minutes'};const results=await Promise.all([post(f,path,body,true).expect(200),post(f,path,body,true).expect(200)]);expect(results[0].body).toEqual(results[1].body);const before=await state(f);await post(f,path,{notes:'Changed'},true).expect(409);await post(f,`/savings/withdrawals/${id}/approve`,{},true).expect(409);expect(await state(f)).toEqual(before);
 });
 it('explicit step retries cannot advance the same checker to the next step',async()=>{
  const {f,id}=await withdrawal(true),path=`/savings/withdrawals/${id}/approve`;const responses=await Promise.all([post(f,path,{expectedStepNo:1},true).expect(200),post(f,path,{expectedStepNo:1},true).expect(200)]);expect(responses[0].body).toEqual(responses[1].body);expect(responses[0].body.approvalStatus).toBe('PENDING');expect((await post(f,path,{expectedStepNo:1},true).expect(200)).body).toEqual(responses[0].body);
  const final=await post(f,path,{expectedStepNo:2},true).expect(200);expect(final.body.approvalStatus).toBe('APPROVED');const before=await state(f);expect((await post(f,path,{expectedStepNo:1},true).expect(200)).body).toEqual(responses[0].body);expect((await post(f,path,{expectedStepNo:2},true).expect(200)).body).toEqual(final.body);expect(await state(f)).toEqual(before);
 });
 it('legacy unkeyed approval retries remain bound to the first decision',async()=>{
  const {f,id}=await withdrawal(true),path=`/savings/withdrawals/${id}/approve`;const first=await post(f,path,{},true).expect(200);expect(first.body.approvalStatus).toBe('PENDING');expect((await post(f,path,{},true).expect(200)).body).toEqual(first.body);expect((await post(f,path,{expectedStepNo:2},true).expect(200)).body.approvalStatus).toBe('APPROVED');
 });
 it('final withdrawal receipt failure rolls back the final step and payout together',async()=>{
  const {f,id}=await withdrawal(true),path=`/savings/withdrawals/${id}/approve`;await post(f,path,{expectedStepNo:1},true).expect(200);const before=await state(f);await failReceipt(f,'withdrawals.decision',async()=>{await post(f,path,{expectedStepNo:2},true).expect(500);expect(await state(f)).toEqual(before);});expect((await post(f,path,{expectedStepNo:2},true).expect(200)).body.approvalStatus).toBe('APPROVED');
 });
 it('generic decisions also bind retries to a step and refuse changed decisions',async()=>{
  const {f,id}=await withdrawal(true),engine=await f.tenant(async c=>(await c.query('SELECT id FROM approval_requests WHERE entity_id=$1',[id])).rows[0].id),path=`/approvals/requests/${engine}/decisions`,body={decision:'APPROVE',expectedStepNo:1};const responses=await Promise.all([post(f,path,body,true).expect(200),post(f,path,body,true).expect(200)]);expect(responses[0].body).toEqual(responses[1].body);const before=await state(f);await post(f,path,{decision:'REJECT',expectedStepNo:1},true).expect(409);await post(f,path,{decision:'APPROVE',expectedStepNo:3},true).expect(409);expect(await state(f)).toEqual(before);expect((await post(f,path,{decision:'APPROVE',expectedStepNo:2},true).expect(200)).body.status).toBe('APPROVED');
 });
 it('opposite withdrawal decisions cannot both commit or pay twice',async()=>{
  const {f,id}=await withdrawal();const responses=await Promise.all([post(f,`/savings/withdrawals/${id}/approve`,{},true),post(f,`/savings/withdrawals/${id}/reject`,{notes:'Reject'},true)]);expect(responses.map(r=>r.status).sort()).toEqual([200,409]);
 });
 it('maker and cross-tenant guesses never claim a completed approval receipt',async()=>{
  const {f,id}=await withdrawal(true),before=await state(f);await post(f,`/savings/withdrawals/${id}/approve`,{expectedStepNo:1}).expect(409);const other=await fixture(1);await post(other,`/savings/withdrawals/${id}/approve`,{expectedStepNo:1},true).expect(404);expect(await state(f)).toEqual(before);
 });
 async function loan(){
  const f=await fixture(4),account=(await post(f,`/savings/member/${f.members[0]!.id}/account`).expect(201)).body.id;
  await post(f,`/savings/accounts/${account}/deposits`,{idempotencyKey:randomUUID(),amount:1000}).expect(201);
  const product=(await request(app.getHttpServer()).get('/api/v1/loans/products').set(f.auth).expect(200)).body.find((p:{code:string})=>p.code==='CASH-LOAN').id;
  await f.tenant(c=>c.query('UPDATE loan_products SET interest_rate_pa=0 WHERE id=$1',[product]));
  const id=(await post(f,'/loans',{memberId:f.members[0]!.id,productId:product,principal:1.15,termMonths:5,guarantorIds:f.members.slice(1).map(m=>m.id)}).expect(201)).body.id;
  return {f,id};
 }
 async function loanState(f:Awaited<ReturnType<typeof fixture>>){return {...await state(f),loan:await f.tenant(async c=>({loans:(await c.query('SELECT * FROM loans ORDER BY id')).rows,schedule:(await c.query('SELECT * FROM loan_repayments ORDER BY id')).rows,notifications:(await c.query('SELECT * FROM notifications ORDER BY id')).rows}))};}
 it('loan approval and disbursement retries return their original snapshots after repayment',async()=>{
  const {f,id}=await loan(),approve=`/loans/${id}/approve`,disburse=`/loans/${id}/disburse`;const approved=await post(f,approve).expect(200),results=await Promise.all([post(f,disburse).expect(200),post(f,disburse).expect(200)]);expect(results[0].body).toEqual(results[1].body);
  await post(f,`/loans/${id}/repayments`,{amount:1.15,idempotencyKey:randomUUID()}).expect(200);const before=await loanState(f);expect((await post(f,approve).expect(200)).body).toEqual(approved.body);expect((await post(f,disburse).expect(200)).body).toEqual(results[0].body);expect(await loanState(f)).toEqual(before);
 });
 it('loan disbursement receipt failure rolls back schedule, journal, notification and loan',async()=>{
  const {f,id}=await loan();await post(f,`/loans/${id}/approve`).expect(200);const before=await loanState(f);await failReceipt(f,'loans.disbursed',async()=>{await post(f,`/loans/${id}/disburse`).expect(500);expect(await loanState(f)).toEqual(before);});await post(f,`/loans/${id}/disburse`).expect(200);
 });
 it('loan rejection retries return one outcome and reject changed reason or actor',async()=>{
  const {f,id}=await loan(),path=`/loans/${id}/reject`,body={reason:'Missing documentation'};const results=await Promise.all([post(f,path,body).expect(200),post(f,path,body).expect(200)]);expect(results[0].body).toEqual(results[1].body);const before=await loanState(f);await post(f,path,{reason:'Changed'}).expect(409);await post(f,path,body,true).expect(409);expect(await loanState(f)).toEqual(before);
 });

});
