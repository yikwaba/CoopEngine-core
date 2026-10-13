import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
assert.equal(process.env.COOPENGINE_BROWSER_TEST,'isolated-staging');assert.ok(process.env.BROWSER_TEST_MODULE_ROOT);
const require=createRequire(resolve(process.env.BROWSER_TEST_MODULE_ROOT,'browser-test.cjs')),{chromium}=require('playwright');
const password=(await readFile('.staging/compose.env','utf8')).match(/^STAGING_LOGIN_PASSWORD=(.+)$/m)?.[1].trim();assert.ok(password&&password.length>=24);
const api='http://localhost:4399/api/v1',portal='http://localhost:4310',memberPortal='http://localhost:4320';
async function call(path,{token,body,method=body?'POST':'GET',status=200}={}){const r=await fetch(api+path,{method,signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});assert.equal(r.status,status,`${method} ${path}`);return status===204?null:r.json();}
const browser=await chromium.launch({headless:true}),profile=await mkdtemp(join(tmpdir(),'coopengine-staff-account-')),sessions=[],errors=[],sends=[];
let context,release=()=>{};
try{
 const platform=await call('/auth/login',{body:{email:'platform@recovery.invalid',password}});sessions.push(platform);
 const slug=`staff-account-${Date.now().toString(36)}`,email=`${slug}@recovery.invalid`;
 await call('/organizations',{token:platform.tokens.accessToken,status:201,body:{name:`SYNTHETIC ${slug}`,slug,adminEmail:email,adminPassword:password}});
 const maker=await call('/auth/login',{body:{email,password,organizationSlug:slug}});sessions.push(maker);const token=maker.tokens.accessToken;
 const member=await call('/members',{token,status:201,body:{firstName:'Savings',lastName:'Synthetic',email:`member-${slug}@recovery.invalid`}});await call(`/members/${member.id}/approve`,{token,method:'POST'});
 const product=await call('/products/savings',{token,status:201,body:{code:'STAFF-EXTRA',name:'Staff test savings',interestRatePa:0,minDeposit:0,allowWithdrawal:true}});
 const inactive=await call('/products/savings',{token,status:201,body:{code:'UNAVAILABLE',name:'Inactive savings',interestRatePa:0,minDeposit:0,allowWithdrawal:true}});await call(`/products/savings/${inactive.id}/status`,{token,body:{status:'INACTIVE'},status:201});
 const openPath=`/savings/member/${member.id}/account`,detail=portal+`/members/${member.id}`;
 let arrived,opened;const arrival=new Promise(r=>arrived=r),gate=new Promise(r=>release=r);
 async function openBrowser(){
  context=await chromium.launchPersistentContext(profile,{headless:true});
  await context.route('**/*',route=>[portal,'http://localhost:4399'].includes(new URL(route.request().url()).origin)?route.continue():route.abort());
  await context.route('**/api/v1'+openPath,async route=>{
   sends.push(route.request().postDataJSON());if(sends.length===1){arrived();await gate;}
   const response=await route.fetch();assert.equal(response.status(),201);opened=await response.json();
   if(sends.length===1)await route.abort('failed');else await route.fulfill({response});
  });
  const watch=p=>{p.setDefaultTimeout(20000);p.on('pageerror',e=>errors.push(e.message));};context.on('page',watch);for(const p of context.pages())watch(p);
  return context.pages()[0]??context.newPage();
 }
 async function staffLogin(page,credentials={email,password}){await page.goto(portal+'/login');await page.getByLabel('Email',{exact:true}).fill(credentials.email);await page.getByLabel('Password',{exact:true}).fill(credentials.password);await page.getByLabel(/^Cooperative /).fill(slug);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('heading',{name:'Dashboard',exact:true}).waitFor();}
 let page=await openBrowser();await staffLogin(page);await page.goto(detail);await page.getByText('No savings account yet.',{exact:true}).waitFor();
 await page.getByLabel('Savings product',{exact:true}).selectOption(product.id);assert.equal(await page.getByLabel('Savings product',{exact:true}).locator('option').filter({hasText:'UNAVAILABLE'}).count(),0);
 const observer=await context.newPage();await observer.goto(detail);await observer.getByLabel('Savings product',{exact:true}).selectOption(product.id);
 await page.getByRole('button',{name:'Open savings account',exact:true}).click();await arrival;
 await observer.getByText(/Account opening has an unconfirmed result/).waitFor();assert.equal(await observer.getByRole('button',{name:'Open savings account',exact:true}).isDisabled(),true);assert.equal(sends.length,1);
 release();await page.getByRole('complementary',{name:'Financial request recovery'}).waitFor();await page.getByRole('alert').filter({hasText:/fetch|network/i}).waitFor();
 const original=await page.evaluate(()=>Object.entries(localStorage).filter(([k])=>k.startsWith('coopengine-payment:')));assert.equal(original.length,1);assert.equal((await call(openPath.replace('/account','/accounts'),{token})).length,1);assert.equal(opened.productCode,'STAFF-EXTRA');
 await context.close();page=await openBrowser();await staffLogin(page);await page.goto(detail);await page.getByText(/Account opening has an unconfirmed result/).waitFor();
 assert.deepEqual(await page.evaluate(()=>Object.entries(localStorage).filter(([k])=>k.startsWith('coopengine-payment:'))),original);assert.equal(await page.getByLabel('Savings product',{exact:true}).inputValue(),product.id);
 await page.getByRole('button',{name:'Recover original request',exact:true}).click();await page.getByText('The original request has been acknowledged. Refresh the account view to see the current balance or status.',{exact:true}).waitFor();
 assert.equal(sends.length,2);assert.deepEqual(sends,[{productId:product.id},{productId:product.id}]);assert.equal((await call(openPath.replace('/account','/accounts'),{token})).length,1);assert.equal((await call('/ledger/journals',{token})).length,0);
 // Both directions and a subsequent deposit must use the clicked action, never React's previous mode.
 const row=page.getByRole('row',{name:`Savings account ${opened.accountNo}`,exact:true});await row.waitFor();
 for(const [action,amount,status] of [['Deposit','100.23',201],['Withdraw','1.01',200],['Deposit','0.02',201]]){
  await row.getByLabel(`Amount for account #${opened.accountNo}`,{exact:true}).fill(amount);
  const response=page.waitForResponse(r=>r.url()===api+`/savings/accounts/${opened.id}/${action==='Deposit'?'deposits':'withdrawals'}`&&r.status()===status);
  await row.getByRole('button',{name:action,exact:true}).click();await response;
  await page.waitForFunction(id=>document.getElementById('amount-'+id)?.value==='',opened.id);
 }
 await row.getByText('₦99.24',{exact:true}).waitFor();assert.equal((await call(`/savings/accounts/${opened.id}`,{token})).currentBalance,99.24);
 const memberContext=await browser.newContext();try{
  const p=await memberContext.newPage();p.setDefaultTimeout(20000);p.on('pageerror',e=>errors.push(e.message));await p.goto(memberPortal+'/login');await p.getByLabel('Cooperative',{exact:true}).fill(slug);await p.getByLabel('Email',{exact:true}).fill(`member-${slug}@recovery.invalid`);
  const received=p.waitForResponse(r=>r.url()===api+'/auth/member/request-otp'&&r.status()===200);await p.getByRole('button',{name:'Send me a code',exact:true}).click();const otp=await(await received).json();await p.getByLabel('6-digit code',{exact:true}).fill(otp.devCode);await p.getByRole('button',{name:'Sign in',exact:true}).click();await p.waitForURL(memberPortal+'/');await p.goto(memberPortal+'/savings');await p.getByRole('heading',{name:'My savings',exact:true}).waitFor();await p.getByText('₦99.24',{exact:true}).first().waitFor();await p.getByLabel('Savings account',{exact:true}).selectOption(opened.id);
 }finally{await memberContext.close();}
 const auditor=await call('/users',{token,status:201,body:{email:`auditor-${slug}@recovery.invalid`,roleCodes:['AUDITOR']}});
 const auditContext=await browser.newContext();try{const p=await auditContext.newPage();p.setDefaultTimeout(20000);await staffLogin(p,{email:auditor.email,password:auditor.tempPassword});await p.goto(detail);await p.getByRole('row',{name:`Savings account ${opened.accountNo}`,exact:true}).waitFor();assert.equal(await p.getByRole('button',{name:'Open savings account',exact:true}).count(),0);assert.equal(await p.getByRole('button',{name:'Deposit',exact:true}).count(),0);}finally{await auditContext.close();}
 await page.setViewportSize({width:375,height:812});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);assert.deepEqual(errors,[]);assert.equal((await call('/reports/savings-reconciliation',{token})).balanced,true);
 console.log('PASS: staff member screen opens an explicit active savings product; lost committed response, competing tab and full browser restart retain one original account request; recovery returns one zero-balance account without journal/counter duplication; actual deposit/withdraw/deposit buttons post correct directions and exact 99.24; OTP member sees the eligible account and balance; auditor read-only controls and mobile width pass. Isolated synthetic staging only.');
}finally{release();await context?.unrouteAll({behavior:'wait'});await context?.close();await browser.close();await rm(profile,{recursive:true,force:true});for(const session of sessions)await call('/auth/logout',{token:session.tokens.accessToken,method:'POST',status:204});}
