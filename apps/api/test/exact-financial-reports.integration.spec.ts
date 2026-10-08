import ExcelJS from 'exceljs';
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

describe('exact financial reports (PostgreSQL)',()=>{
 let app:INestApplication,pool:Pool,platform:string;
 beforeAll(async()=>{
  process.env.DATABASE_URL=TEST_DATABASE_URL;pool=new Pool({connectionString:TEST_DATABASE_URL});await ensureRbacSeeded(pool);
  const module=await Test.createTestingModule({imports:[AppModule]}).compile();app=module.createNestApplication();app.setGlobalPrefix('api/v1');app.useGlobalPipes(new ValidationPipe({whitelist:true,transform:true,forbidNonWhitelisted:true}));await app.init();
  platform=(await request(app.getHttpServer()).post('/api/v1/auth/login').send({email:'admin@coopengine.dev',password:ADMIN_PASSWORD}).expect(200)).body.tokens.accessToken;
 });
 afterAll(async()=>{await app?.close();await pool?.end();});
 async function fixture(count=1){
  const suffix=randomUUID().slice(0,8),email=`exact-reports-${suffix}@coopengine.test`;
  const org=(await request(app.getHttpServer()).post('/api/v1/organizations').set('Authorization',`Bearer ${platform}`).send({name:`Journal submit ${suffix}`,slug:`exact-reports-${suffix}`,adminEmail:email,adminPassword:'ExactPayrollPass123!'}).expect(201)).body.id;
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
  const journalBody={idempotencyKey:key,entryDate:date,description:'Synthetic draft',lines:[{accountCode:'5010',debit:0.23,memo:'Original memo'},{accountCode:'1000',credit:0.23}]};
  const send=(path:string,body:unknown,headers=auth)=>request(app.getHttpServer()).post('/api/v1'+path).set(headers).send(body);
  const snapshot=()=>tenant(async c=>{const result:Record<string,unknown>={};for(const table of ['ledger_periods','loans','loan_guarantors','loan_repayments','financial_write_receipts','audit_logs','journal_entries','journal_lines','member_savings_accounts','savings_transactions','org_counters'])result[table]=(await c.query(`SELECT * FROM ${table} WHERE organization_id=$1 ORDER BY ${table==='org_counters'?'organization_id':'id'}`,[org])).rows;return result;});
  const id=(await send('/ledger/journals',journalBody).expect(201)).body.id as string;
  const submit=(journalId=id,headers=auth)=>send(`/ledger/journals/${journalId}/submit`,{},headers);
  return{org,auth,checker,members,tenant,actor,key,journalBody,send,snapshot,id,submit,account};
 }

 const get=(f:{auth:{Authorization:string}},path:string)=>request(app.getHttpServer()).get('/api/v1'+path).set(f.auth);
 it('retains exact report totals and CSV digits with a large synthetic projection',async()=>{
  const f=await fixture();await f.tenant(c=>c.query('UPDATE member_savings_accounts SET current_balance=$1 WHERE id=$2',['90071992547409.91',f.account]));
  const before=await f.snapshot();const book=(await get(f,'/reports/savings-book').expect(200)).body;
  expect(book.totalBalanceDecimal).toBe('90071992547409.91');expect(book.rows[0].balanceDecimal).toBe('90071992547409.91');expect(typeof book.totalBalance).toBe('number');
  const member=(await get(f,`/reports/member/${f.members[0]!.id}/360`).expect(200)).body;expect(member.savingsTotalDecimal).toBe('90071992547409.91');
  const pack=(await get(f,'/reports/board-pack').expect(200)).body;expect(pack.savings.totalBalanceDecimal).toBe('90071992547409.91');
  expect((await get(f,'/reports/export/savings-book').expect(200)).text).toContain(',90071992547409.91,');expect((await get(f,'/reports/export/board-pack').expect(200)).text).toContain('savings,totalBalance,90071992547409.91');
  const interest=(await get(f,'/reports/savings-interest-preview').expect(200)).body;expect(interest.totalBalanceDecimal).toBe('90071992547409.91');
  expect(await f.snapshot()).toEqual(before);
 });
 it('detects a one-kobo reconciliation mismatch hidden by numeric conversion',async()=>{
  const f=await fixture();const body={...f.journalBody,idempotencyKey:randomUUID(),lines:[{accountCode:'1000',debit:'90071992547408.75',memberId:f.members[0]!.id},{accountCode:'2000',credit:'90071992547408.75',memberId:f.members[0]!.id}]};const id=(await f.send('/ledger/journals',body).expect(201)).body.id;await f.submit(id).expect(200);await f.send(`/ledger/journals/${id}/approve-post`,{},f.checker).expect(200);
  await f.tenant(c=>c.query('UPDATE member_savings_accounts SET current_balance=$1 WHERE id=$2',['90071992547409.91',f.account]));const before=await f.snapshot();const report=(await get(f,'/reports/savings-reconciliation').expect(200)).body;
  expect(report.mismatches).toHaveLength(1);expect(report.mismatches[0]).toMatchObject({projectedDecimal:'90071992547409.91',ledgerDecimal:'90071992547409.90',diffDecimal:'0.01'});expect(await f.snapshot()).toEqual(before);
 });
 it('preserves totals above a column range and keeps spreadsheet money as exact text',async()=>{
  const f=await fixture(2);const second=(await f.send(`/savings/member/${f.members[1]!.id}/account`,{}).expect(201)).body.id;await f.tenant(c=>c.query('UPDATE member_savings_accounts SET current_balance=$1 WHERE id=ANY($2::uuid[])',['99999999999999999.99',[f.account,second]]));
  const book=(await get(f,'/reports/savings-book').expect(200)).body;expect(book.totalBalanceDecimal).toBe('199999999999999999.98');
  const result=await get(f,'/reports/board-pack.xlsx').buffer(true).parse((res,cb)=>{const chunks:Buffer[]=[];res.on('data',(c:Buffer)=>chunks.push(c));res.on('end',()=>cb(null,Buffer.concat(chunks)));}).expect(200);
  const wb=new ExcelJS.Workbook();await wb.xlsx.load(result.body);const summary=wb.getWorksheet('Summary')!;let total:unknown;summary.eachRow(row=>{if(row.getCell(1).value==='Total savings')total=row.getCell(2).value;});expect(total).toBe('199999999999999999.98');
  const trial=wb.getWorksheet('Trial Balance')!;let expense:unknown;trial.eachRow(row=>{if(row.getCell(1).value==='5010')expense=row.getCell(4).value;});expect(expense).toBe('0.00'); // The fixture draft is excluded.
 });
 it('keeps posted spreadsheet sums exact and excludes an additional large draft',async()=>{
  const f=await fixture();const body={...f.journalBody,idempotencyKey:randomUUID(),lines:[{accountCode:'5010',debit:'90071992547409.91'},{accountCode:'1000',credit:'90071992547409.91'}]};const id=(await f.send('/ledger/journals',body).expect(201)).body.id;await f.submit(id).expect(200);await f.send(`/ledger/journals/${id}/approve-post`,{},f.checker).expect(200);await f.send('/ledger/journals',{...body,idempotencyKey:randomUUID()}).expect(201);
  const result=await get(f,'/reports/board-pack.xlsx').buffer(true).parse((res,cb)=>{const chunks:Buffer[]=[];res.on('data',(c:Buffer)=>chunks.push(c));res.on('end',()=>cb(null,Buffer.concat(chunks)));}).expect(200);const wb=new ExcelJS.Workbook();await wb.xlsx.load(result.body);let expense:unknown,total:unknown;wb.getWorksheet('Trial Balance')!.eachRow(row=>{if(row.getCell(1).value==='5010')expense=row.getCell(4).value;if(row.getCell(2).value==='TOTAL')total=row.getCell(6).value;});expect(expense).toBe('90071992547409.91');expect(total).toBe('0.00');
 });
 it('retains statement and export tenant isolation',async()=>{const f=await fixture(),g=await fixture();await get(g,`/reports/member/${f.members[0]!.id}/360`).expect(404);await get(g,`/reports/export/member-statement?memberId=${f.members[0]!.id}`).expect(404);const pack=(await get(g,'/reports/board-pack').expect(200)).body;expect(pack.savings.totalBalanceDecimal).toBe('1.15');});
});
