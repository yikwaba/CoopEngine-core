import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
assert.equal(process.env.COOPENGINE_BROWSER_TEST,'isolated-staging');assert.ok(process.env.BROWSER_TEST_MODULE_ROOT);
const require=createRequire(resolve(process.env.BROWSER_TEST_MODULE_ROOT,'browser-test.cjs')),{chromium}=require('playwright');
const password=(await readFile('.staging/compose.env','utf8')).match(/^STAGING_LOGIN_PASSWORD=(.+)$/m)?.[1].trim();assert.ok(password&&password.length>=24);
const api='http://localhost:4399/api/v1',portal='http://localhost:4310',memberPortal='http://localhost:4320';
async function call(path,{token,body,method=body?'POST':'GET',status=200}={}){const r=await fetch(api+path,{method,signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});assert.equal(r.status,status,`${method} ${path}`);return status===204?null:r.json();}
const dashboardDenials=[],sessions=[],browser=await chromium.launch({headless:true}),profile=await mkdtemp(join(tmpdir(),'coopengine-member-withdrawal-'));
let memberContext,releaseSend=()=>{};
try{
 const platform=await call('/auth/login',{body:{email:'platform@recovery.invalid',password}});sessions.push(platform);
 const slug=`withdrawal-form-${Date.now().toString(36)}`,email=`${slug}@recovery.invalid`;
 await call('/organizations',{token:platform.tokens.accessToken,status:201,body:{name:`SYNTHETIC ${slug}`,slug,adminEmail:email,adminPassword:password}});
 const maker=await call('/auth/login',{body:{email,password,organizationSlug:slug}});sessions.push(maker);const token=maker.tokens.accessToken,me=await call('/auth/me',{token}),org=me.organizationId;
 const member=await call('/members',{token,status:201,body:{firstName:'Policy',lastName:'Synthetic',email:`member-${slug}@recovery.invalid`}});await call(`/members/${member.id}/approve`,{token,method:'POST'});
 const primary=await call(`/savings/member/${member.id}/account`,{token,status:201,body:{}});
 const product=await call('/products/savings',{token,status:201,body:{code:'FORM-EXTRA',name:'Extra savings',interestRatePa:0,minDeposit:0,allowWithdrawal:true}});
 const account=await call(`/savings/member/${member.id}/account`,{token,status:201,body:{productId:product.id}});
 const blocked=await call('/products/savings',{token,status:201,body:{code:'FORM-BLOCKED',name:'Blocked savings',interestRatePa:0,minDeposit:0,allowWithdrawal:false}});await call(`/savings/member/${member.id}/account`,{token,status:201,body:{productId:blocked.id}});
 for(const a of [primary,account])await call(`/savings/accounts/${a.id}/deposits`,{token,status:201,body:{idempotencyKey:randomUUID(),amount:1.15}});
 const approvers=[];
 for(const role of ['TREASURER','CHAIRMAN']){const u=await call('/users',{token,status:201,body:{email:`${role.toLowerCase()}-${slug}@recovery.invalid`,roleCodes:[role]}});const login=await call('/auth/login',{body:{email:u.email,password:u.tempPassword,organizationSlug:slug}});sessions.push(login);approvers.push({email:u.email,password:u.tempPassword,token:login.tokens.accessToken});}
 assert.match(org,/^[0-9a-f-]{36}$/i);
 // Synthetic policy fixture: policy administration has no normal UI yet.
 const compose=['compose','--project-name','coopengine-recovery-staging','--env-file','.staging/compose.env','-f','staging/compose.yml'];
 execFileSync('docker',[...compose,'exec','-T','postgres','psql','-U','staging_admin','-d','coopengine_staging','-v','ON_ERROR_STOP=1','-c',`BEGIN; SELECT set_config('app.tenant_id','${org}',true); WITH p AS (INSERT INTO approval_policies (organization_id,kind,min_amount,max_amount,version) VALUES ('${org}','WITHDRAWAL',0,NULL,1) RETURNING id) INSERT INTO approval_policy_steps (organization_id,policy_id,step_no,approver_role_code) SELECT '${org}',p.id,s.n,s.role FROM p CROSS JOIN (VALUES (1,'TREASURER'),(2,'CHAIRMAN')) AS s(n,role); COMMIT;`],{stdio:'pipe',timeout:20000});
 const sends=[],errors=[];let arrived,r;const firstSend=new Promise(resolve=>arrived=resolve),gate=new Promise(resolve=>releaseSend=resolve);
 async function openMember(){
  memberContext=await chromium.launchPersistentContext(profile,{headless:true});
  await memberContext.route('**/*',route=>[memberPortal,'http://localhost:4399'].includes(new URL(route.request().url()).origin)?route.continue():route.abort());
  await memberContext.route('**/api/v1/member/withdrawals/request',async route=>{
   const payload=route.request().postDataJSON();sends.push(payload);
   if(sends.length===1){arrived();await gate;}
   const response=await route.fetch();assert.equal(response.status(),201);const result=await response.json();
   if(sends.length===1){r=result;await route.abort('failed');}else await route.fulfill({response});
  });
  const watch=p=>{p.setDefaultTimeout(20000);p.on('pageerror',e=>errors.push(e.name));};for(const p of memberContext.pages())watch(p);memberContext.on('page',watch);
  return memberContext.pages()[0]??memberContext.newPage();
 }
 async function memberLogin(page){
  await page.goto(memberPortal+'/login');await page.getByLabel('Cooperative',{exact:true}).fill(slug);await page.getByLabel('Email',{exact:true}).fill(`member-${slug}@recovery.invalid`);
  const received=page.waitForResponse(x=>x.url()===api+'/auth/member/request-otp'&&x.status()===200);await page.getByRole('button',{name:'Send me a code',exact:true}).click();const otp=await(await received).json();await page.getByLabel('6-digit code',{exact:true}).fill(otp.devCode);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForURL(memberPortal+'/');
 }
 const label='SYNTHETIC member form withdrawal';let page=await openMember();await memberLogin(page);await page.goto(memberPortal+'/savings');await page.getByRole('heading',{name:'My savings',exact:true}).waitFor();
 await page.waitForFunction(()=>document.querySelector('select')?.options.length===3);assert.equal(await page.getByLabel('Savings account',{exact:true}).locator('option').filter({hasText:'Blocked savings'}).count(),0);
 await page.getByLabel('Savings account',{exact:true}).selectOption(account.id);await page.getByLabel('Withdrawal amount (₦)',{exact:true}).fill('0.99');await page.getByRole('button',{name:'Submit withdrawal request',exact:true}).click();await page.getByText(/Amount must be between/).waitFor();assert.equal(sends.length,0);
 await page.getByLabel('Withdrawal amount (₦)',{exact:true}).fill('1.01');await page.getByLabel('Reason for withdrawal',{exact:true}).fill(label);
 const observer=await memberContext.newPage();await observer.goto(memberPortal+'/savings');await observer.waitForFunction(()=>document.querySelector('select')?.options.length===3);
 await page.getByRole('button',{name:'Submit withdrawal request',exact:true}).click();let timeout;try{await Promise.race([firstSend,new Promise((_,reject)=>timeout=setTimeout(()=>reject(new Error('Form did not send')),20000))]);}finally{clearTimeout(timeout);}
 await observer.waitForFunction(()=>Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Submit withdrawal request')?.disabled);assert.equal(sends.length,1);assert.equal(await observer.getByLabel('Withdrawal amount (₦)',{exact:true}).isDisabled(),true);releaseSend();
 await page.getByRole('complementary',{name:'Financial request recovery'}).waitFor();await page.getByText(/Failed to fetch|NetworkError|fetch failed/).waitFor();
 const original=await page.evaluate(()=>Object.entries(localStorage).filter(([key])=>key.startsWith('coopengine-payment:')));assert.equal(original.length,1);const stored=JSON.parse(original[0][1]);assert.equal(JSON.parse(stored.payload).accountId,account.id);assert.equal(JSON.parse(stored.payload).amount,1.01);
 const balance=async()=>String((await call(`/savings/accounts/${account.id}`,{token})).currentBalance);assert.equal(await balance(),'1.15');
 await memberContext.close();page=await openMember();await memberLogin(page);await page.goto(memberPortal+'/savings');await page.getByRole('complementary',{name:'Financial request recovery'}).waitFor();
 assert.deepEqual(await page.evaluate(()=>Object.entries(localStorage).filter(([key])=>key.startsWith('coopengine-payment:'))),original);
 assert.equal(await page.getByLabel('Savings account',{exact:true}).inputValue(),account.id);assert.equal(await page.getByLabel('Withdrawal amount (₦)',{exact:true}).inputValue(),'1.01');assert.equal(await page.getByLabel('Reason for withdrawal',{exact:true}).inputValue(),label);assert.equal(await page.getByRole('button',{name:'Submit withdrawal request',exact:true}).isDisabled(),true);
 const currentRow=()=>page.getByRole('article',{name:label,exact:true});await currentRow().getByText('Awaiting approval · step 1 of 2',{exact:true}).waitFor();
 const body={description:label};
 const memberPage=page;
 for(let i=0;i<approvers.length;i++){
  const context=await browser.newContext();await context.route('**/*',route=>[portal,'http://localhost:4399'].includes(new URL(route.request().url()).origin)?route.continue():route.abort());
  try{const page=await context.newPage(),errors=[];page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.name));page.on('response',r=>{if(r.status()===403&&r.url().endsWith('/members'))dashboardDenials.push(r.status());});page.on('dialog',d=>d.accept());
   await page.goto(portal+'/login');await page.getByLabel('Email',{exact:true}).fill(approvers[i].email);await page.getByLabel('Password',{exact:true}).fill(approvers[i].password);await page.getByLabel(/^Cooperative /).fill(slug);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('heading',{name:'Dashboard',exact:true}).waitFor();
   await page.goto(portal+'/approvals');await page.getByRole('heading',{name:'Needs a decision',exact:true}).waitFor();await page.getByRole('link',{name:'Decide there',exact:true}).click();await page.getByRole('heading',{name:'Withdrawal approvals',exact:true}).waitFor();
   const row=page.locator('tbody tr').filter({hasText:body.description});await row.waitFor();const response=page.waitForResponse(x=>x.url()===api+`/savings/withdrawals/${r.requestId}/approve`&&x.status()===200);await row.getByRole('button',{name:'Approve',exact:true}).click();const result=await(await response).json();assert.equal(result.approvalStatus,i===0?'PENDING':'APPROVED');assert.equal(await balance(),i===0?'1.15':'0.14');await memberPage.getByRole('button',{name:'Refresh savings and requests',exact:true}).click();await currentRow().getByText(i===0?'Awaiting approval · step 2 of 2':'Approved and paid',{exact:true}).waitFor();
   await page.setViewportSize({width:375,height:812});assert.deepEqual(errors,[]);
  }finally{await context.close();}
 }
 await page.getByRole('button',{name:'Recover original request',exact:true}).click();await page.getByText('The original request has been acknowledged. Refresh the account view to see the current balance or status.',{exact:true}).waitFor();
 assert.equal(sends.length,2);assert.deepEqual(sends[0],sends[1]);await currentRow().getByText('Approved and paid',{exact:true}).waitFor();assert.equal(await balance(),'0.14');assert.equal(await page.getByRole('button',{name:'Submit withdrawal request',exact:true}).isDisabled(),false);
 const own=await page.evaluate(async api=>(await fetch(api+'/member/withdrawals',{credentials:'include'})).json(),api);assert.equal(own.length,1);assert.equal(own[0].status,'APPROVED');assert.equal(String((await call(`/savings/accounts/${primary.id}`,{token})).currentBalance),'1.15');
 await page.getByLabel('Savings account',{exact:true}).selectOption(primary.id);await page.getByLabel('Withdrawal amount (₦)',{exact:true}).fill('1.00');await page.getByLabel('Reason for withdrawal',{exact:true}).fill('SYNTHETIC rejected form request');const rejectedResponse=page.waitForResponse(x=>x.url()===api+'/member/withdrawals/request'&&x.status()===201);await page.getByRole('button',{name:'Submit withdrawal request',exact:true}).click();const rejected=await(await rejectedResponse).json();
 await call(`/savings/withdrawals/${rejected.requestId}/reject`,{token:approvers[0].token,body:{expectedStepNo:1,notes:'SYNTHETIC cooperative review note'}});await page.getByRole('button',{name:'Refresh savings and requests',exact:true}).click();const rejectedRow=page.getByRole('article',{name:'SYNTHETIC rejected form request',exact:true});await rejectedRow.getByText('Rejected — no payout',{exact:true}).waitFor();await rejectedRow.getByText('Cooperative note: SYNTHETIC cooperative review note',{exact:true}).waitFor();assert.equal(String((await call(`/savings/accounts/${primary.id}`,{token})).currentBalance),'1.15');
 await page.setViewportSize({width:375,height:812});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);assert.equal((await call('/reports/savings-reconciliation',{token})).balanced,true);assert.deepEqual(errors,[]);
 console.log('PASS: actual member withdrawal form selects an eligible own account, excludes blocked product and rejects sub-minimum money before send; competing tab locks; lost committed response survives full persistent-browser restart with original account/amount/reason/key/scope; actual staff screens progress both approval steps; one selected-account debit, unchanged other account; recovery replays the original acknowledgement without resurrecting current status; rejection note, exact balances and mobile width pass. Synthetic isolated staging only.');
}finally{releaseSend();await memberContext?.close();await browser.close();await rm(profile,{recursive:true,force:true});for(const session of sessions)await call('/auth/logout',{token:session.tokens.accessToken,method:'POST',status:204});}
