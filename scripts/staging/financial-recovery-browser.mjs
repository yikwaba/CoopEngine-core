import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
const slug=`intent-browser-${Date.now().toString(36)}`,email=`${slug}@recovery.invalid`;
let staff,member,account;
try {
 await call('/organizations',{token:platform.tokens.accessToken,status:201,body:{name:`SYNTHETIC Recovery ${slug}`,slug,adminEmail:email,adminPassword:password}});
 staff=await call('/auth/login',{body:{email,password,organizationSlug:slug}});
 member=await call('/members',{token:staff.tokens.accessToken,status:201,body:{firstName:'Recovery',lastName:'Synthetic'}});
 await call(`/members/${member.id}/approve`,{token:staff.tokens.accessToken,method:'POST'});
 account=await call(`/savings/member/${member.id}/account`,{token:staff.tokens.accessToken,status:201,body:{}});
} finally {await call('/auth/logout',{token:platform.tokens.accessToken,method:'POST',status:204});}
const browser=await chromium.launch({headless:true}),context=await browser.newContext(),page=await context.newPage();
page.setDefaultTimeout(20000);
const errors=[];page.on('pageerror',error=>errors.push(error.name));page.on('dialog',dialog=>dialog.accept());
await context.route('**/*',route=>[portal,'http://localhost:4399'].includes(new URL(route.request().url()).origin)?route.continue():route.abort());
const keys=[];
await context.route(`**/api/v1/savings/accounts/${account.id}/deposits`,async route=>{
 keys.push(route.request().postDataJSON().idempotencyKey);
 const response=await route.fetch();assert.equal(response.status(),201,'Synthetic deposit commits');
 if(keys.length===1)await route.abort('failed');else await route.fulfill({response});
});
try {
 await page.goto(portal+'/login');await page.getByLabel('Email',{exact:true}).fill(email);await page.getByLabel('Password',{exact:true}).fill(password);await page.getByLabel(/^Cooperative /).fill(slug);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('heading',{name:'Dashboard',exact:true}).waitFor();
 const refused=await context.request.post(api+`/savings/accounts/${account.id}/deposits`,{data:{amount:0.23}});assert.equal(refused.status(),400,'Unkeyed external financial write refused');assert.match(JSON.stringify(await refused.json()),/idempotencyKey/);assert.equal(Number((await call(`/savings/accounts/${account.id}`,{token:staff.tokens.accessToken})).currentBalance),0,'Missing key cannot post');
 await page.goto(portal+'/front-desk');await page.getByPlaceholder('Name, phone, email or member number').fill('Recovery');await page.getByRole('button',{name:'Find member',exact:true}).click();await page.getByPlaceholder('5000').fill('0.23');await page.getByRole('button',{name:'Take a deposit',exact:true}).click();
 await page.getByRole('button',{name:'Take a deposit',exact:true}).waitFor({state:'visible'});
 await page.getByText(/Failed to fetch|fetch failed|NetworkError/).waitFor();
 assert.equal(Number((await call(`/savings/accounts/${account.id}`,{token:staff.tokens.accessToken})).currentBalance),0.23,'Lost browser response still committed exactly 23 kobo');
 await page.reload();await page.getByRole('complementary',{name:'Financial request recovery'}).waitFor();await page.getByRole('button',{name:'Recover original request',exact:true}).click();await page.getByText('The original request has been acknowledged. Refresh the account view to see the current balance or status.',{exact:true}).waitFor();
 assert.equal(keys.length,2);assert.equal(keys[0],keys[1],'Recovery retained original key across reload');
 assert.equal(Number((await call(`/savings/accounts/${account.id}`,{token:staff.tokens.accessToken})).currentBalance),0.23,'Recovery did not double the balance');
 const journals=await call('/ledger/journals',{token:staff.tokens.accessToken});assert.equal(journals.filter(entry=>entry.source==='SAVINGS_DEPOSIT').length,1,'One deposit journal');assert.equal(errors.length,0,'No browser runtime errors');
 console.log('PASS: unkeyed external deposit returned 400 with no balance effect; isolated Chromium keyed deposit committed, response deliberately lost, reload preserved pending request, recovery acknowledged the original key, one 23-kobo balance and one journal. No external provider or production access.');
} finally {await context.close();await browser.close();await call('/auth/logout',{token:staff.tokens.accessToken,method:'POST',status:204});}
