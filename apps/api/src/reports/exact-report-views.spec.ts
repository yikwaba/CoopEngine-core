import 'reflect-metadata';
import {describe,it,expect,vi} from 'vitest';
import {Pool} from 'pg';
import {ReportsService} from './reports.service';
import {AdminService} from '../admin/admin.service';
import {PlansService} from '../admin/plans.service';
import {LoansService} from '../loans/loans.service';
import {PdfService} from '../pdf/pdf.service';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
vi.mock('@coopengine/db',()=>({withTenant:async(pool:unknown,_org:unknown,fn:(c:unknown)=>unknown)=>fn(pool)}));
const huge='90071992547409.91',max='99999999999999999.99';
function mock(rows:unknown[][]):Pool{let i=0;return {query:async()=>({rows:rows[i++]??[]})} as unknown as Pool;}
function service(rows:unknown[][]){return new ReportsService(mock(rows));}
describe('reports consume exact SQL money',()=>{
 it('sums savings and member balances exactly',async()=>{
  const row={member_id:'m',member_no:1,current_balance:huge};
  expect((await service([[row,{...row,current_balance:'0.01'}]]).savingsBook('org')).totalBalanceDecimal).toBe('90071992547409.92');
  const r=await service([[{id:'m'}],[row,{...row,current_balance:'0.01'}],[{current_balance:huge}],[{principal:max,outstanding_principal:max},{principal:max,outstanding_principal:max}]]).member360('org','m');expect(r.savingsTotalDecimal).toBe('90071992547409.92');expect(r.shareBalanceDecimal).toBe(huge);expect(r.loansOutstandingTotalDecimal).toBe('199999999999999999.98');
 });
 it('preserves loan books and aging buckets above column capacity',async()=>{
  const rows=[{principal:max,outstanding_principal:max,outstanding:max},{principal:max,outstanding_principal:max,outstanding:max}];
  expect((await service([rows]).loanBook('org')).outstandingTotalDecimal).toBe('199999999999999999.98');expect((await service([rows]).loansAging('org')).buckets[0]?.outstandingDecimal).toBe('199999999999999999.98');
 });
 it('preserves contribution, payout and SQL-rounded interest sums',async()=>{
  expect((await service([[{contributed:huge},{contributed:'0.01'}]]).contributionSchedule('org')).totalContributedDecimal).toBe('90071992547409.92');expect((await service([[{payout:huge},{payout:'0.01'}]]).exitedMembers('org')).totalPaidOutDecimal).toBe('90071992547409.92');
  const r=await service([[{balance:huge,monthly_estimate:huge},{balance:'0.01',monthly_estimate:'0.01'}]]).savingsInterestPreview('org');expect(r.totalBalanceDecimal).toBe('90071992547409.92');expect(r.totalMonthlyEstimateDecimal).toBe('90071992547409.92');
 });
 it('retains signed statement digits in CSV',async()=>{
  const r=service([[{id:'m',member_no:1,name:'Synthetic'}],[{type:'WITHDRAWAL',signed_amount:'-'+huge,created_at:new Date()}],[{type:'REDEMPTION',signed_amount:'-'+huge,created_at:new Date()}],[{seq:1,paid_amount:huge,due_date:'2026-10-01',status:'PAID'}],[{period_label:'2026',amount:huge}]]);const csv=await r.exportCsv('org','member-statement','m');expect(csv).toContain('-90071992547409.91');expect(csv).toContain(',90071992547409.91');
 });
 it('sums portfolio totals and retains month decimals',async()=>{
  const month=new Date().toISOString().slice(0,7),rows=[{outstanding:max,par30:max,par90:max},{outstanding:max,par30:max,par90:max}];const r=await service([[{month,total:huge}],[{month,total:huge}],rows]).portfolioAnalytics('org',1);expect(r.months[0]?.disbursedDecimal).toBe(huge);expect(r.months[0]?.collectedDecimal).toBe(huge);expect(r.totals.par90Decimal).toBe('199999999999999999.98');
 });
 it('detects one-kobo reconciliation differences',async()=>{const r=await service([[{projected:huge,ledger:'90071992547409.90',member_no:1}]]).savingsReconciliation('org');expect(r.mismatches[0]?.diffDecimal).toBe('0.01');expect(r.matched).toBe(0);});
});
describe('other financial report aggregates',()=>{
 it('preserves arrears buckets and total as decimal strings',async()=>{
  const r=await new LoansService(mock([[{amount:max,days_late:1},{amount:max,days_late:2}]])).arrears('org');expect(r.totalDecimal).toBe('199999999999999999.98');expect(r.buckets[0]?.amountDecimal).toBe(r.totalDecimal);
 });
 it('preserves platform overview across large tenant totals',async()=>{
  const admin=new AdminService({} as Pool,{list:async()=>[]} as unknown as PlansService);
  Object.assign(admin,{organizations:async()=>[{id:'a',status:'ACTIVE'},{id:'b',status:'ACTIVE'}],withScan:async()=>[],stats:async()=>({members:1,savingsBalance:max,loansOutstanding:max})});
  const r=await admin.overview();expect(r.savingsBalance).toBe('199999999999999999.98');expect(r.loansOutstanding).toBe(r.savingsBalance);expect(r.members).toBe(2);
 });
});
describe('actual PDF render fixtures',()=>{
 async function save(name:string,buffer:Buffer){expect(buffer.subarray(0,5).toString()).toBe('%PDF-');expect(buffer.length).toBeGreaterThan(1000);const output=process.env.COOPENGINE_PDF_QA_DIR;if(output){await mkdir(output,{recursive:true});await writeFile(join(output,name),buffer);}}
 const org=[{name:'SYNTHETIC QA'}],member={member_no:1,first_name:'Exact',last_name:'Synthetic',status:'ACTIVE'};
 it('renders large member opening and closing balances',async()=>{const r=await new PdfService(mock([[member],[{id:'a',account_no:'1',current_balance:'90071992547409.92'}],[{type:'DEPOSIT',signed_amount:'0.01',running_balance:'90071992547409.92',created_at:new Date(),description:'Exact synthetic deposit'}],org])).memberStatement('org','m');await save('member-statement.pdf',r.buffer);});
 it('renders exact loan paid sums',async()=>{const r=await new PdfService(mock([[{...member,principal:huge,outstanding_principal:huge,interest_rate_pa:'12',term_months:1,interest_method:'FLAT',status:'DISBURSED'}],[{seq:1,due_date:new Date(),principal_due:huge,interest_due:'0.01',paid_principal:huge,paid_interest:'0.01'}],org])).loanStatement('org','l');await save('loan-statement.pdf',r.buffer);});
 it('renders unbounded aggregate board figures',async()=>{const r=await new PdfService(mock([[{status:'ACTIVE',n:1}],[{total:'199999999999999999.98',accounts:2}],[{total:huge}],[{total:huge,live:1}],[{b1:0,b2:0,b3:0,b4:0}],[{total:huge}],[{net:'0.00'}],[{status:'OPEN'}],org])).boardPack('org','2026-10');await save('board-pack.pdf',r.buffer);});
 it('renders exact receipt balances',async()=>{const r=await new PdfService(mock([[{...member,signed_amount:huge,running_balance:'90071992547409.92',type:'DEPOSIT',created_at:new Date(),account_no:'1',description:'Exact synthetic receipt'}],org])).receipt('org','12345678');await save('receipt.pdf',r.buffer);});
});
