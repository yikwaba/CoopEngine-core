import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import * as staff from '../src/lib/api.ts';
import * as member from '../../member-pwa/src/lib/api.ts';
const originalFetch=globalThis.fetch;
let scope='org-a:actor-a';
function setFetch(handler){globalThis.fetch=async(url,options)=>String(url).endsWith('/auth/me')||String(url).endsWith('/member/me')?Response.json({financialScope:scope}):handler(url,options);}

const memory=()=>{const values=new Map();return {getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k),key:i=>Array.from(values.keys())[i]??null,get length(){return values.size}};};
beforeEach(()=>{scope='org-a:actor-a';globalThis.window={location:{pathname:'/front-desk'}};globalThis.localStorage=memory();globalThis.sessionStorage=memory();localStorage.setItem(staff.USER_KEY,'{"email":"staff@example.invalid"}');localStorage.setItem(staff.SESSION_MARKER,'cookie');localStorage.setItem(member.MEMBER_INFO_KEY,'{"id":"member-a"}');localStorage.setItem(member.MEMBER_SESSION_MARKER,'cookie');});
afterEach(()=>{globalThis.fetch=originalFetch;delete globalThis.window;delete globalThis.localStorage;delete globalThis.sessionStorage;});
for(const [name,api,path] of [['staff',staff,'/savings/accounts/synthetic/deposits'],['member',member,'/member/withdrawals/request']]){
 const init={method:'POST',body:JSON.stringify({amount:5})};
 test(`${name}: response loss and reload reuse one key; acknowledged success allows a new payment`,async()=>{
  const keys=[];let calls=0;setFetch(async(_url,options)=>{keys.push(JSON.parse(options.body).idempotencyKey);if(++calls===1)throw new TypeError('response lost after commit');return Response.json({recorded:5});});
  await assert.rejects(api.apiFetch(path,undefined,init),/response lost/);assert.deepEqual(await api.apiFetch(path,undefined,{...init}),{recorded:5});assert.equal(keys[0],keys[1]);await api.apiFetch(path,undefined,init);assert.notEqual(keys[2],keys[0]);
 });
 test(`${name}: changed details cannot silently replace an unresolved intent`,async()=>{
  let calls=0;setFetch(async()=>{calls++;throw new TypeError('network failed');});await assert.rejects(api.apiFetch(path,undefined,init));await assert.rejects(api.apiFetch(path,undefined,{...init,body:'{"amount":6}'}),/uncertain result/);assert.equal(calls,1);
 });
 test(`${name}: a malformed successful response retains the original key`,async()=>{
  const keys=[];setFetch(async(_url,options)=>{keys.push(JSON.parse(options.body).idempotencyKey);return keys.length===1?new Response('{',{status:200}):Response.json({recorded:5});});await assert.rejects(api.apiFetch(path,undefined,init));await api.apiFetch(path,undefined,init);assert.equal(keys[0],keys[1]);
 });
 test(`${name}: concurrent duplicate submissions retain one key`,async()=>{
  const keys=[];setFetch(async(_url,options)=>{keys.push(JSON.parse(options.body).idempotencyKey);await Promise.resolve();return Response.json({recorded:5});});await Promise.all([api.apiFetch(path,undefined,init),api.apiFetch(path,undefined,init)]);assert.equal(keys[0],keys[1]);
 });
 test(`${name}: definitive validation refusal allows corrected details`,async()=>{
  let calls=0;setFetch(async()=>++calls===1?Response.json({message:'Invalid amount'},{status:400}):Response.json({recorded:6}));await assert.rejects(api.apiFetch(path,undefined,init),/Invalid amount/);assert.deepEqual(await api.apiFetch(path,undefined,{...init,body:'{"amount":6}'}),{recorded:6});
 });
 test(`${name}: caller supplied keys are preserved`,async()=>{
  const key='explicit-key-123456789';setFetch(async(_url,options)=>{assert.equal(JSON.parse(options.body).idempotencyKey,key);return Response.json({recorded:5});});await api.apiFetch(path,undefined,{...init,body:JSON.stringify({amount:5,idempotencyKey:key})});
 });
}

test('approval timeout and refreshed next step retry the original step; acknowledgement permits the next',async()=>{
 const bodies=[];setFetch(async(_url,options)=>{bodies.push(JSON.parse(options.body));if(bodies.length===1)throw new TypeError('lost response');return Response.json({approvalStatus:'PENDING',currentStep:2});});
 const path='/savings/withdrawals/synthetic/approve',send=step=>staff.apiFetch(path,undefined,{method:'POST',body:JSON.stringify({expectedStepNo:step})});
 await assert.rejects(send(1),/lost response/);await send(2);assert.deepEqual(bodies,[{expectedStepNo:1},{expectedStepNo:1}]);await send(2);assert.deepEqual(bodies[2],{expectedStepNo:2});
});
test('generic approval decision freezes its original step but refuses changed unresolved decision',async()=>{
 const bodies=[];setFetch(async(_url,options)=>{bodies.push(JSON.parse(options.body));throw new TypeError('timeout');});const path='/approvals/requests/synthetic/decisions';const send=body=>staff.apiFetch(path,undefined,{method:'POST',body:JSON.stringify(body)});
 await assert.rejects(send({decision:'APPROVE',expectedStepNo:1}));await assert.rejects(send({decision:'REJECT',expectedStepNo:2}),/uncertain result/);await assert.rejects(send({decision:'APPROVE',expectedStepNo:2}));assert.deepEqual(bodies,[{decision:'APPROVE',expectedStepNo:1},{decision:'APPROVE',expectedStepNo:1}]);
});
for(const path of ['/loans/synthetic/disburse','/payroll/batches/synthetic/reverse','/ledger/journals/synthetic/reverse','/approvals/payroll/synthetic/reject','/approvals/journals/synthetic/approve']){
 test(`natural entity operation ${path} keeps the original body through response loss`,async()=>{
  let calls=0;const body={reason:'Synthetic correction'};setFetch(async(_url,options)=>{calls++;assert.deepEqual(JSON.parse(options.body),body);if(calls===1)throw new TypeError('lost response');return Response.json({done:true});});
  const send=details=>staff.apiFetch(path,undefined,{method:'POST',body:JSON.stringify(details)});await assert.rejects(send(body));await assert.rejects(send({reason:'Changed'}),/uncertain result/);await send(body);assert.equal(calls,2);
 });
}

for(const [name,api,path] of [['staff',staff,'/savings/accounts/synthetic/deposits'],['member',member,'/member/withdrawals/request']]) {
 const init={method:'POST',body:JSON.stringify({amount:5})};
 test(`${name}: recovery sends the original body/key and server-verified scope`,async()=>{
  const sent=[];setFetch(async(_url,options)=>{sent.push({body:JSON.parse(options.body),scope:options.headers['X-CoopEngine-Financial-Scope']});if(sent.length===1)throw new TypeError('lost response');return Response.json({recorded:5});});
  await assert.rejects(api.apiFetch(path,undefined,init));const pending=api.pendingFinancialWrites();assert.equal(pending.length,1);
  await api.recoverFinancialWrite(pending[0].storageKey);assert.deepEqual(sent[0],sent[1]);assert.equal(sent[1].scope,scope);assert.equal(api.pendingFinancialWrites().length,0);
 });
 test(`${name}: account/cooperative change blocks recovery without sending a write`,async()=>{
  let calls=0;setFetch(async()=>{calls++;throw new TypeError('lost response');});await assert.rejects(api.apiFetch(path,undefined,init));scope='org-b:actor-b';await assert.rejects(api.recoverFinancialWrite(api.pendingFinancialWrites()[0].storageKey),/another account or cooperative/);assert.equal(calls,1);assert.equal(api.pendingFinancialWrites().length,1);
 });
 test(`${name}: permission/not-found/validation refusals after an uncertain result retain the original request`,async()=>{
  setFetch(async()=>{throw new TypeError('lost response');});await assert.rejects(api.apiFetch(path,undefined,init));const key=api.pendingFinancialWrites()[0].key;
  for(const status of [400,401,403,404,409,422,500]) {
   if(status===401) continue; // tested separately because sign-out hides the panel
   setFetch(async()=>Response.json({message:'Refused'},{status}));await assert.rejects(api.apiFetch(path,undefined,init));assert.equal(api.pendingFinancialWrites()[0].key,key);
  }
 });
 test(`${name}: legacy unbound requests are retained and cannot be replayed`,async()=>{
  const identity=localStorage.getItem(name==='staff'?staff.USER_KEY:member.MEMBER_INFO_KEY),storageKey='coopengine-payment:'+identity+':'+path;
  sessionStorage.setItem(storageKey,JSON.stringify({key:'legacy-key-123456789',payload:init.body}));let calls=0;setFetch(async()=>{calls++;return Response.json({});});await assert.rejects(api.recoverFinancialWrite(storageKey),/older request/);assert.equal(calls,0);assert.equal(api.pendingFinancialWrites().length,1);
 });
 test(`${name}: fast acknowledgement cannot give a concurrent submission a new key`,async()=>{
  let release;const gate=new Promise(resolve=>release=resolve);let lookups=0;const keys=[];
  globalThis.fetch=async(url,options)=>{if(String(url).endsWith('/me')){if(++lookups===2)await gate;return Response.json({financialScope:scope});}keys.push(JSON.parse(options.body).idempotencyKey);return Response.json({recorded:5});};
  const first=api.apiFetch(path,undefined,init),second=api.apiFetch(path,undefined,init);await first;release();await second;assert.equal(keys[0],keys[1]);
 });
}

for(const [name,api,path] of [['staff',staff,'/savings/accounts/synthetic/deposits'],['member',member,'/member/withdrawals/request']]) {
 test(`${name}: empty or non-object financial responses retain the key for recovery`,async()=>{
  const init={method:'POST',body:'{"amount":5}'};let key;
  for(const body of ['', 'null','"unexpected"']) {
   setFetch(async(_url,options)=>{const next=JSON.parse(options.body).idempotencyKey;key??=next;assert.equal(next,key);return new Response(body,{status:200});});
   await assert.rejects(api.apiFetch(path,undefined,init),/financial response/);assert.equal(api.pendingFinancialWrites().length,1);
  }
 });
 test(`${name}: sign-out hides but retains a pending request; the original sign-in can recover`,async()=>{
  setFetch(async()=>{throw new TypeError('lost response');});await assert.rejects(api.apiFetch(path,undefined,{method:'POST',body:'{"amount":5}'}));
  const old=api.pendingFinancialWrites()[0],identityKey=name==='staff'?staff.USER_KEY:member.MEMBER_INFO_KEY,marker=name==='staff'?staff.SESSION_MARKER:member.MEMBER_SESSION_MARKER,identity=localStorage.getItem(identityKey);
  name==='staff'?staff.clearSession():member.clearMemberSession();assert.equal(api.pendingFinancialWrites().length,0);assert.ok(sessionStorage.getItem(old.storageKey));
  localStorage.setItem(identityKey,identity);localStorage.setItem(marker,'cookie');setFetch(async()=>Response.json({recorded:5}));await api.recoverFinancialWrite(old.storageKey);assert.equal(api.pendingFinancialWrites().length,0);
 });
}
