import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reportMoney,reportSum} from '../src/lib/report-money.ts';
test('report displays preserve huge positive and negative decimals',()=>{
 assert.equal(reportMoney('90071992547409.91'),'₦90,071,992,547,409.91');
 assert.equal(reportMoney('-199999999999999999.98'),'-₦199,999,999,999,999,999.98');
 assert.equal(reportMoney('0'),'₦0.00');assert.equal(reportMoney('1e9'),'—');
});

test('report strip totals use integer kobo',()=>{assert.equal(reportSum(['90071992547409.91','0.01']),'90071992547409.92');assert.equal(reportSum(['99999999999999999.99','99999999999999999.99']),'199999999999999999.98');assert.equal(reportSum([]),'0.00');});
