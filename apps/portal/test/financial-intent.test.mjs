import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import * as staff from '../src/lib/api.ts';
import * as member from '../../member-pwa/src/lib/api.ts';
const originalFetch=globalThis.fetch;
let scope='org-a:actor-a';
function setFetch(handler){globalThis.fetch=async(url,options)=>String(url).endsWith('/auth/me')||String(url).endsWith('/member/me')?Response.json({financialScope:scope}):handler(url,options);}

const memory=()=>{const values=new Map();return {getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k),key:i=>Array.from(values.keys())[i]??null,get length(){return values.size}};};
function locks(){let held=false;const waiters=[];return {async request(_name,options,callback){if(typeof options==='function'){callback=options;options={};}if(held && options.ifAvailable)return callback(null);if(held)await new Promise(resolve=>waiters.push(resolve));held=true;try{return await callback({name:_name});}finally{held=false;waiters.shift()?.();}}};}
beforeEach(()=>{scope='org-a:actor-a';globalThis.window={location:{pathname:'/front-desk'},navigator:{locks:locks()}};globalThis.localStorage=memory();globalThis.sessionStorage=memory();localStorage.setItem(staff.USER_KEY,'{"email":"staff@example.invalid"}');localStorage.setItem(staff.SESSION_MARKER,'cookie');localStorage.setItem(member.MEMBER_INFO_KEY,'{"id":"member-a"}');localStorage.setItem(member.MEMBER_SESSION_MARKER,'cookie');});
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
 test(`${name}: an overlapping submission is refused rather than queued as a new payment`,async()=>{
  const keys=[];setFetch(async(_url,options)=>{keys.push(JSON.parse(options.body).idempotencyKey);await Promise.resolve();return Response.json({recorded:5});});const first=api.apiFetch(path,undefined,init);await assert.rejects(api.apiFetch(path,undefined,init),/another tab/);await first;assert.equal(keys.length,1);
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
  sessionStorage.setItem(storageKey,JSON.stringify({key:'legacy-key-123456789',payload:init.body}));await api.syncFinancialWrites();let calls=0;setFetch(async()=>{calls++;return Response.json({});});await assert.rejects(api.recoverFinancialWrite(storageKey),/older request/);assert.equal(calls,0);assert.equal(api.pendingFinancialWrites().length,1);
 });
 test(`${name}: account verification holds the cross-tab lock until acknowledgement`,async()=>{
  let release;const gate=new Promise(resolve=>release=resolve);let lookups=0;const keys=[];
  globalThis.fetch=async(url,options)=>{if(String(url).endsWith('/me')){lookups++;await gate;return Response.json({financialScope:scope});}keys.push(JSON.parse(options.body).idempotencyKey);return Response.json({recorded:5});};
  const first=api.apiFetch(path,undefined,init);await assert.rejects(api.apiFetch(path,undefined,init),/another tab/);release();await first;assert.equal(lookups,1);assert.equal(keys.length,1);
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
  name==='staff'?staff.clearSession():member.clearMemberSession();assert.equal(api.pendingFinancialWrites().length,0);assert.ok(localStorage.getItem(old.storageKey));
  localStorage.setItem(identityKey,identity);localStorage.setItem(marker,'cookie');setFetch(async()=>Response.json({recorded:5}));await api.recoverFinancialWrite(old.storageKey);assert.equal(api.pendingFinancialWrites().length,0);
 });
}

for(const [name,api,path] of [['staff',staff,'/savings/accounts/synthetic/deposits'],['member',member,'/member/withdrawals/request']]) {
 test(`${name}: failed account verification sends no financial write and leaves a recoverable original key`,async()=>{
  let writes=0;globalThis.fetch=async()=>{throw new TypeError('account lookup offline');};await assert.rejects(api.apiFetch(path,undefined,{method:'POST',body:'{"amount":5}'}));const old=api.pendingFinancialWrites()[0];assert.equal(old.scope,'UNSENT');
  setFetch(async(_url,options)=>{writes++;assert.equal(JSON.parse(options.body).idempotencyKey,old.key);return Response.json({recorded:5});});await api.recoverFinancialWrite(old.storageKey);assert.equal(writes,1);assert.equal(api.pendingFinancialWrites().length,0);
 });
}

for(const [name,api,path] of [['staff',staff,'/savings/accounts/synthetic/deposits'],['member',member,'/member/withdrawals/request']]) {
 const init={method:'POST',body:'{"amount":5}'};
 test(`${name}: a new tab and browser session recover the original persistent record`,async()=>{
  let key;setFetch(async(_url,options)=>{key=JSON.parse(options.body).idempotencyKey;throw new TypeError('lost response');});await assert.rejects(api.apiFetch(path,undefined,init));const pending=api.pendingFinancialWrites()[0];
  globalThis.sessionStorage=memory();setFetch(async(_url,options)=>{assert.equal(JSON.parse(options.body).idempotencyKey,key);return Response.json({recorded:5});});await api.recoverFinancialWrite(pending.storageKey);assert.equal(api.pendingFinancialWrites().length,0);
 });
 test(`${name}: migrated bound legacy key is recovered and old tab copies cannot resurrect it`,async()=>{
  const identity=localStorage.getItem(name==='staff'?staff.USER_KEY:member.MEMBER_INFO_KEY),storageKey='coopengine-payment:'+identity+':'+path;
  const raw=JSON.stringify({key:'migrated-key-123456789',payload:init.body,scope});sessionStorage.setItem(storageKey,raw);await api.syncFinancialWrites();assert.equal(sessionStorage.getItem(storageKey),null);
  setFetch(async(_url,options)=>{assert.equal(JSON.parse(options.body).idempotencyKey,'migrated-key-123456789');return Response.json({recorded:5});});await api.recoverFinancialWrite(storageKey);
  sessionStorage.setItem(storageKey,raw);await api.syncFinancialWrites();assert.equal(api.pendingFinancialWrites().length,0);assert.equal(sessionStorage.getItem(storageKey),null);
 });
 test(`${name}: conflicting old tab records preserve both keys and send nothing`,async()=>{
  setFetch(async()=>{throw new TypeError('lost response');});await assert.rejects(api.apiFetch(path,undefined,init));const old=api.pendingFinancialWrites()[0],durable=localStorage.getItem(old.storageKey),legacy=JSON.stringify({key:'different-key-123456789',payload:init.body,scope});
  sessionStorage.setItem(old.storageKey,legacy);let sent=0;setFetch(async()=>{sent++;return Response.json({});});await assert.rejects(api.apiFetch(path,undefined,init),/Conflicting financial records/);assert.equal(sent,0);assert.equal(localStorage.getItem(old.storageKey),durable);assert.equal(sessionStorage.getItem(old.storageKey),legacy);
 });
 test(`${name}: storage failure refuses before any lookup or financial send`,async()=>{
  const original=localStorage.setItem;localStorage.setItem=()=>{throw new Error('Storage quota exhausted');};let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({});};await assert.rejects(api.apiFetch(path,undefined,init),/quota/);assert.equal(calls,0);localStorage.setItem=original;
 });
 test(`${name}: unavailable cross-tab coordination fails closed`,async()=>{
  window.navigator={};let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({});};await assert.rejects(api.apiFetch(path,undefined,init),/cannot safely coordinate/);assert.equal(calls,0);
 });
 test(`${name}: a storage error after commit retains the original request for recovery`,async()=>{
  const remove=localStorage.removeItem;let key;setFetch(async(_url,options)=>{key=JSON.parse(options.body).idempotencyKey;localStorage.removeItem=()=>{throw new Error('Storage remove failed');};return Response.json({recorded:5});});await assert.rejects(api.apiFetch(path,undefined,init),/Storage remove failed/);localStorage.removeItem=remove;
  const old=api.pendingFinancialWrites()[0];assert.equal(old.key,key);setFetch(async(_url,options)=>{assert.equal(JSON.parse(options.body).idempotencyKey,key);return Response.json({recorded:5});});await api.recoverFinancialWrite(old.storageKey);
 });
}
for(const [name,api,path] of [['staff',staff,'/savings/accounts/synthetic/deposits'],['member',member,'/member/withdrawals/request']]) {
 test(`${name}: malformed persistent records are preserved and cannot be replaced`,async()=>{
  const identity=localStorage.getItem(name==='staff'?staff.USER_KEY:member.MEMBER_INFO_KEY),key='coopengine-payment:'+identity+':'+path;
  localStorage.setItem(key,'{');let sent=0;globalThis.fetch=async()=>{sent++;return Response.json({});};await assert.rejects(api.apiFetch(path,undefined,{method:'POST',body:'{"amount":5}'}));assert.equal(sent,0);assert.equal(localStorage.getItem(key),'{');
 });
 test(`${name}: legacy acknowledgements are scoped to the original identity and route`,async()=>{
  const identityKey=name==='staff'?staff.USER_KEY:member.MEMBER_INFO_KEY,identity=localStorage.getItem(identityKey),key='coopengine-payment:'+identity+':'+path,raw=JSON.stringify({key:'same-legacy-key-123456789',payload:'{"amount":5}',scope});
  sessionStorage.setItem(key,raw);await api.syncFinancialWrites();setFetch(async()=>Response.json({recorded:5}));await api.recoverFinancialWrite(key);
  const second=name==='staff'?'{"email":"other@example.invalid"}':'{"id":"other-identity"}';localStorage.setItem(identityKey,second);const otherKey='coopengine-payment:'+second+':'+path;sessionStorage.setItem(otherKey,raw);await api.syncFinancialWrites();assert.equal(api.pendingFinancialWrites().length,1);assert.equal(api.pendingFinancialWrites()[0].key,'same-legacy-key-123456789');
 });
}

for(const [name,api,path] of [['staff',staff,'/savings/accounts/synthetic/deposits'],['member',member,'/member/withdrawals/request']]) {
 const init={method:'POST',body:'{"amount":5}'};
 const info=name==='staff'?staff.USER_KEY:member.MEMBER_INFO_KEY;
 const changed=name==='staff'?JSON.stringify({email:' STAFF@EXAMPLE.INVALID ',display:'Changed'}):JSON.stringify({id:'member-a',firstName:'Changed',lastName:'Name',email:'new@example.invalid'});
 test(`${name}: display/profile edits and email casing cannot hide a pending request`,async()=>{
  setFetch(async()=>{throw new TypeError('lost response');});await assert.rejects(api.apiFetch(path,undefined,init));const old=api.pendingFinancialWrites()[0];localStorage.setItem(info,changed);assert.equal(api.pendingFinancialWrites()[0].key,old.key);
  setFetch(async(_url,options)=>{assert.equal(JSON.parse(options.body).idempotencyKey,old.key);return Response.json({recorded:5});});await api.recoverFinancialWrite(old.storageKey);assert.equal(api.pendingFinancialWrites().length,0);
 });
 for(const source of ['session','local']) test(`${name}: old ${source} display-field namespace migrates to the stable identity`,async()=>{
  const oldIdentity=name==='staff'?JSON.stringify({email:'STAFF@EXAMPLE.INVALID',display:'Old'}):JSON.stringify({id:'member-a',firstName:'Old',lastName:'Name',email:'old@example.invalid'}),oldKey='coopengine-payment:'+oldIdentity+':'+path;
  const storage=source==='session'?sessionStorage:localStorage;storage.setItem(oldKey,JSON.stringify({key:'stable-migrated-key-123456789',payload:init.body,scope}));localStorage.setItem(info,changed);
  await api.syncFinancialWrites();assert.equal(storage.getItem(oldKey),null);const pending=api.pendingFinancialWrites();assert.equal(pending.length,1);assert.notEqual(pending[0].storageKey,oldKey);
  setFetch(async(_url,options)=>{assert.equal(JSON.parse(options.body).idempotencyKey,'stable-migrated-key-123456789');return Response.json({recorded:5});});await api.recoverFinancialWrite(pending[0].storageKey);assert.equal(api.pendingFinancialWrites().length,0);
 });
}
const interestPath='/savings/interest/post',interestInit={method:'POST',body:'{"period":"2026-10"}'};
test('interest: response loss retains the original month and refuses a changed month',async()=>{
 const bodies=[];setFetch(async(_url,options)=>{bodies.push(JSON.parse(options.body));if(bodies.length===1)throw new TypeError('lost response');return Response.json({period:'2026-10',total:0.01});});
 await assert.rejects(staff.apiFetch(interestPath,undefined,interestInit));await assert.rejects(staff.apiFetch(interestPath,undefined,{...interestInit,body:'{"period":"2026-11"}'}),/uncertain result/);
 await staff.recoverFinancialWrite(staff.pendingFinancialWrites()[0].storageKey);assert.deepEqual(bodies,[{period:'2026-10'},{period:'2026-10'}]);assert.equal(staff.pendingFinancialWrites().length,0);
});
test('interest: empty success retains an explicit natural period without adding an arbitrary body key',async()=>{
 setFetch(async(_url,options)=>{assert.deepEqual(JSON.parse(options.body),{period:'2026-10'});return new Response('',{status:200});});await assert.rejects(staff.apiFetch(interestPath,undefined,interestInit),/empty/);assert.equal(staff.pendingFinancialWrites()[0].payload,interestInit.body);
});
test('interest: account change refuses original-month recovery before a write',async()=>{
 let calls=0;setFetch(async()=>{calls++;throw new TypeError('lost');});await assert.rejects(staff.apiFetch(interestPath,undefined,interestInit));scope='another-org:another-actor';await assert.rejects(staff.recoverFinancialWrite(staff.pendingFinancialWrites()[0].storageKey),/another account/);assert.equal(calls,1);
});
test('interest: a browser restart retains the original month for authorized recovery',async()=>{
 setFetch(async()=>{throw new TypeError('lost');});await assert.rejects(staff.apiFetch(interestPath,undefined,interestInit));const old=staff.pendingFinancialWrites()[0];globalThis.sessionStorage=memory();setFetch(async(_url,options)=>{assert.equal(options.body,interestInit.body);return Response.json({total:0.01});});await staff.recoverFinancialWrite(old.storageKey);assert.equal(staff.pendingFinancialWrites().length,0);
});
test('interest: overlap is refused without queuing a second period',async()=>{
 let release;const gate=new Promise(resolve=>release=resolve);let sends=0;setFetch(async()=>{sends++;await gate;return Response.json({total:0.01});});const first=staff.apiFetch(interestPath,undefined,interestInit);await assert.rejects(staff.apiFetch(interestPath,undefined,interestInit),/another tab/);release();await first;assert.equal(sends,1);
});
test('interest: initial validation refusal permits correcting the explicit period',async()=>{
 let sends=0;setFetch(async()=>++sends===1?Response.json({message:'Invalid period'},{status:400}):Response.json({total:0.01}));await assert.rejects(staff.apiFetch(interestPath,undefined,{method:'POST',body:'{"period":"bad"}'}),/Invalid/);await staff.apiFetch(interestPath,undefined,interestInit);assert.equal(sends,2);
});

const dividendPath='/dividends/post',dividendInit={method:'POST',body:'{"periodLabel":"2026","distributableAmount":0.01}'};
test('dividend: response loss retains the original year/amount and refuses a changed year/amount',async()=>{
 const bodies=[];setFetch(async(_url,options)=>{bodies.push(JSON.parse(options.body));if(bodies.length===1)throw new TypeError('lost response');return Response.json({periodLabel:'2026',total:0.01});});
 await assert.rejects(staff.apiFetch(dividendPath,undefined,dividendInit));await assert.rejects(staff.apiFetch(dividendPath,undefined,{...dividendInit,body:'{"periodLabel":"2027","distributableAmount":0.02}'}),/uncertain result/);
 await staff.recoverFinancialWrite(staff.pendingFinancialWrites()[0].storageKey);assert.deepEqual(bodies,[{periodLabel:'2026',distributableAmount:0.01},{periodLabel:'2026',distributableAmount:0.01}]);assert.equal(staff.pendingFinancialWrites().length,0);
});
test('dividend: empty success retains an explicit natural period without adding an arbitrary body key',async()=>{
 setFetch(async(_url,options)=>{assert.deepEqual(JSON.parse(options.body),{periodLabel:'2026',distributableAmount:0.01});return new Response('',{status:200});});await assert.rejects(staff.apiFetch(dividendPath,undefined,dividendInit),/empty/);assert.equal(staff.pendingFinancialWrites()[0].payload,dividendInit.body);
});
test('dividend: account change refuses original-year/amount recovery before a write',async()=>{
 let calls=0;setFetch(async()=>{calls++;throw new TypeError('lost');});await assert.rejects(staff.apiFetch(dividendPath,undefined,dividendInit));scope='another-org:another-actor';await assert.rejects(staff.recoverFinancialWrite(staff.pendingFinancialWrites()[0].storageKey),/another account/);assert.equal(calls,1);
});
test('dividend: a browser restart retains the original year/amount for authorized recovery',async()=>{
 setFetch(async()=>{throw new TypeError('lost');});await assert.rejects(staff.apiFetch(dividendPath,undefined,dividendInit));const old=staff.pendingFinancialWrites()[0];globalThis.sessionStorage=memory();setFetch(async(_url,options)=>{assert.equal(options.body,dividendInit.body);return Response.json({total:0.01});});await staff.recoverFinancialWrite(old.storageKey);assert.equal(staff.pendingFinancialWrites().length,0);
});
test('dividend: overlap is refused without queuing a second period',async()=>{
 let release;const gate=new Promise(resolve=>release=resolve);let sends=0;setFetch(async()=>{sends++;await gate;return Response.json({total:0.01});});const first=staff.apiFetch(dividendPath,undefined,dividendInit);await assert.rejects(staff.apiFetch(dividendPath,undefined,dividendInit),/another tab/);release();await first;assert.equal(sends,1);
});
test('dividend: initial validation refusal permits correcting the explicit period',async()=>{
 let sends=0;setFetch(async()=>++sends===1?Response.json({message:'Invalid period'},{status:400}):Response.json({total:0.01}));await assert.rejects(staff.apiFetch(dividendPath,undefined,{method:'POST',body:'{"periodLabel":"bad","distributableAmount":0.01}'}),/Invalid/);await staff.apiFetch(dividendPath,undefined,dividendInit);assert.equal(sends,2);
});

const payrollPath='/payroll/import/commit',payrollInit={method:'POST',body:'{"batchId":"original-batch"}'};
test('payroll submission: response loss retains the original batch and refuses a changed batch',async()=>{
 const bodies=[];setFetch(async(_url,options)=>{bodies.push(JSON.parse(options.body));if(bodies.length===1)throw new TypeError('lost response');return Response.json({period:'2026-10',total:0.01});});
 await assert.rejects(staff.apiFetch(payrollPath,undefined,payrollInit));await assert.rejects(staff.apiFetch(payrollPath,undefined,{...payrollInit,body:'{"batchId":"changed-batch"}'}),/uncertain result/);
 await staff.recoverFinancialWrite(staff.pendingFinancialWrites()[0].storageKey);assert.deepEqual(bodies,[{batchId:'original-batch'},{batchId:'original-batch'}]);assert.equal(staff.pendingFinancialWrites().length,0);
});
test('payroll submission: empty success retains an explicit natural period without adding an arbitrary body key',async()=>{
 setFetch(async(_url,options)=>{assert.deepEqual(JSON.parse(options.body),{batchId:'original-batch'});return new Response('',{status:200});});await assert.rejects(staff.apiFetch(payrollPath,undefined,payrollInit),/empty/);assert.equal(staff.pendingFinancialWrites()[0].payload,payrollInit.body);
});
test('payroll submission: account change refuses original-batch recovery before a write',async()=>{
 let calls=0;setFetch(async()=>{calls++;throw new TypeError('lost');});await assert.rejects(staff.apiFetch(payrollPath,undefined,payrollInit));scope='another-org:another-actor';await assert.rejects(staff.recoverFinancialWrite(staff.pendingFinancialWrites()[0].storageKey),/another account/);assert.equal(calls,1);
});
test('payroll submission: a browser restart retains the original batch for authorized recovery',async()=>{
 setFetch(async()=>{throw new TypeError('lost');});await assert.rejects(staff.apiFetch(payrollPath,undefined,payrollInit));const old=staff.pendingFinancialWrites()[0];globalThis.sessionStorage=memory();setFetch(async(_url,options)=>{assert.equal(options.body,payrollInit.body);return Response.json({total:0.01});});await staff.recoverFinancialWrite(old.storageKey);assert.equal(staff.pendingFinancialWrites().length,0);
});
test('payroll submission: overlap is refused without queuing a second period',async()=>{
 let release;const gate=new Promise(resolve=>release=resolve);let sends=0;setFetch(async()=>{sends++;await gate;return Response.json({total:0.01});});const first=staff.apiFetch(payrollPath,undefined,payrollInit);await assert.rejects(staff.apiFetch(payrollPath,undefined,payrollInit),/another tab/);release();await first;assert.equal(sends,1);
});
test('payroll submission: initial validation refusal permits correcting the explicit period',async()=>{
 let sends=0;setFetch(async()=>++sends===1?Response.json({message:'Invalid period'},{status:400}):Response.json({total:0.01}));await assert.rejects(staff.apiFetch(payrollPath,undefined,{method:'POST',body:'{"batchId":"bad"}'}),/Invalid/);await staff.apiFetch(payrollPath,undefined,payrollInit);assert.equal(sends,2);
});
