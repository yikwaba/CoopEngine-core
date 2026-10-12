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

// Private fixture domain avoids older suites' broad @coopengine.test user cleanup.
// These referenced approval identities live only in this disposable test database.
describe('member withdrawal approval identity (PostgreSQL)',()=>{
 let app:INestApplication,pool:Pool,platform:string;
 beforeAll(async()=>{
  process.env.DATABASE_URL=TEST_DATABASE_URL;pool=new Pool({connectionString:TEST_DATABASE_URL});await ensureRbacSeeded(pool);
  const module=await Test.createTestingModule({imports:[AppModule]}).compile();app=module.createNestApplication();app.setGlobalPrefix('api/v1');app.useGlobalPipes(new ValidationPipe({whitelist:true,transform:true,forbidNonWhitelisted:true}));await app.init();
  platform=(await request(app.getHttpServer()).post('/api/v1/auth/login').send({email:'admin@coopengine.dev',password:ADMIN_PASSWORD}).expect(200)).body.tokens.accessToken;
 });
 afterAll(async()=>{await app?.close();await pool?.end();});
 async function fixture(count=1){
  const suffix=randomUUID().slice(0,8),email=`exact-reports-${suffix}@member-approval.invalid`;
  const org=(await request(app.getHttpServer()).post('/api/v1/organizations').set('Authorization',`Bearer ${platform}`).send({name:`Journal submit ${suffix}`,slug:`exact-reports-${suffix}`,adminEmail:email,adminPassword:'ExactPayrollPass123!'}).expect(201)).body.id;
  const token=(await request(app.getHttpServer()).post('/api/v1/auth/login').send({email,password:'ExactPayrollPass123!'}).expect(200)).body.tokens.accessToken;
  const auth={Authorization:`Bearer ${token}`};
  const invited=(await request(app.getHttpServer()).post('/api/v1/users').set(auth).send({email:`checker-${suffix}@member-approval.invalid`,roleCodes:['TREASURER']}).expect(201)).body;
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
  const snapshot=()=>tenant(async c=>{const result:Record<string,unknown>={};for(const table of ['ledger_periods','loans','loan_guarantors','loan_repayments','financial_write_receipts','audit_logs','journal_entries','journal_lines','member_savings_accounts','savings_transactions','org_counters','savings_withdrawal_requests','approval_requests','approval_steps','approval_actions'])result[table]=(await c.query(`SELECT * FROM ${table} WHERE organization_id=$1 ORDER BY ${table==='org_counters'?'organization_id':'id'}`,[org])).rows;return result;});
  const id=(await send('/ledger/journals',journalBody).expect(201)).body.id as string;
  const submit=(journalId=id,headers=auth)=>send(`/ledger/journals/${journalId}/submit`,{},headers);
  return{org,auth,checker,members,tenant,actor,key,journalBody,send,snapshot,id,submit,account};
 }

 const read=(f:Awaited<ReturnType<typeof fixture>>,path:string)=>request(app.getHttpServer()).get('/api/v1'+path).set(f.auth);
 const balance=async(f:Awaited<ReturnType<typeof fixture>>)=>(await read(f,'/reports/savings-book').expect(200)).body.rows.find((r:{memberId:string})=>r.memberId===f.members[0]!.id).balanceDecimal;
 async function policy(f:Awaited<ReturnType<typeof fixture>>,min='0.00',max:string|null=null,steps=true,active=true){
  return f.tenant(async c=>{const id=(await c.query("INSERT INTO approval_policies (organization_id,kind,min_amount,max_amount,version,is_active) VALUES ($1,'WITHDRAWAL',$2,$3,1,$4) RETURNING id",[f.org,min,max,active])).rows[0].id as string;
   if(steps)await c.query("INSERT INTO approval_policy_steps (organization_id,policy_id,step_no,approver_role_code) VALUES ($1,$2,1,'TREASURER'),($1,$2,2,'CHAIRMAN')",[f.org,id]);return id;});
 }
 async function chair(f:Awaited<ReturnType<typeof fixture>>){const u=(await f.send('/users',{email:`chair-${randomUUID()}@member-approval.invalid`,roleCodes:['CHAIRMAN']}).expect(201)).body;const t=(await request(app.getHttpServer()).post('/api/v1/auth/login').send({email:u.email,password:u.tempPassword}).expect(200)).body.tokens.accessToken;return{Authorization:`Bearer ${t}`};}
 const withdrawal=(f:Awaited<ReturnType<typeof fixture>>,key=randomUUID(),amount=0.01)=>f.send(`/savings/accounts/${f.account}/withdrawals`,{idempotencyKey:key,amount,description:'Policy precedence regression'});
 const decision=(f:Awaited<ReturnType<typeof fixture>>,id:string,headers=f.checker,step=1,action='approve')=>f.send(`/savings/withdrawals/${id}/${action}`,{expectedStepNo:step},headers);

 async function memberAuth(f:Awaited<ReturnType<typeof fixture>>,index=0){
  const email=`member-${randomUUID()}@member-approval.invalid`,slug=(await f.tenant(c=>c.query('SELECT slug FROM organizations WHERE id=$1',[f.org]))).rows[0].slug;
  await f.tenant(c=>c.query('UPDATE members SET email=$1 WHERE id=$2',[email,f.members[index]!.id]));
  const otp=(await request(app.getHttpServer()).post('/api/v1/auth/member/request-otp').send({organizationSlug:slug,email}).expect(200)).body;
  const login=(await request(app.getHttpServer()).post('/api/v1/auth/member/verify-otp').send({organizationSlug:slug,email,code:otp.devCode}).expect(200)).body;
  return {Authorization:`Bearer ${login.accessToken}`};
 }
 const memberWithdrawal=(f:Awaited<ReturnType<typeof fixture>>,headers:{Authorization:string},key=randomUUID(),amount=0.01)=>f.send('/member/withdrawals/request',{idempotencyKey:key,accountId:f.account,amount,description:'Member policy regression'},headers);
 it('records authenticated member origin and submission, enforces ordered staff steps and replays one final debit',async()=>{
  const f=await fixture(),member=await memberAuth(f),final=await chair(f);await policy(f);
  const key=randomUUID(),[a,b]=await Promise.all([memberWithdrawal(f,member,key).expect(201),memberWithdrawal(f,member,key).expect(201)]);expect(a.body).toEqual(b.body);expect(a.body.kind).toBe('PENDING');const id=a.body.requestId;
  const origin=await f.tenant(async c=>({request:(await c.query('SELECT requested_by,requested_by_member_id,amount FROM approval_requests WHERE entity_id=$1',[id])).rows[0],action:(await c.query("SELECT actor_user_id,actor_member_id,action FROM approval_actions WHERE request_id=(SELECT id FROM approval_requests WHERE entity_id=$1)",[id])).rows[0]}));
  expect(origin).toEqual({request:{requested_by:null,requested_by_member_id:f.members[0]!.id,amount:'0.01'},action:{actor_user_id:null,actor_member_id:f.members[0]!.id,action:'SUBMIT'}});
  await memberWithdrawal(f,member,key,0.02).expect(409);
  const memberDecision=await decision(f,id,member);expect([401,403]).toContain(memberDecision.status);
  await decision(f,id,final).expect(403);expect(await balance(f)).toBe('1.15');
  const inbox=(await request(app.getHttpServer()).get('/api/v1/approvals').set(f.checker).expect(200)).body;const item=inbox.items.find((x:{id:string})=>x.id===id);expect(item.requestedByMemberId).toBe(f.members[0]!.id);expect(item.requestedById).toBeNull();expect(item.requestedBy).toContain('Member');
  expect((await decision(f,id).expect(200)).body.approvalStatus).toBe('PENDING');expect(await balance(f)).toBe('1.15');await decision(f,id,final,1).expect(409);
  const [posted,replayed]=await Promise.all([decision(f,id,final,2).expect(200),decision(f,id,final,2).expect(200)]);expect(posted.body).toEqual(replayed.body);expect(posted.body.approvalStatus).toBe('APPROVED');expect(await balance(f)).toBe('1.14');
  expect((await memberWithdrawal(f,member,key).expect(201)).body).toEqual(a.body);
  const proof=await f.tenant(async c=>({requests:(await c.query('SELECT count(*)::int AS n FROM savings_withdrawal_requests')).rows[0].n,chains:(await c.query('SELECT count(*)::int AS n FROM approval_requests')).rows[0].n,journals:(await c.query('SELECT count(*)::int AS n FROM journal_entries WHERE id=$1',[posted.body.journalEntryId])).rows[0].n}));expect(proof).toEqual({requests:1,chains:1,journals:1});
 });
 it('member rejection closes both records without payout and retry does not resurrect them',async()=>{
  const f=await fixture(),member=await memberAuth(f);await policy(f);const key=randomUUID(),r=(await memberWithdrawal(f,member,key).expect(201)).body;
  const a=(await decision(f,r.requestId,f.checker,1,'reject').expect(200)).body;expect((await decision(f,r.requestId,f.checker,1,'reject').expect(200)).body).toEqual(a);expect(await balance(f)).toBe('1.15');
  const rows=await f.tenant(c=>c.query('SELECT r.status,a.status AS approval_status FROM savings_withdrawal_requests r JOIN approval_requests a ON a.entity_id=r.id WHERE r.id=$1',[r.requestId]));expect(rows.rows[0]).toEqual({status:'REJECTED',approval_status:'REJECTED'});expect((await memberWithdrawal(f,member,key).expect(201)).body).toEqual(r);
 });
 it('invalid member policy configurations leave no parked request, receipt, submission or financial effect',async()=>{
  for(const mode of ['gap','overlap','steps']){const f=await fixture(),member=await memberAuth(f);await policy(f,mode==='gap'?'0.02':'0.00',null,mode!=='steps');if(mode==='overlap')await policy(f,'0.01');const before=await f.snapshot();await memberWithdrawal(f,member).expect(409);expect(await f.snapshot()).toEqual(before);}
 });
 it('member account ownership, receipt identity and tenant decisions cannot cross boundaries',async()=>{
  const f=await fixture(2),g=await fixture(),member=await memberAuth(f),other=await memberAuth(f,1),foreign=await memberAuth(g);await policy(f);const key=randomUUID(),r=(await memberWithdrawal(f,member,key).expect(201)).body;
  await memberWithdrawal(f,other).expect(400);await memberWithdrawal(f,other,key).expect(409);await memberWithdrawal(f,foreign).expect(404);await decision(f,r.requestId,g.checker).expect(404);expect(await balance(f)).toBe('1.15');expect(await balance(g)).toBe('1.15');
 });
 it('without active policies members stay parked and use the existing staff approval path',async()=>{
  const f=await fixture(),member=await memberAuth(f);await policy(f,'0.00',null,true,false);const r=(await memberWithdrawal(f,member).expect(201)).body;expect(r.kind).toBe('PENDING');expect(await balance(f)).toBe('1.15');expect((await f.tenant(c=>c.query('SELECT count(*)::int AS n FROM approval_requests'))).rows[0].n).toBe(0);await f.send(`/savings/withdrawals/${r.requestId}/approve`,{},f.checker).expect(200);expect(await balance(f)).toBe('1.14');
 });
 it('database rejects ambiguous request identity and foreign-tenant member references',async()=>{
  const f=await fixture(),g=await fixture(),member=await memberAuth(f);await policy(f);const r=(await memberWithdrawal(f,member).expect(201)).body;
  await expect(f.tenant(c=>c.query('UPDATE approval_requests SET requested_by=$1 WHERE entity_id=$2',[f.actor,r.requestId]))).rejects.toMatchObject({code:'23514'});
  await expect(f.tenant(c=>c.query('UPDATE approval_requests SET requested_by_member_id=$1 WHERE entity_id=$2',[g.members[0]!.id,r.requestId]))).rejects.toMatchObject({code:'23503'});
  await expect(f.tenant(c=>c.query('UPDATE approval_requests SET requested_by_member_id=NULL WHERE entity_id=$1',[r.requestId]))).rejects.toMatchObject({code:'23514'});
  expect(await balance(f)).toBe('1.15');
 });
});
