import {describe,expect,it} from 'vitest';
import {allocateDividends} from '../src/dividends/dividend-allocation';
import {moneyDecimal} from '../src/common/money';
import {DividendPostDto} from '../src/dividends/dividends.controller';
import {validate} from 'class-validator';
describe('exact dividend allocation and explicit year',()=>{
 it('preserves 3:1 proportions exactly',()=>{const r=allocateDividends(1.15,['3.00','1.00']);expect(r.amounts.map(moneyDecimal)).toEqual(['0.86','0.29']);});
 it('preserves the existing first-largest half-up drift rule',()=>{expect(allocateDividends(0.01,['1.00','1.00']).amounts).toEqual([0n,1n]);});
 it('refuses drift that would make an allocation negative',()=>{expect(()=>allocateDividends(0.05,Array(9).fill('1.00'))).toThrow(/negative allocation/);});
 it('retains large stored share precision',()=>{const r=allocateDividends(100000000000,['90000000000000000.01','1.15']);expect(r.amounts.reduce((a,b)=>a+b,0n)).toBe(10000000000000n);expect(r.totalShares).toBe(9000000000000000116n);});
 it('aggregates share weights beyond a single account column limit',()=>{const r=allocateDividends(1.15,['90000000000000000.01','90000000000000000.01']);expect(r.totalShares).toBe(18000000000000000002n);expect(r.amounts).toEqual([57n,58n]);});
 it('conserves every accepted allocation over a broad exact input matrix',()=>{let accepted=0,refused=0;for(let n=1;n<=12;n++)for(let k=1;k<=100;k++)for(const equal of [false,true]){try{const r=allocateDividends(k/100,Array.from({length:n},(_,i)=>moneyDecimal(BigInt(equal?1:i+1))));expect(r.amounts.every(a=>a>=0n)).toBe(true);expect(r.amounts.reduce((a,b)=>a+b,0n)).toBe(BigInt(k));accepted++;}catch(err){expect(String(err)).toMatch(/negative allocation/);refused++;}}expect(accepted).toBeGreaterThan(1000);expect(refused).toBeGreaterThan(0);});
 it.each([0,-1,1.001,NaN,Infinity,100000000001])('refuses invalid amount %s',amount=>{expect(()=>allocateDividends(amount,['1.00'])).toThrow();});
 it.each([undefined,null,'','2026\n','2026 ','26','20260',2026,{}])('requires strict explicit four-digit year %j',async periodLabel=>{const dto=Object.assign(new DividendPostDto(),{periodLabel,distributableAmount:1});expect((await validate(dto,{skipMissingProperties:true})).length).toBeGreaterThan(0);});
 it('accepts a valid explicit year',async()=>{expect(await validate(Object.assign(new DividendPostDto(),{periodLabel:'2026',distributableAmount:0.01}))).toEqual([]);});
});
