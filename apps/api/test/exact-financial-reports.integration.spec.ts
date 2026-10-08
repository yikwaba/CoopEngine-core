import ExcelJS from 'exceljs';
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { withTenant } from '@coopengine/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PdfService } from '../src/pdf/pdf.service';
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
 it('uses historical boundaries for real dated and empty-period statements without writes',async()=>{
  const f=await fixture();await f.send(`/savings/accounts/${f.account}/deposits`,{idempotencyKey:randomUUID(),amount:0.01}).expect(201);
  // Synthetic dates only, constrained to this fixture's account and tenant.
  await f.tenant(c=>c.query(`UPDATE savings_transactions SET created_at=CASE WHEN running_balance=1.15 THEN '2026-01-10T12:00:00Z'::timestamptz ELSE '2026-03-10T12:00:00Z'::timestamptz END WHERE organization_id=$1 AND account_id=$2`,[f.org,f.account]));
  const pdf=app.get(PdfService),original=(pdf as any).doc.bind(pdf),texts:string[]=[];
  const spy=vi.spyOn(pdf as any,'doc').mockImplementation(()=>{const doc=original(),text=doc.text;doc.text=function(value:string,...args:unknown[]){texts.push(String(value));return text.call(this,value,...args);};return doc;});
  try{
   const before=await f.snapshot();
   for(const [from,to,opening,closing] of [
    ['2026-01-01','2026-01-31','0.00','1.15'],
    ['2026-02-01','2026-02-28','1.15','1.15'],
    [undefined,'2025-12-31','0.00','0.00'],
    ['2027-01-01',undefined,'1.16','1.16'],
   ]){texts.length=0;const result=await pdf.memberStatement(f.org,f.members[0]!.id,from,to);expect(result.buffer.subarray(0,5).toString()).toBe('%PDF-');expect(texts).toContain(`Opening balance: NGN ${opening}`);expect(texts).toContain(`Closing balance: NGN ${closing}`);}
   expect(await f.snapshot()).toEqual(before);
  }finally{spy.mockRestore();}
 });
 async function secondAccount(f:Awaited<ReturnType<typeof fixture>>,amount=2.30){
  const product=(await f.send('/products/savings',{code:'EXTRA-SAVINGS',name:'Extra savings',interestRatePa:12,minDeposit:0,allowWithdrawal:true}).expect(201)).body;
  const id=(await f.send(`/savings/member/${f.members[0]!.id}/account`,{productId:product.id}).expect(201)).body.id as string;
  await f.send(`/savings/accounts/${id}/deposits`,{idempotencyKey:randomUUID(),amount}).expect(201);
  return id;
 }
 async function interestBoth(f:Awaited<ReturnType<typeof fixture>>){
  await f.tenant(c=>c.query('UPDATE savings_products SET interest_rate_pa=12 WHERE organization_id=$1',[f.org]));
  await f.send('/savings/interest/post',{period:new Date().toISOString().slice(0,7)}).expect(200);
 }
 it('reconciles independent products, shared interest and a withdrawal without changing financial records',async()=>{
  const f=await fixture(),other=await secondAccount(f);await interestBoth(f);
  await f.send(`/savings/accounts/${other}/withdrawals`,{idempotencyKey:randomUUID(),amount:0.01}).expect(201);
  const before=await f.snapshot(),r=(await get(f,'/reports/savings-reconciliation').expect(200)).body;
  expect(r).toMatchObject({checked:2,matched:2,balanced:true,unresolvedEntries:0,mismatches:[]});
  expect(r.rows.find((x:{accountId:string})=>x.accountId===f.account)).toMatchObject({ledgerDecimal:'1.16',projectedDecimal:'1.16',status:'MATCHED'});
  expect(r.rows.find((x:{accountId:string})=>x.accountId===other)).toMatchObject({ledgerDecimal:'2.31',projectedDecimal:'2.31',status:'MATCHED'});
  expect(r.totals).toMatchObject({ledgerDecimal:'3.47',projectedDecimal:'3.47',unallocatedLedgerDecimal:'0.00'});expect(await f.snapshot()).toEqual(before);
 });
 it('detects opposite one-kobo product differences even when the member total agrees',async()=>{
  const f=await fixture(),other=await secondAccount(f);
  // Synthetic projection drift, never a history repair or a production write.
  await f.tenant(async c=>{await c.query('UPDATE member_savings_accounts SET current_balance=current_balance+0.01 WHERE id=$1',[f.account]);await c.query('UPDATE member_savings_accounts SET current_balance=current_balance-0.01 WHERE id=$1',[other]);});
  const before=await f.snapshot(),r=(await get(f,'/reports/savings-reconciliation').expect(200)).body;
  expect(r.balanced).toBe(false);expect(r.totals.diffDecimal).toBe('0.00');expect(r.mismatches.map((x:{diffDecimal:string})=>x.diffDecimal).sort()).toEqual(['-0.01','0.01']);expect(await f.snapshot()).toEqual(before);
 });
 it('reports unallocated member liability rather than certifying a matching combined projection',async()=>{
  const f=await fixture();await secondAccount(f);const body={...f.journalBody,idempotencyKey:randomUUID(),lines:[{accountCode:'1000',debit:'1.00',memberId:f.members[0]!.id},{accountCode:'2000',credit:'1.00',memberId:f.members[0]!.id}]};const id=(await f.send('/ledger/journals',body).expect(201)).body.id;
  await f.submit(id).expect(200);await f.send(`/ledger/journals/${id}/approve-post`,{},f.checker).expect(200);
  await f.tenant(c=>c.query('UPDATE member_savings_accounts SET current_balance=current_balance+1 WHERE id=$1',[f.account]));
  const before=await f.snapshot(),r=(await get(f,'/reports/savings-reconciliation').expect(200)).body;
  expect(r).toMatchObject({balanced:false,matched:0,unresolvedAccounts:2});expect(r.totals).toMatchObject({diffDecimal:'0.00',unallocatedLedgerDecimal:'1.00'});expect(r.unresolved[0].reason).toBe('MEMBER_LIABILITY_WITHOUT_ACCOUNT_ALLOCATION');expect(r.rows.every((x:{ledgerDecimal:string|null})=>x.ledgerDecimal===null)).toBe(true);expect(await f.snapshot()).toEqual(before);
 });
 it('flags shared-batch transaction drift instead of inferring an allocation',async()=>{
  const f=await fixture(),other=await secondAccount(f);await interestBoth(f);
  await f.tenant(c=>c.query("UPDATE savings_transactions SET signed_amount=signed_amount-0.01 WHERE organization_id=$1 AND account_id=$2 AND type='INTEREST'",[f.org,other]));
  const before=await f.snapshot(),r=(await get(f,'/reports/savings-reconciliation').expect(200)).body;
  expect(r.balanced).toBe(false);expect(r.unresolvedAccounts).toBe(2);expect(r.unresolved.some((x:{reason:string})=>x.reason==='MOVEMENT_LEDGER_DISAGREEMENT')).toBe(true);expect(await f.snapshot()).toEqual(before);
 });
 it('includes reversed originals and counter-entries and reveals a missing account projection',async()=>{
  const f=await fixture();await secondAccount(f);
  const id=(await f.tenant(c=>c.query("SELECT id FROM journal_entries WHERE source_type='savings_account' AND source_id=$1",[f.account]))).rows[0].id;
  await f.send(`/ledger/journals/${id}/reverse`,{reason:'Synthetic savings journal reversal'}).expect(200);
  const before=await f.snapshot(),r=(await get(f,'/reports/savings-reconciliation').expect(200)).body;
  expect(r.unresolvedEntries).toBe(0);expect(r.balanced).toBe(false);expect(r.totals.ledgerDecimal).toBe('2.30');expect(r.mismatches[0]).toMatchObject({accountId:f.account,ledgerDecimal:'0.00',diffDecimal:'1.15'});expect(await f.snapshot()).toEqual(before);
 });
 it('reconciles a payroll posting and atomic reversal when the member has two products',async()=>{
  const f=await fixture();await secondAccount(f);
  const preview=(await f.send('/payroll/import/preview',{idempotencyKey:randomUUID(),filename:'multi-product.csv',csv:`memberNo,amount\n${f.members[0]!.memberNo},0.01`}).expect(201)).body;
  await f.send('/payroll/import/commit',{batchId:preview.batchId}).expect(200);await f.send(`/payroll/batches/${preview.batchId}/approve`,{},f.checker).expect(200);
  expect((await get(f,'/reports/savings-reconciliation').expect(200)).body.balanced).toBe(true);
  await f.send(`/payroll/batches/${preview.batchId}/reverse`,{reason:'Synthetic multi-product payroll correction'}).expect(200);
  const before=await f.snapshot(),r=(await get(f,'/reports/savings-reconciliation').expect(200)).body;
  expect(r).toMatchObject({checked:2,matched:2,balanced:true,unresolvedEntries:0});expect(r.totals.ledgerDecimal).toBe('3.45');expect(await f.snapshot()).toEqual(before);
 });
 it('keeps multi-product reconciliation isolated to the authenticated tenant',async()=>{
  const f=await fixture(),g=await fixture();await secondAccount(f);await secondAccount(g,0.23);
  const a=(await get(f,'/reports/savings-reconciliation').expect(200)).body,b=(await get(g,'/reports/savings-reconciliation').expect(200)).body;
  expect(a.totals.ledgerDecimal).toBe('3.45');expect(b.totals.ledgerDecimal).toBe('1.38');expect(a.balanced&&b.balanced).toBe(true);
  expect(JSON.stringify(a)).not.toContain(g.account);expect(JSON.stringify(b)).not.toContain(f.account);
 });
 it('retains statement and export tenant isolation',async()=>{const f=await fixture(),g=await fixture();await get(g,`/reports/member/${f.members[0]!.id}/360`).expect(404);await get(g,`/reports/export/member-statement?memberId=${f.members[0]!.id}`).expect(404);const pack=(await get(g,'/reports/board-pack').expect(200)).body;expect(pack.savings.totalBalanceDecimal).toBe('1.15');});
});
