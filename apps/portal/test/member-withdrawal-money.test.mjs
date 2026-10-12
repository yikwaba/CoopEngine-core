import {test} from 'node:test';
import assert from 'node:assert/strict';
import {memberMoney,withdrawalAmount} from '../../member-pwa/src/lib/withdrawal-money.ts';
test('member money preserves every digit of large database decimals',()=>assert.equal(memberMoney('90071992547409.92'),'₦90,071,992,547,409.92'));
test('member money preserves signed movement decimals',()=>assert.equal(memberMoney('-1.01'),'-₦1.01'));
test('member money does not format malformed values as zero',()=>assert.equal(memberMoney('NaN'),'—'));
test('withdrawal form preserves allowed cents and existing numeric bound',()=>{assert.equal(withdrawalAmount('1.01'),1.01);assert.equal(withdrawalAmount('100000000000.00'),100000000000);});
test('withdrawal form rejects amounts below the member minimum',()=>{for(const v of ['0','0.99','-1'])assert.throws(()=>withdrawalAmount(v));});
test('withdrawal form refuses precision loss and nondecimal spellings',()=>{for(const v of ['1.001','1e3','Infinity','100000000000.01','90071992547409.92'])assert.throws(()=>withdrawalAmount(v));});
