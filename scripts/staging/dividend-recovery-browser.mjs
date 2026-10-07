import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
assert.equal(process.env.COOPENGINE_BROWSER_TEST,'isolated-staging','Explicit isolated marker required');
assert.ok(process.env.BROWSER_TEST_MODULE_ROOT,'Ephemeral browser modules required');
const require=createRequire(resolve(process.env.BROWSER_TEST_MODULE_ROOT,'browser-test.cjs'));
const {chromium}=require('playwright');
const password=(await readFile('.staging/compose.env','utf8')).match(/^STAGING_LOGIN_PASSWORD=(.+)$/m)?.[1].trim();
assert.ok(password && password.length>=24,'Private synthetic password required');
const api='http://localhost:4399/api/v1',portal='http://localhost:4310';
async function call(path,{token,body,method=body?'POST':'GET',status=200}={}) {
 const response=await fetch(api+path,{method,signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
 assert.equal(response.status,status,`Synthetic recovery fixture: ${method} ${path}`);
 return status===204?null:response.json();
}
const platform=await call('/auth/login',{body:{email:'platform@recovery.invalid',password}});
const slug=`dividend-browser-${Date.now().toString(36)}`,email=`${slug}@recovery.invalid`;
let staff,member,account;
try {
 await call('/organizations',{token:platform.tokens.accessToken,status:201,body:{name:`SYNTHETIC Recovery ${slug}`,slug,adminEmail:email,adminPassword:password}});
 staff=await call('/auth/login',{body:{email,password,organizationSlug:slug}});
 member=await call('/members',{token:staff.tokens.accessToken,status:201,body:{firstName:'Recovery',lastName:'Synthetic'}});
 await call(`/members/${member.id}/approve`,{token:staff.tokens.accessToken,method:'POST'});
 account=await call(`/savings/member/${member.id}/account`,{token:staff.tokens.accessToken,status:201,body:{}});
 await call(`/savings/accounts/${account.id}/deposits`,{token:staff.tokens.accessToken,status:201,body:{amount:1,idempotencyKey:randomUUID()}});
 await call(`/shares/member/${member.id}/purchases`,{token:staff.tokens.accessToken,status:201,body:{amount:1,idempotencyKey:randomUUID()}});
} finally {await call('/auth/logout',{token:platform.tokens.accessToken,method:'POST',status:204});}
const profile=await mkdtemp(join(tmpdir(),'coopengine-dividend-profile-'));
let context;
const periods=[],errors=[];
let releaseSend;
const sendGate=new Promise(resolve=>releaseSend=resolve);
let arrived;
const firstSend=new Promise(resolve=>arrived=resolve);
async function openBrowser() {
 context=await chromium.launchPersistentContext(profile,{headless:true});
 await context.route('**/*',route=>[portal,'http://localhost:4399'].includes(new URL(route.request().url()).origin)?route.continue():route.abort());
 await context.route('**/api/v1/dividends/post',async route=>{
  periods.push(route.request().postDataJSON());
  if(periods.length===1) {arrived();await sendGate;}
  const response=await route.fetch();assert.equal(response.status(),201,'Synthetic dividend commits');
  if(periods.length===1)await route.abort('failed');else await route.fulfill({response});
 });
 for(const page of context.pages()) watch(page);
 context.on('page',watch);
 return context.pages()[0]??context.newPage();
}
function watch(page){page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.name));page.on('dialog',dialog=>dialog.accept());}
let page;
try {
 page=await openBrowser();
 await page.goto(portal+'/login');await page.getByLabel('Email',{exact:true}).fill(email);await page.getByLabel('Password',{exact:true}).fill(password);await page.getByLabel(/^Cooperative /).fill(slug);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('heading',{name:'Dashboard',exact:true}).waitFor();
 const refused=await context.request.post(api+'/dividends/post',{data:{}});assert.equal(refused.status(),400,'Explicit dividend year and amount required');assert.equal(Number((await call(`/savings/accounts/${account.id}`,{token:staff.tokens.accessToken})).currentBalance),1,'Missing year and amount cannot post');
 const other=await context.newPage();await other.goto(portal+'/dividends');await other.getByLabel('Distributable amount',{exact:true}).fill('0.01');await other.getByRole('button',{name:'Preview dividends',exact:true}).click();await other.getByRole('button',{name:'Post dividends',exact:true}).waitFor({state:'visible'});
 await page.goto(portal+'/dividends');await page.getByLabel('Distributable amount',{exact:true}).fill('0.01');await page.getByRole('button',{name:'Preview dividends',exact:true}).click();await page.getByRole('button',{name:'Post dividends',exact:true}).click();
 let timeout;try {await Promise.race([firstSend,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('First synthetic dividend was not sent')),20000);})]);}finally{clearTimeout(timeout);}
 await other.getByRole('button',{name:'Post dividends',exact:true}).click();await other.getByText(/already being checked in another tab/).waitFor();assert.equal(periods.length,1,'Overlapping tab sent no second request');
 releaseSend();await page.getByText(/Failed to fetch|fetch failed|NetworkError/).waitFor();
 assert.equal(Number((await call(`/savings/accounts/${account.id}`,{token:staff.tokens.accessToken})).currentBalance),1.01,'Lost browser response still credited exactly one kobo');
 await other.getByRole('complementary',{name:'Financial request recovery'}).waitFor();
 const original=await page.evaluate(()=>Object.entries(localStorage).filter(([key])=>key.startsWith('coopengine-payment:')));assert.equal(original.length,1,'One durable original request');
 await page.close();await other.reload();await other.getByRole('complementary',{name:'Financial request recovery'}).waitFor();
 // Close the entire browser profile, then reopen its on-disk state (not storageState injection).
 await context.close();page=await openBrowser();await page.goto(portal+'/login');
 await page.getByLabel('Email',{exact:true}).fill(email);await page.getByLabel('Password',{exact:true}).fill(password);await page.getByLabel(/^Cooperative /).fill(slug);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('heading',{name:'Dashboard',exact:true}).waitFor();
 await page.getByRole('complementary',{name:'Financial request recovery'}).waitFor();
 const restored=await page.evaluate(()=>Object.entries(localStorage).filter(([key])=>key.startsWith('coopengine-payment:')));assert.deepEqual(restored,original,'Restart preserved original key, payload and scope');
 await page.evaluate(()=>{const info=JSON.parse(localStorage.getItem('coopengine_user'));localStorage.setItem('coopengine_user',JSON.stringify({...info,email:info.email.toUpperCase(),display:'Changed profile'}));});await page.reload();await page.getByRole('complementary',{name:'Financial request recovery'}).waitFor();
 const observer=await context.newPage();await observer.goto(portal+'/');await observer.getByRole('complementary',{name:'Financial request recovery'}).waitFor();
 await page.getByRole('button',{name:'Recover original request',exact:true}).click();await page.getByText('The original request has been acknowledged. Refresh the account view to see the current balance or status.',{exact:true}).waitFor();
 await observer.getByRole('complementary',{name:'Financial request recovery'}).waitFor({state:'hidden'});
 assert.equal(periods.length,2);assert.deepEqual(periods[0],periods[1],'Recovery retained original year and amount across browser restart');
 assert.equal(Number((await call(`/savings/accounts/${account.id}`,{token:staff.tokens.accessToken})).currentBalance),1.01,'Recovery did not double the balance');
 const journals=await call('/ledger/journals',{token:staff.tokens.accessToken});assert.equal(journals.filter(entry=>entry.source==='DIVIDEND').length,1,'One dividend journal');const runs=await call('/dividends',{token:staff.tokens.accessToken});assert.equal(runs.length,1,'One dividend run');assert.equal(runs[0].distributableAmount,0.01);await page.setViewportSize({width:390,height:844});await page.goto(portal+'/dividends');await page.getByRole('heading',{name:'Posted dividend runs',exact:true}).waitFor();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Dividend form fits a mobile viewport');assert.equal(errors.length,0,'No browser runtime errors');
 console.log('PASS: missing dividend year and amount refused; overlapping tabs sent one request; committed dividend response loss survived full browser restart; recovery retained the original year and amount and account scope; observer cleared; one 1-kobo dividend credit, balance 1.01 and one dividend journal. No provider or production access.');
} finally {releaseSend();await context?.close();await rm(profile,{recursive:true,force:true});await call('/auth/logout',{token:staff.tokens.accessToken,method:'POST',status:204});}
