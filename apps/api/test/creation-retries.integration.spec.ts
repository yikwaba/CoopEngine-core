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

describe('loan and journal creation receipts (PostgreSQL)',()=>{
 let app:INestApplication,pool:Pool,platform:string;
 beforeAll(async()=>{
  process.env.DATABASE_URL=TEST_DATABASE_URL;pool=new Pool({connectionString:TEST_DATABASE_URL});await ensureRbacSeeded(pool);
  const module=await Test.createTestingModule({imports:[AppModule]}).compile();app=module.createNestApplication();app.setGlobalPrefix('api/v1');app.useGlobalPipes(new ValidationPipe({whitelist:true,transform:true,forbidNonWhitelisted:true}));await app.init();
  platform=(await request(app.getHttpServer()).post('/api/v1/auth/login').send({email:'admin@coopengine.dev',password:ADMIN_PASSWORD}).expect(200)).body.tokens.accessToken;
 });
 afterAll(async()=>{await app?.close();await pool?.end();});
 async function fixture(count=3){
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
  const actor=(await request(app.getHttpServer()).get('/api/v1/auth/me').set(auth).expect(200)).body.user.id as string;
  const key=randomUUID(),date=new Date().toISOString().slice(0,10);
  const account=(await request(app.getHttpServer()).post(`/api/v1/savings/member/${members[0]!.id}/account`).set(auth).send({}).expect(201)).body.id;
  await request(app.getHttpServer()).post(`/api/v1/savings/accounts/${account}/deposits`).set(auth).send({idempotencyKey:randomUUID(),amount:1.15}).expect(201);
  const product=(await tenant(async c=>(await c.query("SELECT id FROM loan_products WHERE status='ACTIVE' ORDER BY code LIMIT 1")).rows[0].id)) as string;
  const loanBody={idempotencyKey:key,memberId:members[0]!.id,productId:product,principal:1.15,termMonths:5,guarantorIds:members.slice(1).map(m=>m.id)};
  const journalBody={idempotencyKey:key,entryDate:date,description:'Synthetic draft',lines:[{accountCode:'5010',debit:0.23,memo:'Original memo'},{accountCode:'1000',credit:0.23}]};
  const send=(path:string,body:unknown,headers=auth)=>request(app.getHttpServer()).post('/api/v1'+path).set(headers).send(body);
  const snapshot=()=>tenant(async c=>{const result:Record<string,unknown>={};for(const table of ['loans','loan_guarantors','loan_repayments','financial_write_receipts','audit_logs','journal_entries','journal_lines','member_savings_accounts','savings_transactions','org_counters'])result[table]=(await c.query(`SELECT * FROM ${table} WHERE organization_id=$1 ORDER BY ${table==='org_counters'?'organization_id':'id'}`,[org])).rows;return result;});
  return{org,auth,checker,members,tenant,actor,key,loanBody,journalBody,send,snapshot};
 }

 for(const kind of ['loan','journal'] as const){
  const path=kind==='loan'?'/loans':'/ledger/journals',action=kind==='loan'?'loans.apply':'ledger.create';
  const body=(f:Awaited<ReturnType<typeof fixture>>)=>kind==='loan'?f.loanBody:f.journalBody;
  it(`${kind}: concurrent creation replays one original response and no money`,async()=>{const f=await fixture(),before=await f.snapshot(),responses=await Promise.all([f.send(path,body(f)).expect(201),f.send(path,body(f)).expect(201)]);expect(responses[0].body).toEqual(responses[1].body);const s=await f.snapshot();expect((s.financial_write_receipts as {action:string}[]).filter(r=>r.action===action)).toHaveLength(1);if(kind==='loan'){expect(s.loans).toHaveLength(1);expect(s.loan_guarantors).toHaveLength(2);expect((s.audit_logs as {action:string}[]).filter(a=>a.action==='loan.applied')).toHaveLength(1);}else{expect((s.journal_entries as {source:string}[]).filter(j=>j.source==='MANUAL')).toHaveLength(1);expect((s.journal_lines as unknown[]).length).toBe((before.journal_lines as unknown[]).length+2);}for(const table of ['member_savings_accounts','savings_transactions','org_counters','loan_repayments'])expect(s[table]).toEqual(before[table]);await f.send(path,body(f)).expect(201);expect(await f.snapshot()).toEqual(s);});
  it(`${kind}: changed actor and details conflict without mutations`,async()=>{const f=await fixture(),b=body(f);await f.send(path,b).expect(201);const s=await f.snapshot();await f.send(path,b,f.checker).expect(409);await f.send(path,{...b,...(kind==='loan'?{principal:1.16}:{description:'Changed description'})}).expect(409);expect(await f.snapshot()).toEqual(s);});
  it(`${kind}: missing invalid reserved keys are refused`,async()=>{const f=await fixture(),s=await f.snapshot();for(const idempotencyKey of [undefined,null,'short',' '.repeat(20),'pay:'+randomUUID(),'withdrawal-request:'+randomUUID()])await f.send(path,{...body(f),idempotencyKey}).expect(400);expect(await f.snapshot()).toEqual(s);});
  it(`${kind}: current grants and scope gate completed replay`,async()=>{const f=await fixture();await f.send(path,body(f)).expect(201);let s=await f.snapshot();await f.send(path,body(f)).set('X-CoopEngine-Financial-Scope',`${randomUUID()}:${f.actor}`).expect(409);expect(await f.snapshot()).toEqual(s);await pool.query('DELETE FROM user_roles WHERE user_id=$1',[f.actor]);s=await f.snapshot();await f.send(path,body(f)).expect(401);expect(await f.snapshot()).toEqual(s);});
  it(`${kind}: validation failure releases the key for corrected input`,async()=>{const f=await fixture(),s=await f.snapshot();const invalid=kind==='loan'?{...f.loanBody,principal:100}:{...f.journalBody,lines:[{accountCode:'1000',debit:0.23},{accountCode:'5010',credit:0.22}]};await f.send(path,invalid).expect(400);expect(await f.snapshot()).toEqual(s);await f.send(path,body(f)).expect(201);});
  it(`${kind}: receipt finalization failure rolls back all creation effects`,async()=>{const f=await fixture(),s=await f.snapshot();await pool.query(`CREATE FUNCTION creation_test_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='${action}' AND NEW.response IS NOT NULL AND NEW.organization_id='${f.org}'::uuid THEN RAISE EXCEPTION 'synthetic creation receipt failure'; END IF; RETURN NEW; END; $$`);await pool.query('CREATE TRIGGER creation_test_fault BEFORE UPDATE ON financial_write_receipts FOR EACH ROW EXECUTE FUNCTION creation_test_fault()');try{await f.send(path,body(f)).expect(500);expect(await f.snapshot()).toEqual(s);}finally{await pool.query('DROP TRIGGER creation_test_fault ON financial_write_receipts');await pool.query('DROP FUNCTION creation_test_fault()');}await f.send(path,body(f)).expect(201);});
  it(`${kind}: new key intentionally creates a separate record`,async()=>{const f=await fixture(),a=(await f.send(path,body(f)).expect(201)).body,b=(await f.send(path,{...body(f),idempotencyKey:randomUUID()}).expect(201)).body;expect(a.id).not.toBe(b.id);});
  it(`${kind}: same key is isolated across tenants`,async()=>{const f=await fixture(),g=await fixture(),a=(await f.send(path,body(f)).expect(201)).body,b=(await g.send(path,{...body(g),idempotencyKey:f.key}).expect(201)).body;expect(a.id).not.toBe(b.id);});
 }
 it('loan: replay after rejection and changed eligibility retains original PENDING acknowledgement',async()=>{const f=await fixture(),a=(await f.send('/loans',f.loanBody).expect(201)).body;await f.send(`/loans/${a.id}/reject`,{reason:'Synthetic reject'},f.checker).expect(200);await f.tenant(c=>c.query("UPDATE members SET status='EXITED' WHERE id=$1",[f.members[0]!.id]));const s=await f.snapshot();expect((await f.send('/loans',f.loanBody).expect(201)).body).toEqual(a);expect(await f.snapshot()).toEqual(s);expect((s.loans as {status:string}[])[0].status).toBe('REJECTED');});
 it('loan: changed guarantors or term cannot reuse original creation key',async()=>{const f=await fixture();await f.send('/loans',f.loanBody).expect(201);const s=await f.snapshot();await f.send('/loans',{...f.loanBody,termMonths:6}).expect(409);await f.send('/loans',{...f.loanBody,guarantorIds:[...f.loanBody.guarantorIds].reverse()}).expect(409);expect(await f.snapshot()).toEqual(s);});
 it('journal: replay after submit posting reversal and period closure preserves original DRAFT',async()=>{const f=await fixture(),a=(await f.send('/ledger/journals',f.journalBody).expect(201)).body;await f.send(`/ledger/journals/${a.id}/submit`,{}).expect(200);await f.send(`/ledger/journals/${a.id}/approve-post`,{},f.checker).expect(200);await f.send(`/ledger/journals/${a.id}/reverse`,{reason:'Synthetic reverse'}).expect(200);await f.tenant(c=>c.query("UPDATE ledger_periods SET status='LOCKED'"));const s=await f.snapshot();expect((await f.send('/ledger/journals',f.journalBody).expect(201)).body).toEqual(a);expect(await f.snapshot()).toEqual(s);});
 it('journal: memo member account and line amount changes cannot reuse the key',async()=>{const f=await fixture();await f.send('/ledger/journals',f.journalBody).expect(201);const s=await f.snapshot();for(const change of [{memo:'Changed'},{memberId:f.members[1]!.id},{accountCode:'1000'},{debit:0.24}])await f.send('/ledger/journals',{...f.journalBody,lines:[{...f.journalBody.lines[0],...change},f.journalBody.lines[1]]}).expect(409);expect(await f.snapshot()).toEqual(s);});
 it('journal: foreign and unknown members roll back; own member association succeeds',async()=>{
  const f=await fixture(),other=await fixture(),before=await f.snapshot();
  for(const memberId of [other.members[0]!.id,randomUUID()]){
   const rejected=await f.send('/ledger/journals',{...f.journalBody,lines:[{...f.journalBody.lines[0],memberId},f.journalBody.lines[1]]}).expect(400);
   expect(rejected.body.message).toBe('Journal members must belong to this cooperative');
   expect(await f.snapshot()).toEqual(before);
  }
  const own={...f.journalBody,lines:[{...f.journalBody.lines[0],memberId:f.members[0]!.id},f.journalBody.lines[1]]};
  const result=(await f.send('/ledger/journals',own).expect(201)).body;
  expect((await f.tenant(c=>c.query('SELECT member_id FROM journal_lines WHERE journal_entry_id=$1 AND debit>0',[result.id]))).rows[0].member_id).toBe(f.members[0]!.id);
  const committed=await f.snapshot();expect((await f.send('/ledger/journals',own).expect(201)).body).toEqual(result);expect(await f.snapshot()).toEqual(committed);
 });
 it('same key remains isolated between loan and journal creation actions',async()=>{const f=await fixture();await f.send('/loans',f.loanBody).expect(201);await f.send('/ledger/journals',f.journalBody).expect(201);});
 it.each(['loan','journal'])('%s: incomplete creation receipt requires reconciliation',async kind=>{const f=await fixture();const {createHash}=await import('node:crypto');const payload=kind==='loan'?{actorUserId:f.actor,memberId:f.loanBody.memberId,productId:f.loanBody.productId,principal:f.loanBody.principal,termMonths:f.loanBody.termMonths,guarantorIds:f.loanBody.guarantorIds}:{actorUserId:f.actor,entryDate:f.journalBody.entryDate,description:f.journalBody.description,lines:f.journalBody.lines.map(line=>({accountCode:line.accountCode,debit:line.debit??0,credit:line.credit??0,memo:line.memo??null,memberId:null}))};const fingerprint=createHash('sha256').update(JSON.stringify(payload)).digest('hex');await f.tenant(c=>c.query('INSERT INTO financial_write_receipts(organization_id,action,intent_key,fingerprint) VALUES ($1,$2,$3,$4)',[f.org,kind==='loan'?'loans.apply':'ledger.create',f.key,fingerprint]));const s=await f.snapshot();await f.send(kind==='loan'?'/loans':'/ledger/journals',kind==='loan'?f.loanBody:f.journalBody).expect(409);expect(await f.snapshot()).toEqual(s);});
 it('journal: historical raw journal key without a creation receipt fails closed',async()=>{const f=await fixture();await f.tenant(c=>c.query("INSERT INTO journal_entries(id,organization_id,period_id,entry_date,description,source,status,idempotency_key,created_by) SELECT $1,$2,id,$3,'Historical synthetic draft','MANUAL','DRAFT',$4,$5 FROM ledger_periods WHERE organization_id=$2 AND $3::date BETWEEN start_date AND end_date LIMIT 1",[randomUUID(),f.org,f.journalBody.entryDate,f.key,f.actor]));const s=await f.snapshot();await f.send('/ledger/journals',f.journalBody).expect(409);expect(await f.snapshot()).toEqual(s);});

});
