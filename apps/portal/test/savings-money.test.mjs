import {test} from 'node:test';
import assert from 'node:assert/strict';
import {savingsAmount} from '../src/lib/savings-money.ts';
test('staff savings input preserves cents across the existing API range',()=>{assert.equal(savingsAmount('0.01'),0.01);assert.equal(savingsAmount('100.23'),100.23);assert.equal(savingsAmount('100000000000.00'),100000000000);});
test('staff savings input refuses sub-cent precision, nondecimal and out-of-range amounts',()=>{for(const text of ['0','-1','1e3','0.001','1.234','NaN','100000000000.01','90071992547409.92'])assert.throws(()=>savingsAmount(text));});
