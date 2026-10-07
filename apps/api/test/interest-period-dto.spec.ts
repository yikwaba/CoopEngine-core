import 'reflect-metadata';
import {validate} from 'class-validator';
import {describe,expect,it} from 'vitest';
import {InterestPeriodDto} from '../src/savings/savings.controller';
describe('explicit interest posting period',()=>{
 it.each([undefined,null,'','2026','2026-00','2026-13','2026-1','26-10','2026-10 ','2026-10-01','2026-10\n',202610,{},true])('refuses invalid or omitted month %j',async period=>{
  const dto=Object.assign(new InterestPeriodDto(),{period});expect((await validate(dto,{skipMissingProperties:true})).length).toBeGreaterThan(0);
 });
 it.each(['2026-01','2026-12'])('accepts explicit month %s',async period=>{expect(await validate(Object.assign(new InterestPeriodDto(),{period}))).toEqual([]);});
});
