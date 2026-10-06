import { describe, expect, it } from 'vitest';
import { assertFinancialScope } from '../src/common/financial-scope';
describe('financial request account binding',()=>{
 it('accepts the current scope and preserves headerless API compatibility',()=>{
  expect(()=>assertFinancialScope({},'org-a','actor-a')).not.toThrow();
  expect(()=>assertFinancialScope({'x-coopengine-financial-scope':'org-a:actor-a'},'org-a','actor-a')).not.toThrow();
 });
 it('refuses malformed, repeated, different tenant and different actor scopes',()=>{
  for(const scope of ['', ['org-a:actor-a'], 'org-b:actor-a','org-a:actor-b']) expect(()=>assertFinancialScope({'x-coopengine-financial-scope':scope},'org-a','actor-a')).toThrow(/another account or cooperative/);
 });
});
