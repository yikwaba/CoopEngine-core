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

describe('atomic payroll reversal (PostgreSQL)',()=>{
 let app:INestApplication,pool:Pool,platform:string;
 beforeAll(async()=>{
  process.env.DATABASE_URL=TEST_DATABASE_URL;pool=new Pool({connectionString:TEST_DATABASE_URL});await ensureRbacSeeded(pool);
  const module=await Test.createTestingModule({imports:[AppModule]}).compile();app=module.createNestApplication();app.setGlobalPrefix('api/v1');app.useGlobalPipes(new ValidationPipe({whitelist:true,transform:true,forbidNonWhitelisted:true}));await app.init();
  platform=(await request(app.getHttpServer()).post('/api/v1/auth/login').send({email:'admin@coopengine.dev',password:ADMIN_PASSWORD}).expect(200)).body.tokens.accessToken;
 });
 afterAll(async()=>{await app?.close();await pool?.end();});
 async function fixture(count=2){
  const suffix=randomUUID().slice(0,8),email=`atomic-payroll-${suffix}@coopengine.test`;
  const org=(await request(app.getHttpServer()).post('/api/v1/organizations').set('Authorization',`Bearer ${platform}`).send({name:`Exact payroll ${suffix}`,slug:`atomic-payroll-${suffix}`,adminEmail:email,adminPassword:'ExactPayrollPass123!'}).expect(201)).body.id;
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
  const preview=(csv:string)=>request(app.getHttpServer()).post('/api/v1/payroll/import/preview').set(auth).send({filename:'atomic-payroll.csv',csv});
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
 const reverse=(f:Awaited<ReturnType<typeof fixture>>,id:string)=>request(app.getHttpServer()).post(`/api/v1/payroll/batches/${id}/reverse`).set(f.auth).send({reason:'Synthetic payroll correction'});
 async function snapshot(f:Awaited<ReturnType<typeof fixture>>){return f.tenant(async c=>{
  const result:Record<string,unknown>={};
  for(const table of ['payroll_batches','journal_entries','journal_lines','member_savings_accounts','savings_transactions','audit_logs','org_counters']){
   result[table]=(await c.query(`SELECT * FROM ${table} WHERE organization_id=$1 ORDER BY ${table==='org_counters'?'organization_id':'id'}`,[f.org])).rows;
  }
  return result;
 });}
 async function posted(amounts=['0.23','1.15']){const f=await fixture(amounts.length),id=await f.staged(amounts);await f.approve(id).expect(200);return{f,id};}
 async function net(f:Awaited<ReturnType<typeof fixture>>){return f.tenant(async c=>({
  accounts:(await c.query('SELECT current_balance FROM member_savings_accounts ORDER BY id')).rows,
  movements:(await c.query('SELECT sum(signed_amount)::text AS total FROM savings_transactions')).rows[0].total,
  members:(await c.query(`SELECT member_id,sum(credit-debit)::text AS net FROM journal_lines jl JOIN chart_of_accounts coa ON coa.id=jl.account_id WHERE coa.code='2000' GROUP BY member_id ORDER BY member_id`)).rows,
  reversals:(await c.query("SELECT id,reversal_of_entry_id FROM journal_entries WHERE source='REVERSAL' ORDER BY id")).rows,
 }));}
 it('reverses exact balances, linked member liabilities and posted movements together',async()=>{
  const {f,id}=await posted();await reverse(f,id).expect(200);const p=await net(f);expect(p.accounts.every(a=>a.current_balance==='0.00')).toBe(true);expect(p.movements).toBe('0.00');expect(p.members).toHaveLength(2);expect(p.members.every(m=>m.net==='0.00')).toBe(true);expect(p.reversals).toHaveLength(1);expect((await f.proof(id)).batch.status).toBe('REVERSED');
  const pairs=await f.tenant(async c=>(await c.query(`SELECT st.journal_entry_id,je.reversal_of_entry_id FROM savings_transactions st JOIN journal_entries je ON je.id=st.journal_entry_id WHERE st.type='WITHDRAWAL'`)).rows);expect(pairs).toHaveLength(2);for(const pair of pairs){expect(pair.journal_entry_id).toBe(p.reversals[0].id);expect(pair.reversal_of_entry_id).toBe(p.reversals[0].reversal_of_entry_id);}
 });
 it('uses actual credits after an inactive skip, ignoring the larger preview and stale rows',async()=>{
  const f=await fixture(),id=await f.staged(['0.23','1.15']);await f.tenant(c=>c.query("UPDATE members SET status='EXITED' WHERE id=$1",[f.members[1]!.id]));await f.approve(id).expect(200);
  await f.tenant(c=>c.query('UPDATE payroll_batches SET rows=$1::jsonb WHERE id=$2',[JSON.stringify(f.members.map(m=>({memberId:m.id,memberNo:m.memberNo,amount:999}))),id]));await reverse(f,id).expect(200);const p=await net(f);expect(p.accounts).toHaveLength(1);expect(p.accounts[0].current_balance).toBe('0.00');expect(p.movements).toBe('0.00');
 });
 it('debits the posted account even when another product account is older',async()=>{
  const {f,id}=await posted(['0.23']);await f.tenant(async c=>{
   const product=(await c.query("INSERT INTO savings_products (organization_id,code,name) VALUES ($1,'OTHER','Synthetic other savings') RETURNING id",[f.org])).rows[0].id;
   await c.query("INSERT INTO member_savings_accounts (organization_id,member_id,product_id,account_no,current_balance,opened_at) VALUES ($1,$2,$3,9999,'7.00','2000-01-01')",[f.org,f.members[0]!.id,product]);
  });await reverse(f,id).expect(200);expect((await net(f)).accounts.map(a=>a.current_balance).sort()).toEqual(['0.00','7.00']);
 });
 it('preserves a one-kobo reversal on a large existing balance exactly',async()=>{
  const {f,id}=await posted(['0.01']);await f.tenant(c=>c.query("UPDATE member_savings_accounts SET current_balance='90071992547409.92'"));await reverse(f,id).expect(200);expect((await net(f)).accounts[0].current_balance).toBe('90071992547409.91');
 });
 it('rolls back all members, journals, counters and audits when one balance is insufficient',async()=>{
  const {f,id}=await posted();await f.tenant(c=>c.query("UPDATE member_savings_accounts SET current_balance='0.00' WHERE member_id=$1",[f.members[1]!.id]));const before=await snapshot(f);await reverse(f,id).expect(409);expect(await snapshot(f)).toEqual(before);
 });
 it('rolls back a late payroll audit failure and permits a clean retry',async()=>{
  const {f,id}=await posted(),before=await snapshot(f);
  await pool.query(`CREATE FUNCTION payroll_test_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='payroll.reversed' AND NEW.organization_id='${f.org}'::uuid THEN RAISE EXCEPTION 'synthetic payroll audit failure'; END IF; RETURN NEW; END; $$`);
  await pool.query('CREATE TRIGGER payroll_test_fail_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION payroll_test_fail_audit()');
  try{await reverse(f,id).expect(500);expect(await snapshot(f)).toEqual(before);}finally{await pool.query('DROP TRIGGER payroll_test_fail_audit ON audit_logs');await pool.query('DROP FUNCTION payroll_test_fail_audit()');}
  await reverse(f,id).expect(200);expect((await net(f)).movements).toBe('0.00');
 });
 it('rolls back journal reversal if savings projection insertion fails',async()=>{
  const {f,id}=await posted(),before=await snapshot(f);
  await pool.query(`CREATE FUNCTION payroll_test_fail_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='WITHDRAWAL' AND NEW.organization_id='${f.org}'::uuid THEN RAISE EXCEPTION 'synthetic payroll projection failure'; END IF; RETURN NEW; END; $$`);
  await pool.query('CREATE TRIGGER payroll_test_fail_projection BEFORE INSERT ON savings_transactions FOR EACH ROW EXECUTE FUNCTION payroll_test_fail_projection()');
  try{await reverse(f,id).expect(500);expect(await snapshot(f)).toEqual(before);}finally{await pool.query('DROP TRIGGER payroll_test_fail_projection ON savings_transactions');await pool.query('DROP FUNCTION payroll_test_fail_projection()');}
 });
 it('refuses a closed original period without side effects',async()=>{
  const {f,id}=await posted();await f.tenant(c=>c.query("UPDATE ledger_periods SET status='LOCKED'"));const before=await snapshot(f);await reverse(f,id).expect(409);expect(await snapshot(f)).toEqual(before);await f.tenant(c=>c.query("UPDATE ledger_periods SET status='OPEN'"));await reverse(f,id).expect(200);
 });
 it('fails closed on absent savings projections instead of using preview rows',async()=>{
  const {f,id}=await posted();await f.tenant(c=>c.query('DELETE FROM savings_transactions WHERE account_id IN (SELECT id FROM member_savings_accounts WHERE member_id=$1)',[f.members[1]!.id]));const before=await snapshot(f);await reverse(f,id).expect(409);expect(await snapshot(f)).toEqual(before);
 });
 it('fails closed on mismatched journal links',async()=>{
  const {f,id}=await posted();await f.tenant(c=>c.query('UPDATE payroll_batches SET journal_entry_ids=$1::jsonb WHERE id=$2',[JSON.stringify([randomUUID()]),id]));const before=await snapshot(f);await reverse(f,id).expect(409);expect(await snapshot(f)).toEqual(before);
 });
 it('serializes concurrent duplicate reversals into one correction',async()=>{
  const {f,id}=await posted();const responses=await Promise.all([reverse(f,id),reverse(f,id)]);expect(responses.map(r=>r.status).sort()).toEqual([200,409]);const p=await net(f);expect(p.reversals).toHaveLength(1);expect(p.movements).toBe('0.00');
 });
 it('conserves a concurrent ordinary withdrawal and payroll reversal',async()=>{
  const {f,id}=await posted(['0.23']);const account=await f.tenant(async c=>(await c.query('SELECT id FROM member_savings_accounts')).rows[0].id);
  await request(app.getHttpServer()).post(`/api/v1/savings/accounts/${account}/deposits`).set(f.auth).send({amount:0.01}).expect(201);
  await Promise.all([reverse(f,id).expect(200),request(app.getHttpServer()).post(`/api/v1/savings/accounts/${account}/withdrawals`).set(f.auth).send({amount:0.01}).expect(200)]);const p=await net(f);expect(p.accounts[0].current_balance).toBe('0.00');expect(p.movements).toBe('0.00');expect(p.members[0].net).toBe('0.00');
 });
 it('blocks the generic ledger bypass and cross-tenant batch guesses',async()=>{
  const {f,id}=await posted();const entry=await f.tenant(async c=>(await c.query("SELECT id FROM journal_entries WHERE source_type='payroll_batch'")).rows[0].id);const before=await snapshot(f);
  await request(app.getHttpServer()).post(`/api/v1/ledger/journals/${entry}/reverse`).set(f.auth).send({reason:'Bypass attempt'}).expect(409);
  const other=await fixture(1);await reverse(other,id).expect(404);expect(await snapshot(f)).toEqual(before);
 });
 it('supports historical empty manifests using source-stamped journals',async()=>{
  const {f,id}=await posted();await f.tenant(c=>c.query("UPDATE payroll_batches SET journal_entry_ids='[]'::jsonb WHERE id=$1",[id]));await reverse(f,id).expect(200);expect((await net(f)).movements).toBe('0.00');
 });
 it('reverses posted accounts when their member subsequently exits',async()=>{
  const {f,id}=await posted(['0.23']);await f.tenant(c=>c.query("UPDATE members SET status='EXITED'"));await reverse(f,id).expect(200);expect((await net(f)).movements).toBe('0.00');
 });
 it('refuses an inactive posted savings account without side effects',async()=>{
  const {f,id}=await posted(['0.23']);await f.tenant(c=>c.query("UPDATE member_savings_accounts SET status='CLOSED'"));const before=await snapshot(f);await reverse(f,id).expect(409);expect(await snapshot(f)).toEqual(before);
 });
 it('links each savings correction to its own reversal in a multi-entry historical batch',async()=>{
  const {f,id}=await posted(['0.23']);
  await f.tenant(async c=>{
   const original=(await c.query("SELECT * FROM journal_entries WHERE source_type='payroll_batch'")).rows[0];
   const entry=randomUUID(),seq=(await c.query('UPDATE org_counters SET journal_seq=journal_seq+1 RETURNING journal_seq')).rows[0].journal_seq;
   await c.query(`INSERT INTO journal_entries (id,organization_id,period_id,entry_date,description,source,source_type,source_id,status,entry_no,created_by,posted_by,posted_at)
    VALUES ($1,$2,$3,$4,'Synthetic historical second entry','PAYROLL_DEDUCTION','payroll_batch',$5,'POSTED',$6,$7,$7,now())`,[entry,f.org,original.period_id,original.entry_date,id,seq,original.created_by]);
   await c.query(`INSERT INTO journal_lines (organization_id,journal_entry_id,account_id,debit,credit,member_id)
    SELECT organization_id,$1,account_id,CASE WHEN debit>0 THEN 0.01 ELSE 0 END,CASE WHEN credit>0 THEN 0.01 ELSE 0 END,member_id FROM journal_lines WHERE journal_entry_id=$2`,[entry,original.id]);
   const account=(await c.query("UPDATE member_savings_accounts SET current_balance=current_balance+0.01 RETURNING id,current_balance")).rows[0];
   await c.query("INSERT INTO savings_transactions (organization_id,account_id,journal_entry_id,type,signed_amount,running_balance) VALUES ($1,$2,$3,'DEPOSIT','0.01',$4)",[f.org,account.id,entry,account.current_balance]);
   await c.query('UPDATE payroll_batches SET journal_entry_ids=$1::jsonb WHERE id=$2',[JSON.stringify([original.id,entry]),id]);
  });
  const response=await reverse(f,id).expect(200);expect(response.body.entriesReversed).toBe(2);const p=await net(f);expect(p.reversals).toHaveLength(2);expect(p.movements).toBe('0.00');expect(p.accounts[0].current_balance).toBe('0.00');
  const pairs=await f.tenant(async c=>(await c.query(`SELECT st.signed_amount,je.reversal_of_entry_id FROM savings_transactions st JOIN journal_entries je ON je.id=st.journal_entry_id WHERE st.type='WITHDRAWAL'`)).rows);expect(pairs.map(r=>r.signed_amount).sort()).toEqual(['-0.01','-0.23']);expect(new Set(pairs.map(r=>r.reversal_of_entry_id)).size).toBe(2);
 });

 it('rolls back a journal-stage failure without any correction or counter change',async()=>{
  const {f,id}=await posted(),before=await snapshot(f);
  await pool.query(`CREATE FUNCTION payroll_test_fail_journal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='journal.reversed' AND NEW.organization_id='${f.org}'::uuid THEN RAISE EXCEPTION 'synthetic journal reversal failure'; END IF; RETURN NEW; END; $$`);
  await pool.query('CREATE TRIGGER payroll_test_fail_journal BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION payroll_test_fail_journal()');
  try{await reverse(f,id).expect(500);expect(await snapshot(f)).toEqual(before);}finally{await pool.query('DROP TRIGGER payroll_test_fail_journal ON audit_logs');await pool.query('DROP FUNCTION payroll_test_fail_journal()');}
 });
 it('rolls back all financial corrections when batch-state finalization fails',async()=>{
  const {f,id}=await posted(),before=await snapshot(f);
  await pool.query(`CREATE FUNCTION payroll_test_fail_state() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='REVERSED' AND NEW.organization_id='${f.org}'::uuid THEN RAISE EXCEPTION 'synthetic payroll state failure'; END IF; RETURN NEW; END; $$`);
  await pool.query('CREATE TRIGGER payroll_test_fail_state BEFORE UPDATE ON payroll_batches FOR EACH ROW EXECUTE FUNCTION payroll_test_fail_state()');
  try{await reverse(f,id).expect(500);expect(await snapshot(f)).toEqual(before);}finally{await pool.query('DROP TRIGGER payroll_test_fail_state ON payroll_batches');await pool.query('DROP FUNCTION payroll_test_fail_state()');}
 });

});
