import 'reflect-metadata';
import {describe,it,expect} from 'vitest';
import {reportDecimal,reportSum,reportMoney} from './report-money';
import {money} from '../pdf/pdf.service';
describe('exact financial report formatting',()=>{
 it('preserves signed huge decimal values and unbounded sums',()=>{
  expect(reportDecimal('90071992547409.91')).toBe('90071992547409.91');
  expect(reportSum([{v:'99999999999999999.99'},{v:'99999999999999999.99'}],'v')).toBe('199999999999999999.98');
  expect(reportSum([{v:'90071992547409.91'},{v:'-90071992547409.90'}],'v')).toBe('0.01');
 });
 it.each(['1.001','NaN','1e9',' 1.00'])('refuses malformed or overprecision monetary source %s',v=>expect(()=>reportDecimal(v)).toThrow());
 it('formats digits without narrowing through Number',()=>{
  expect(reportMoney('90071992547409.91')).toBe('₦90,071,992,547,409.91');
  expect(money('-199999999999999999.98')).toBe('-₦199,999,999,999,999,999.98');
  expect(money(null)).toBe('₦0.00');expect(money(NaN)).toBe('₦0.00');
 });
 it('handles empty sums and negative zero canonically',()=>{
  expect(reportSum([],'value' as never)).toBe('0.00');expect(reportDecimal('-0.00')).toBe('0.00');
 });
});
