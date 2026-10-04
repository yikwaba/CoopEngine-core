import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { apiResponse, STEP_UP_EVENT } from '../src/lib/api.ts';
const originalFetch=globalThis.fetch;
beforeEach(()=>{globalThis.window={location:{pathname:'/withdrawals',href:'/withdrawals'},dispatchEvent:event=>{assert.equal(event.type,STEP_UP_EVENT);event.detail.resolve('123456');}};});
afterEach(()=>{globalThis.fetch=originalFetch;delete globalThis.window;});
test('pre-operation refusal retries once with cookies and unchanged payload',async()=>{
 const calls=[];globalThis.fetch=async(url,init)=>{calls.push({url,init});return calls.length===1?Response.json({code:'STEP_UP_REQUIRED',message:'Verify'},{status:403}):Response.json({threshold:0});};
 assert.equal((await apiResponse('/savings/settings/withdrawal-approval',{method:'PATCH',body:'{"threshold":0}',headers:{'Content-Type':'application/json'}})).status,200);
 assert.equal(calls.length,2);assert.equal(calls[1].url,calls[0].url);assert.equal(calls[1].init.body,calls[0].init.body);assert.equal(calls[1].init.method,'PATCH');
 assert.equal(calls[1].init.credentials,'include');assert.equal(calls[1].init.cache,'no-store');assert.equal(new Headers(calls[1].init.headers).get('X-CoopEngine-Step-Up'),'123456');
});
test('cancel never retries a mutation',async()=>{let count=0;window.dispatchEvent=event=>event.detail.resolve(null);globalThis.fetch=async()=>{count++;return Response.json({code:'STEP_UP_REQUIRED'},{status:403});};assert.equal((await apiResponse('/savings/accounts/x/withdrawals',{method:'POST',body:'{}'})).status,403);assert.equal(count,1);});
for(const [status,code] of [[403,'STEP_UP_INVALID'],[403,'STEP_UP_ENROLLMENT_REQUIRED'],[403,'FORBIDDEN'],[429,'STEP_UP_RATE_LIMITED'],[500,'STEP_UP_REQUIRED']]){
 test(`${status} ${code} never retries`,async()=>{let count=0;window.dispatchEvent=()=>{throw new Error('Unexpected prompt');};globalThis.fetch=async()=>{count++;return Response.json({code},{status});};assert.equal((await apiResponse('/savings/withdrawals/x/approve',{method:'POST',body:'{}'})).status,status);assert.equal(count,1);});
}
test('verification retry refusal never repeats the prompt',async()=>{let count=0;globalThis.fetch=async()=>{count++;return Response.json({code:'STEP_UP_REQUIRED'},{status:403});};assert.equal((await apiResponse('/loans/x/disburse',{method:'POST',body:'{}'})).status,403);assert.equal(count,2);});
