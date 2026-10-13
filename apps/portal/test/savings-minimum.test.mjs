import {test} from 'node:test';import assert from 'node:assert/strict';
import {savingsMinimum} from '../src/lib/savings-minimum.ts';
test('minimum deposit allows zero and exact boundary cents',()=>{assert.equal(savingsMinimum('0.00'),0);assert.equal(savingsMinimum('100.23'),100.23);assert.equal(savingsMinimum('90071992547409.92'),90071992547409.92);});
test('minimum deposit refuses negative, overprecision and nondecimal spellings',()=>{for(const v of ['-1','0.001','1e3','NaN','Infinity'])assert.throws(()=>savingsMinimum(v));});
test('minimum deposit refuses numeric-serialization and database-range loss',()=>{for(const v of ['99999999999999999.99','90071992547409999.00','100000000000000000.00'])assert.throws(()=>savingsMinimum(v));});
