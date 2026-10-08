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
const slug=`exact-ledger-${Date.now().toString(36)}`,email=`${slug}@recovery.invalid`;
let context,staff;
const profile=await mkdtemp(join(tmpdir(),'exact-ledger-')); 
try {
 await call('/organizations',{token:platform.tokens.accessToken,status:201,body:{name:`SYNTHETIC ${slug}`,slug,adminEmail:email,adminPassword:password}});
 staff=await call('/auth/login',{body:{email,password,organizationSlug:slug}});
 context=await chromium.launchPersistentContext(profile,{headless:true});
 await context.route('**/*',route=>[portal,'http://localhost:4399'].includes(new URL(route.request().url()).origin)?route.continue():route.abort());
 const page=context.pages()[0]??await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.name));page.setDefaultTimeout(20000);
 await page.goto(portal+'/login');await page.getByLabel('Email',{exact:true}).fill(email);await page.getByLabel('Password',{exact:true}).fill(password);await page.getByLabel(/^Cooperative /).fill(slug);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('heading',{name:'Dashboard',exact:true}).waitFor();
 await page.goto(portal+'/journal-drafts');await page.getByLabel('Entry date',{exact:true}).fill(new Date().toISOString().slice(0,10));await page.getByLabel('Description',{exact:true}).fill('Exact decimal browser');
 await page.getByLabel('Account',{exact:true}).nth(0).selectOption('5010');await page.getByLabel('Account',{exact:true}).nth(1).selectOption('1000');
 await page.getByLabel('Amount (₦)',{exact:true}).nth(0).fill('90071992547409.91');await page.getByLabel('Amount (₦)',{exact:true}).nth(1).fill('90071992547409.91');
 assert.ok(await page.locator('form').evaluate(form=>form.checkValidity()),'Synthetic form fills all required fields');
 const responsePromise=page.waitForResponse(r=>r.url().endsWith('/api/v1/ledger/journals')&&r.request().method()==='POST');
 await page.getByRole('button',{name:'Create journal draft',exact:true}).click();const response=await responsePromise;assert.equal(response.status(),201);const payload=response.request().postDataJSON();assert.equal(payload.lines[0].debit,'90071992547409.91');assert.equal(payload.lines[1].credit,'90071992547409.91');
 const journal=await response.json();const exact=await call('/ledger/journals/'+journal.id,{token:staff.tokens.accessToken});assert.equal(exact.lines.find(l=>l.accountCode==='5010').debitDecimal,'90071992547409.91');
 await page.goto(portal+'/journals');await page.getByRole('button',{name:'View lines Exact decimal browser',exact:true}).click();await page.getByRole('region',{name:'Journal lines'}).getByText(/Debit ₦90071992547409.91/).waitFor();
 await page.setViewportSize({width:375,height:812});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));assert.deepEqual(errors,[]);
 console.log('PASS: actual journal form sends exact large decimal strings; database-backed read and normal journal details preserve every kobo; mobile fits and no browser errors. Synthetic isolated staging only.');
} finally {await context?.close();await rm(profile,{recursive:true,force:true});if(staff)await call('/auth/logout',{token:staff.tokens.accessToken,method:'POST',status:204});await call('/auth/logout',{token:platform.tokens.accessToken,method:'POST',status:204});}
