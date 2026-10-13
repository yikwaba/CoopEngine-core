import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
assert.equal(process.env.COOPENGINE_BROWSER_TEST,'isolated-staging');assert.ok(process.env.BROWSER_TEST_MODULE_ROOT);
const require=createRequire(resolve(process.env.BROWSER_TEST_MODULE_ROOT,'browser-test.cjs')),{chromium}=require('playwright');
const password=(await readFile('.staging/compose.env','utf8')).match(/^STAGING_LOGIN_PASSWORD=(.+)$/m)?.[1].trim();assert.ok(password&&password.length>=24);
const api='http://localhost:4399/api/v1',portal='http://localhost:4310',memberPortal='http://localhost:4320';
async function call(path,{token,body,method=body?'POST':'GET',status=200}={}){const r=await fetch(api+path,{method,signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});assert.equal(r.status,status,`${method} ${path}`);return status===204?null:r.json();}
const browser=await chromium.launch({headless:true}),sessions=[],errors=[];let memberContext,staffContext;
try{
 const platform=await call('/auth/login',{body:{email:'platform@recovery.invalid',password}});sessions.push(platform);
 const slug=`eligibility-${Date.now().toString(36)}`,email=`${slug}@recovery.invalid`;
 await call('/organizations',{token:platform.tokens.accessToken,status:201,body:{name:`SYNTHETIC ${slug}`,slug,adminEmail:email,adminPassword:password}});
 const maker=await call('/auth/login',{body:{email,password,organizationSlug:slug}});sessions.push(maker);const token=maker.tokens.accessToken;
 const member=await call('/members',{token,status:201,body:{firstName:'Eligibility',lastName:'Synthetic',email:`member-${slug}@recovery.invalid`}});await call(`/members/${member.id}/approve`,{token,method:'POST'});
 const product=await call('/products/savings',{token,status:201,body:{code:'ELIGIBLE',name:'Eligibility savings',interestRatePa:0,minDeposit:0,allowWithdrawal:true}});
 const account=await call(`/savings/member/${member.id}/account`,{token,status:201,body:{productId:product.id}});
 await call(`/savings/accounts/${account.id}/deposits`,{token,status:201,body:{amount:100.23,idempotencyKey:randomUUID()}});
 const treasurer=await call('/users',{token,status:201,body:{email:`treasurer-${slug}@recovery.invalid`,roleCodes:['TREASURER']}});
 const checker=await call('/auth/login',{body:{email:treasurer.email,password:treasurer.tempPassword,organizationSlug:slug}});sessions.push(checker);
 const balance=async()=>String((await call(`/savings/accounts/${account.id}`,{token})).currentBalance);
 const productRule=async allowWithdrawal=>call(`/products/savings/${product.id}`,{token,method:'PATCH',body:{code:'ELIGIBLE',name:'Eligibility savings',interestRatePa:0,minDeposit:0,allowWithdrawal}});
 memberContext=await browser.newContext();const page=await memberContext.newPage();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
 await page.goto(memberPortal+'/login');await page.getByLabel('Cooperative',{exact:true}).fill(slug);await page.getByLabel('Email',{exact:true}).fill(`member-${slug}@recovery.invalid`);
 const received=page.waitForResponse(r=>r.url()===api+'/auth/member/request-otp'&&r.status()===200);await page.getByRole('button',{name:'Send me a code',exact:true}).click();const otp=await(await received).json();await page.getByLabel('6-digit code',{exact:true}).fill(otp.devCode);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForURL(memberPortal+'/');await page.goto(memberPortal+'/savings');
 await page.getByLabel('Savings account',{exact:true}).selectOption(account.id);await page.getByText(/Requests do not deduct or reserve/).waitFor();
 async function form(amount,description,status){await page.getByLabel('Withdrawal amount (₦)',{exact:true}).fill(amount);await page.getByLabel('Reason for withdrawal',{exact:true}).fill(description);const response=page.waitForResponse(r=>r.url()===api+'/member/withdrawals/request'&&r.status()===status);await page.getByRole('button',{name:'Submit withdrawal request',exact:true}).click();return(await response).json();}
 await form('100.24','SYNTHETIC too much',400);await page.getByText(/Insufficient balance: available 100.23, requested 100.24/).waitFor();assert.equal(await balance(),'100.23');
 assert.equal((await page.evaluate(async api=>(await fetch(api+'/member/withdrawals',{credentials:'include'})).json(),api)).length,0);assert.equal(await page.getByRole('complementary',{name:'Financial request recovery'}).count(),0);
 const a=await form('60.12','SYNTHETIC first eligible request',201);await page.getByRole('article',{name:'SYNTHETIC first eligible request',exact:true}).waitFor();
 const b=await form('60.12','SYNTHETIC second unreserved request',201);await page.getByRole('article',{name:'SYNTHETIC second unreserved request',exact:true}).waitFor();assert.notEqual(a.requestId,b.requestId);assert.equal(await balance(),'100.23');
 staffContext=await browser.newContext();const staff=await staffContext.newPage();staff.setDefaultTimeout(20000);staff.on('pageerror',e=>errors.push(e.message));staff.on('dialog',d=>d.accept());
 await staff.goto(portal+'/login');await staff.getByLabel('Email',{exact:true}).fill(treasurer.email);await staff.getByLabel('Password',{exact:true}).fill(treasurer.tempPassword);await staff.getByLabel(/^Cooperative /).fill(slug);await staff.getByRole('button',{name:'Sign in',exact:true}).click();await staff.getByRole('heading',{name:'Dashboard',exact:true}).waitFor();await staff.goto(portal+'/withdrawals');
 const row=description=>staff.locator('tbody tr').filter({hasText:description});
 async function decide(id,description,action,status){const response=staff.waitForResponse(r=>r.url()===api+`/savings/withdrawals/${id}/${action}`&&r.status()===status);await row(description).getByRole('button',{name:action==='approve'?'Approve':'Reject',exact:true}).click();return(await response).json();}
 await decide(a.requestId,'SYNTHETIC first eligible request','approve',200);assert.equal(await balance(),'40.11');
 await decide(b.requestId,'SYNTHETIC second unreserved request','approve',400);await staff.getByText(/Insufficient balance: available 40.11, requested 60.12/).waitFor();assert.equal(await balance(),'40.11');
 await decide(b.requestId,'SYNTHETIC second unreserved request','reject',200);await page.getByRole('button',{name:'Refresh savings and requests',exact:true}).click();await page.getByRole('article',{name:'SYNTHETIC second unreserved request',exact:true}).getByText('Rejected — no payout',{exact:true}).waitFor();
 const c=await form('1.01','SYNTHETIC rule changed before payout',201);await productRule(false);await staff.goto(portal+'/withdrawals');
 await decide(c.requestId,'SYNTHETIC rule changed before payout','approve',409);await staff.getByText('Product does not allow withdrawals',{exact:true}).waitFor();assert.equal(await balance(),'40.11');
 await page.getByRole('button',{name:'Refresh savings and requests',exact:true}).click();await page.getByText('No active account currently allows withdrawals. Contact your cooperative.',{exact:true}).waitFor();
 await productRule(true);await staff.getByRole('button',{name:'Recover original request',exact:true}).click();await staff.getByText('The original request has been acknowledged. Refresh the account view to see the current balance or status.',{exact:true}).waitFor();assert.equal(await balance(),'39.1');
 const posted=await call(`/savings/withdrawals/${c.requestId}/approve`,{token:checker.tokens.accessToken,body:{}});assert.equal(posted.approvalStatus,'APPROVED');assert.equal(await balance(),'39.1');
 await page.getByRole('button',{name:'Refresh savings and requests',exact:true}).click();await page.getByRole('article',{name:'SYNTHETIC rule changed before payout',exact:true}).getByText('Approved and paid',{exact:true}).waitFor();await page.getByText('₦39.10',{exact:true}).first().waitFor();
 const all=await call('/savings/withdrawals',{token});assert.equal(all.length,3);assert.equal(all.filter(r=>r.status==='APPROVED').length,2);assert.equal(all.filter(r=>r.status==='REJECTED').length,1);
 assert.equal((await call('/reports/savings-reconciliation',{token})).balanced,true);await page.setViewportSize({width:375,height:812});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);assert.deepEqual(errors,[]);
 console.log('PASS: actual member form rejects over-balance submission without request or retained intent; distinct pending requests do not reserve funds; actual staff payout rechecks depleted balance and leaves the refused request rejectable; changed product rule blocks payout and removes member eligibility; original staff recovery after restoring eligibility posts once and late replay adds no debit; exact 39.10, current status, mobile and reconciliation pass. Isolated synthetic staging only.');
}finally{await memberContext?.close();await staffContext?.close();await browser.close();for(const session of sessions)await call('/auth/logout',{token:session.tokens.accessToken,method:'POST',status:204});}
