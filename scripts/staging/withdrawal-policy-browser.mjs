import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
assert.equal(process.env.COOPENGINE_BROWSER_TEST,'isolated-staging');assert.ok(process.env.BROWSER_TEST_MODULE_ROOT);
const require=createRequire(resolve(process.env.BROWSER_TEST_MODULE_ROOT,'browser-test.cjs')),{chromium}=require('playwright');
const password=(await readFile('.staging/compose.env','utf8')).match(/^STAGING_LOGIN_PASSWORD=(.+)$/m)?.[1].trim();assert.ok(password&&password.length>=24);
const api='http://localhost:4399/api/v1',portal='http://localhost:4310';
async function call(path,{token,body,method=body?'POST':'GET',status=200}={}){const r=await fetch(api+path,{method,signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});assert.equal(r.status,status,`${method} ${path}`);return status===204?null:r.json();}
const dashboardDenials=[],sessions=[],browser=await chromium.launch({headless:true});
try{
 const platform=await call('/auth/login',{body:{email:'platform@recovery.invalid',password}});sessions.push(platform);
 const slug=`withdrawal-policy-${Date.now().toString(36)}`,email=`${slug}@recovery.invalid`;
 await call('/organizations',{token:platform.tokens.accessToken,status:201,body:{name:`SYNTHETIC ${slug}`,slug,adminEmail:email,adminPassword:password}});
 const maker=await call('/auth/login',{body:{email,password,organizationSlug:slug}});sessions.push(maker);const token=maker.tokens.accessToken,me=await call('/auth/me',{token}),org=me.organizationId;
 const member=await call('/members',{token,status:201,body:{firstName:'Policy',lastName:'Synthetic'}});await call(`/members/${member.id}/approve`,{token,method:'POST'});
 const account=await call(`/savings/member/${member.id}/account`,{token,status:201,body:{}});await call(`/savings/accounts/${account.id}/deposits`,{token,status:201,body:{idempotencyKey:randomUUID(),amount:1.15}});
 const approvers=[];
 for(const role of ['TREASURER','CHAIRMAN']){const u=await call('/users',{token,status:201,body:{email:`${role.toLowerCase()}-${slug}@recovery.invalid`,roleCodes:[role]}});const login=await call('/auth/login',{body:{email:u.email,password:u.tempPassword,organizationSlug:slug}});sessions.push(login);approvers.push({email:u.email,password:u.tempPassword,token:login.tokens.accessToken});}
 assert.match(org,/^[0-9a-f-]{36}$/i);
 // Synthetic policy fixture: policy administration has no normal UI yet.
 const compose=['compose','--project-name','coopengine-recovery-staging','--env-file','.staging/compose.env','-f','staging/compose.yml'];
 execFileSync('docker',[...compose,'exec','-T','postgres','psql','-U','staging_admin','-d','coopengine_staging','-v','ON_ERROR_STOP=1','-c',`BEGIN; SELECT set_config('app.tenant_id','${org}',true); WITH p AS (INSERT INTO approval_policies (organization_id,kind,min_amount,max_amount,version) VALUES ('${org}','WITHDRAWAL',0,NULL,1) RETURNING id) INSERT INTO approval_policy_steps (organization_id,policy_id,step_no,approver_role_code) SELECT '${org}',p.id,s.n,s.role FROM p CROSS JOIN (VALUES (1,'TREASURER'),(2,'CHAIRMAN')) AS s(n,role); COMMIT;`],{stdio:'pipe',timeout:20000});
 const body={idempotencyKey:randomUUID(),amount:0.01,description:'SYNTHETIC active policy with null threshold'},r=await call(`/savings/accounts/${account.id}/withdrawals`,{token,body});assert.equal(r.kind,'PENDING');assert.deepEqual(await call(`/savings/accounts/${account.id}/withdrawals`,{token,body}),r);
 const balance=async()=>{const b=await call('/reports/savings-book',{token});return b.rows.find(x=>x.memberId===member.id).balanceDecimal;};assert.equal(await balance(),'1.15');
 await call(`/savings/withdrawals/${r.requestId}/approve`,{token,body:{expectedStepNo:1},status:409});await call(`/savings/withdrawals/${r.requestId}/approve`,{token:approvers[1].token,body:{expectedStepNo:1},status:403});
 for(let i=0;i<approvers.length;i++){
  const context=await browser.newContext();await context.route('**/*',route=>[portal,'http://localhost:4399'].includes(new URL(route.request().url()).origin)?route.continue():route.abort());
  try{const page=await context.newPage(),errors=[];page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.name));page.on('response',r=>{if(r.status()===403&&r.url().endsWith('/members'))dashboardDenials.push(r.status());});page.on('dialog',d=>d.accept());
   await page.goto(portal+'/login');await page.getByLabel('Email',{exact:true}).fill(approvers[i].email);await page.getByLabel('Password',{exact:true}).fill(approvers[i].password);await page.getByLabel(/^Cooperative /).fill(slug);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('heading',{name:'Dashboard',exact:true}).waitFor();
   await page.goto(portal+'/approvals');await page.getByRole('heading',{name:'Needs a decision',exact:true}).waitFor();await page.getByRole('link',{name:'Decide there',exact:true}).click();await page.getByRole('heading',{name:'Withdrawal approvals',exact:true}).waitFor();
   const row=page.locator('tbody tr').filter({hasText:body.description});await row.waitFor();const response=page.waitForResponse(x=>x.url()===api+`/savings/withdrawals/${r.requestId}/approve`&&x.status()===200);await row.getByRole('button',{name:'Approve',exact:true}).click();const result=await(await response).json();assert.equal(result.approvalStatus,i===0?'PENDING':'APPROVED');assert.equal(await balance(),i===0?'1.15':'1.14');
   await page.setViewportSize({width:375,height:812});assert.deepEqual(errors,[]);
  }finally{await context.close();}
 }
 assert.ok(dashboardDenials.length>0,'A restricted dashboard response does not erase approver sign-in');
 const final=await call(`/savings/withdrawals/${r.requestId}/approve`,{token:approvers[1].token,body:{expectedStepNo:2}});assert.equal(final.approvalStatus,'APPROVED');assert.equal(await balance(),'1.14');assert.equal((await call('/reports/savings-reconciliation',{token})).balanced,true);
 console.log('PASS: active staff withdrawal policy overrides null legacy threshold; request retry is stable; maker and wrong role refused; actual inbox and withdrawal screens enforce ordered treasurer/chairman steps, no first-step payout and one exact final debit; final retry and savings reconciliation pass. Synthetic isolated staging only.');
}finally{await browser.close();for(const s of sessions)await call('/auth/logout',{token:s.tokens.accessToken,method:'POST',status:204});}
