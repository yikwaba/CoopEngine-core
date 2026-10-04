import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { validateStaging } from './guard.mjs';
validateStaging(process.env);
const apiRequire=createRequire(new URL('../../apps/api/package.json',import.meta.url));
const {flatLoanInstallments,moneyKobo,moneyDecimal}=apiRequire('./dist/common/money.js');
const {Client}=apiRequire('pg');
const db=new Client({connectionString:process.env.DATABASE_URL});
await db.connect();let cases=0;
try{
 await db.query('BEGIN READ ONLY');
 for(const principal of ['1.15','17.29','100000000000.00','90071992547409.91'])for(const rate of ['0','15','12.5','13.3333'])for(const months of [1,3,5,12,60]){
  const rows=flatLoanInstallments(principal,rate,months);
  const oracle=(await db.query('SELECT $1::numeric(19,2)::text AS principal,round($1::numeric*$2::numeric*$3::integer/1200,2)::text AS interest',[principal,rate,months])).rows[0];
  assert.equal(moneyDecimal(rows.reduce((sum,row)=>sum+moneyKobo(row.principal),0n)),oracle.principal,'Loan principal conservation');
  assert.equal(moneyDecimal(rows.reduce((sum,row)=>sum+moneyKobo(row.interest),0n)),oracle.interest,'PostgreSQL numeric interest agreement');cases++;
 }
 const thirds=flatLoanInstallments('1.15','0',5);
 assert.ok(thirds.every(row=>row.principal==='0.23'),'23-kobo installment regression');
 await db.query('ROLLBACK');
 console.log(`PASS: ${cases} compiled exact-loan calculations agree with PostgreSQL numeric rounding and conserve principal/interest. Read-only; no financial writes or provider calls.`);
}finally{await db.end();}
