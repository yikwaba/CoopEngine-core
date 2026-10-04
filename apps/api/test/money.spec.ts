import { describe, expect, it } from 'vitest';
import { flatLoanInstallments, loanCeiling, moneyDecimal, moneyKobo } from '../src/common/money';
describe('integer kobo loan calculations',()=>{
 it('parses and formats exact NUMERIC(19,2) values without losing kobo',()=>{
  for(const value of ['0.00','0.01','1.15','99999999999999999.99','-99999999999999999.99']) expect(moneyDecimal(moneyKobo(value))).toBe(value);
  expect(moneyKobo(1.15)).toBe(115n);expect(moneyKobo(-0)).toBe(0n);
 });
 it.each(['1.005','NaN','Infinity','1e3','1,000',' 1.00','+1.00','100000000000000000.00',''])('rejects ambiguous, over-precision or overflowing money: %s',value=>{expect(()=>moneyKobo(value)).toThrow();});
 it('rejects unsafe/unbounded JSON numbers rather than silently rounding them',()=>{
  for(const value of [NaN,Infinity,100_000_000_000.01,Number.MAX_SAFE_INTEGER])expect(()=>moneyKobo(value)).toThrow();
 });
 it('fixes the 1.15/5 floating-point floor defect: every installment is 23 kobo',()=>{
  expect(flatLoanInstallments('1.15','0',5)).toEqual(Array.from({length:5},()=>({principal:'0.23',interest:'0.00'})));
 });
 it.each([
  ['50000.00','15',12,'7500.00'],['50000.00','12.5',12,'6250.00'],
  ['17.29','15',12,'2.59'],['1.00','12.5',3,'0.03'],
  ['0.40','15',1,'0.01'],['100000000000.00','12.3456',60,'61728000000.00'],
 ])('conserves principal and independently specified total interest for %s at %s over %s months', (principal,rate,months,expectedInterest)=>{
  const schedule=flatLoanInstallments(principal,rate,Number(months));
  expect(schedule.reduce((sum,row)=>sum+moneyKobo(row.principal),0n)).toBe(moneyKobo(principal));
  expect(schedule.reduce((sum,row)=>sum+moneyKobo(row.interest),0n)).toBe(moneyKobo(expectedInterest));
 });
 it('puts only the final kobo remainder in the last installment',()=>{
  expect(flatLoanInstallments('1.00','15',3)).toEqual([
   {principal:'0.33',interest:'0.01'},{principal:'0.33',interest:'0.01'},{principal:'0.34',interest:'0.02'},
  ]);
 });
 it('conserves tiny, large and fractional principals across every supported tenor',()=>{
  for(const principal of ['0.01','1.15','100000000000.00','90071992547409.91'])for(let months=1;months<=60;months++){
   const rows=flatLoanInstallments(principal,'0',months);
   expect(rows.reduce((sum,row)=>sum+moneyKobo(row.principal),0n)).toBe(moneyKobo(principal));
   expect(rows.every(row=>moneyKobo(row.principal)>=0n&&moneyKobo(row.interest)===0n)).toBe(true);
  }
 });
 it('computes 3x/fractional savings limits using exact cents and half-up ties',()=>{
  expect(loanCeiling('0.35','3.00')).toBe(105n);
  expect(loanCeiling('1.15','3.00')).toBe(345n);
  expect(loanCeiling('0.01','2.50')).toBe(3n);
  expect(loanCeiling('90071992547409.91','1.00')).toBe(9007199254740991n);
 });
 it('rejects unsupported rates/terms and overflowing interest before writing rows',()=>{
  for(const term of [0,61,1.5])expect(()=>flatLoanInstallments('1.00','15',term)).toThrow();
  for(const rate of ['-1','1.23456','1000','1e1'])expect(()=>flatLoanInstallments('1.00',rate,12)).toThrow();
  expect(()=>flatLoanInstallments('99999999999999999.99','999.9999',60)).toThrow();
 });
});
