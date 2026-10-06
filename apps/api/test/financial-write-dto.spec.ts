import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { FinancialWriteDto } from '../src/common/dto/financial-write.dto';
describe('mandatory external financial key',()=>{
 it.each([undefined,null,'','short',' '.repeat(16),123,[],{},'x'.repeat(101),'pay:'+randomUUID(),'withdrawal-request:'+randomUUID()])('rejects missing/malformed/reserved key %# even when missing properties are skipped',async key=>{
  const dto=Object.assign(new FinancialWriteDto(),{idempotencyKey:key});
  expect((await validate(dto,{skipMissingProperties:true})).some(error=>error.property==='idempotencyKey')).toBe(true);
 });
 it.each([randomUUID(),'x'.repeat(16),'x'.repeat(100),'client:manual:original-intent'])('accepts valid retained client key %#',async idempotencyKey=>{
  expect(await validate(Object.assign(new FinancialWriteDto(),{idempotencyKey}))).toEqual([]);
 });
});
