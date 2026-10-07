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
for(const kind of ['loan','journal']) {
const platform=await call('/auth/login',{body:{email:'platform@recovery.invalid',password}});
const slug=`${kind}-create-browser-${Date.now().toString(36)}`,email=`${slug}@recovery.invalid`;
let staff,member,account,product;const guarantors=[];const date=new Date().toISOString().slice(0,10);const path=kind==='loan'?'/loans':'/ledger/journals';const screen=kind==='loan'?'/loan-applications':'/journal-drafts';const button=kind==='loan'?'Create loan application':'Create journal draft';
try {
 await call('/organizations',{token:platform.tokens.accessToken,status:201,body:{name:`SYNTHETIC Recovery ${slug}`,slug,adminEmail:email,adminPassword:password}});
 staff=await call('/auth/login',{body:{email,password,organizationSlug:slug}});
 member=await call('/members',{token:staff.tokens.accessToken,status:201,body:{firstName:'Recovery',lastName:'Synthetic'}});
 await call(`/members/${member.id}/approve`,{token:staff.tokens.accessToken,method:'POST'});
 account=await call(`/savings/member/${member.id}/account`,{token:staff.tokens.accessToken,status:201,body:{}});
 await call(`/savings/accounts/${account.id}/deposits`,{token:staff.tokens.accessToken,status:201,body:{idempotencyKey:randomUUID(),amount:1.15}});
 for(let i=0;i<2;i++){const g=await call('/members',{token:staff.tokens.accessToken,status:201,body:{firstName:'Guarantor'+i,lastName:'Synthetic'}});await call(`/members/${g.id}/approve`,{token:staff.tokens.accessToken,method:'POST'});guarantors.push(g.id);}
 product=(await call('/loans/products',{token:staff.tokens.accessToken})).find(p=>p.status==='ACTIVE');
} finally {await call('/auth/logout',{token:platform.tokens.accessToken,method:'POST',status:204});}
const profile=await mkdtemp(join(tmpdir(),'coopengine-creation-profile-'));
let context;
const periods=[],errors=[],previews=[];
let releaseSend;
const sendGate=new Promise(resolve=>releaseSend=resolve);
let arrived;
const firstSend=new Promise(resolve=>arrived=resolve);
async function openBrowser() {
 context=await chromium.launchPersistentContext(profile,{headless:true});
 await context.route('**/*',route=>[portal,'http://localhost:4399'].includes(new URL(route.request().url()).origin)?route.continue():route.abort());
 await context.route('**/api/v1'+path,async route=>{
  periods.push(route.request().postDataJSON());
  if(periods.length===1) {arrived();await sendGate;}
  const response=await route.fetch();assert.equal(response.status(),201,'Synthetic creation commits');previews.push(await response.json());
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
 const refused=await context.request.post(api+path,{data:kind==='loan'?{memberId:member.id,productId:product.id,principal:1.15,termMonths:5,guarantorIds:guarantors}:{entryDate:date,description:'Synthetic draft',lines:[{accountCode:'5010',debit:0.23},{accountCode:'1000',credit:0.23}]}});assert.equal(refused.status(),400,'Explicit creation key required');
 async function fill(page){await page.goto(portal+screen);if(kind==='loan'){await page.getByLabel('Borrower',{exact:true}).selectOption(member.id);await page.getByLabel('Loan product',{exact:true}).selectOption(product.id);await page.getByLabel('Principal (₦)',{exact:true}).fill('1.15');await page.getByLabel('Term (months)',{exact:true}).fill('5');await page.getByLabel('Guarantors (select at least two)',{exact:true}).selectOption(guarantors);}else{await page.getByLabel('Entry date',{exact:true}).fill(date);await page.getByLabel('Description',{exact:true}).fill('Synthetic draft');for(let i=0;i<2;i++){const line=page.getByRole('group',{name:'Line '+(i+1),exact:true});await line.getByLabel('Account',{exact:true}).selectOption(i===0?'5010':'1000');await line.getByLabel('Amount (₦)',{exact:true}).fill('0.23');}}}
 const other=await context.newPage();await fill(other);await fill(page);await page.getByRole('button',{name:button,exact:true}).click();
 let timeout;try {await Promise.race([firstSend,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('First synthetic creation was not sent')),20000);})]);}finally{clearTimeout(timeout);}
 await other.getByRole('button',{name:button,exact:true}).click();await other.getByText(/already being checked in another tab/).waitFor();assert.equal(periods.length,1,'Overlapping tab sent no second request');
 releaseSend();await page.getByText(/Failed to fetch|fetch failed|NetworkError/).waitFor();await page.getByLabel(kind==='loan'?'Principal (₦)':'Description',{exact:true}).fill(kind==='loan'?'1.16':'Changed draft');await page.getByRole('button',{name:button,exact:true}).click();await page.getByText(/previous payment has an uncertain result/).waitFor();assert.equal(periods.length,1,'Changed unresolved creation sent no request');
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
 await observer.getByRole('complementary',{name:'Financial request recovery'}).waitFor({state:'hidden'});await page.getByRole('region',{name:'Recovered creation'}).waitFor();await page.getByRole('button',{name:'Check current record',exact:true}).click();await page.getByText('Current status: '+(kind==='loan'?'PENDING':'DRAFT'),{exact:true}).waitFor();
 assert.equal(periods.length,2);assert.deepEqual(periods[0],periods[1],'Recovery retained original creation across browser restart');
 assert.equal(Number((await call(`/savings/accounts/${account.id}`,{token:staff.tokens.accessToken})).currentBalance),1.15,'Recovery left funded balance unchanged');
 const journals=await call('/ledger/journals',{token:staff.tokens.accessToken});assert.equal(journals.filter(j=>j.status==='POSTED').length,1,'Only fixture funding is posted');assert.deepEqual(previews[0],previews[1],'Original creation response retained');assert.ok(periods[0].idempotencyKey);const records=await call(path,{token:staff.tokens.accessToken});assert.equal(records.filter(r=>kind==='loan'||r.source==='MANUAL').length,1,'One created record');assert.equal(previews[0].status,kind==='loan'?'PENDING':'DRAFT');const current=await call(path+'/'+previews[0].id,{token:staff.tokens.accessToken});assert.equal(kind==='loan'?current.status:current.entry.status,previews[0].status);await page.goto(portal+screen);await page.setViewportSize({width:375,height:812});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Mobile creation page fits');assert.equal(errors.length,0,'No browser runtime errors');
 console.log(`PASS: ${kind} creation requires a key; competing forms sent one creation; changed unresolved details refused; lost committed response survived full browser restart; original key/payload/scope/record recovered; observer cleared; one ${kind==='loan'?'PENDING loan':'DRAFT journal'}, funded savings balance 1.15 unchanged and no extra posted journal; mobile width passed. No provider or production access.`);
} finally {releaseSend();await context?.close();await rm(profile,{recursive:true,force:true});await call('/auth/logout',{token:staff.tokens.accessToken,method:'POST',status:204});}

}
