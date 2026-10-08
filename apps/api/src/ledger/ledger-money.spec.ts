import 'reflect-metadata';
import {describe,it,expect} from 'vitest';
import {plainToInstance} from 'class-transformer';
import {validateSync} from 'class-validator';
import {Pool} from 'pg';
import {ledgerKobo,ledgerDecimal,JournalAmountValidator} from './ledger-money';
import {JournalLineDto} from './dto/ledger.dto';
import {LedgerService} from './ledger.service';
describe('exact manual ledger arithmetic',()=>{
 const validator=new JournalAmountValidator();
 it.each([0.01,0.1,100000000000,'0.01','90071992547409.91','99999999999999999.99'])('accepts bounded positive amount %s',value=>{
  expect(validator.validate(value)).toBe(true);
  expect(validateSync(plainToInstance(JournalLineDto,{accountCode:'1000',debit:value}))).toEqual([]);
 });
 it.each([0,-1,NaN,Infinity,100000000000.01,'0','-0.01','1.001','1e3',' 1.00','100000000000000000.00',{},true])('rejects invalid amount %s',value=>{
  expect(validator.validate(value)).toBe(false);
  expect(validateSync(plainToInstance(JournalLineDto,{accountCode:'1000',debit:value})).length).toBeGreaterThan(0);
 });
 it('formats signed aggregate sums beyond one column range without rounding',()=>{
  const max=ledgerKobo('99999999999999999.99');
  expect(ledgerDecimal(max*2n)).toBe('199999999999999999.98');
  expect(ledgerDecimal(-max*2n)).toBe('-199999999999999999.98');
  expect(ledgerDecimal(max-max+1n)).toBe('0.01');
 });
 it.each(['1.001','1e3','','NaN',' 1'])('rejects malformed SQL decimal %s',value=>expect(()=>ledgerKobo(value)).toThrow());
 const service=new LedgerService({} as Pool);
 const check=(lines:unknown[]) => (service as unknown as {validateLines:(lines:unknown[])=>{debit:bigint;credit:bigint}[]}).validateLines(lines);
 const line=(debit:unknown)=>({accountCode:'1000',debit});
 const credit=(credit:unknown)=>({accountCode:'2000',credit});
 it('balances fractional numeric inputs in kobo',()=>expect(check([line(0.1),line(0.2),credit(0.3)]).map(l=>l.debit)).toEqual([10n,20n,0n]));
 it('balances maximum column values with an aggregate exceeding column capacity',()=>{
  const max='99999999999999999.99';
  expect(()=>check([line(max),line(max),credit(max),credit(max)])).not.toThrow();
 });
 it('rejects a one-kobo imbalance above safe numeric precision',()=>expect(()=>check([line('90071992547409.91'),line('0.01'),credit('90071992547409.91')])).toThrow('Unbalanced journal'));
 it('preserves a huge exact balanced amount',()=>expect(check([line('90071992547409.91'),line('0.01'),credit('90071992547409.92')])[2]?.credit).toBe(9007199254740992n));
 it('rejects both sides, no side, zero and negative values',()=>{
  for(const value of [{debit:1,credit:1},{},{debit:0},{debit:-1}]) expect(()=>check([{accountCode:'1000',...value}])).toThrow();
 });
});
