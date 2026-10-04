import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import * as staff from '../src/lib/api.ts';
import * as member from '../../member-pwa/src/lib/api.ts';
const originalFetch=globalThis.fetch;
const memory=()=>{const values=new Map();return {getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};};
beforeEach(()=>{globalThis.window={location:{pathname:'/front-desk'}};globalThis.localStorage=memory();globalThis.sessionStorage=memory();});
afterEach(()=>{globalThis.fetch=originalFetch;delete globalThis.window;delete globalThis.localStorage;delete globalThis.sessionStorage;});
for(const [name,api,path] of [['staff',staff,'/savings/accounts/synthetic/deposits'],['member',member,'/member/withdrawals/request']]){
 const init={method:'POST',body:JSON.stringify({amount:5})};
 test(`${name}: response loss and reload reuse one key; acknowledged success allows a new payment`,async()=>{
  const keys=[];let calls=0;globalThis.fetch=async(_url,options)=>{keys.push(JSON.parse(options.body).idempotencyKey);if(++calls===1)throw new TypeError('response lost after commit');return Response.json({recorded:5});};
  await assert.rejects(api.apiFetch(path,undefined,init),/response lost/);assert.deepEqual(await api.apiFetch(path,undefined,{...init}),{recorded:5});assert.equal(keys[0],keys[1]);await api.apiFetch(path,undefined,init);assert.notEqual(keys[2],keys[0]);
 });
 test(`${name}: changed details cannot silently replace an unresolved intent`,async()=>{
  let calls=0;globalThis.fetch=async()=>{calls++;throw new TypeError('network failed');};await assert.rejects(api.apiFetch(path,undefined,init));await assert.rejects(api.apiFetch(path,undefined,{...init,body:'{"amount":6}'}),/uncertain result/);assert.equal(calls,1);
 });
 test(`${name}: a malformed successful response retains the original key`,async()=>{
  const keys=[];globalThis.fetch=async(_url,options)=>{keys.push(JSON.parse(options.body).idempotencyKey);return keys.length===1?new Response('{',{status:200}):Response.json({recorded:5});};await assert.rejects(api.apiFetch(path,undefined,init));await api.apiFetch(path,undefined,init);assert.equal(keys[0],keys[1]);
 });
 test(`${name}: concurrent duplicate submissions retain one key`,async()=>{
  const keys=[];globalThis.fetch=async(_url,options)=>{keys.push(JSON.parse(options.body).idempotencyKey);await Promise.resolve();return Response.json({recorded:5});};await Promise.all([api.apiFetch(path,undefined,init),api.apiFetch(path,undefined,init)]);assert.equal(keys[0],keys[1]);
 });
 test(`${name}: definitive validation refusal allows corrected details`,async()=>{
  let calls=0;globalThis.fetch=async()=>++calls===1?Response.json({message:'Invalid amount'},{status:400}):Response.json({recorded:6});await assert.rejects(api.apiFetch(path,undefined,init),/Invalid amount/);assert.deepEqual(await api.apiFetch(path,undefined,{...init,body:'{"amount":6}'}),{recorded:6});
 });
 test(`${name}: caller supplied keys are preserved`,async()=>{
  const key='explicit-key-123456789';globalThis.fetch=async(_url,options)=>{assert.equal(JSON.parse(options.body).idempotencyKey,key);return Response.json({recorded:5});};await api.apiFetch(path,undefined,{...init,body:JSON.stringify({amount:5,idempotencyKey:key})});
 });
}
