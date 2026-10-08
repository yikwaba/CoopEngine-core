import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
assert.equal(process.env.COOPENGINE_BROWSER_TEST,'isolated-staging');
assert.ok(process.env.BROWSER_TEST_MODULE_ROOT);
const require=createRequire(resolve(process.env.BROWSER_TEST_MODULE_ROOT,'browser-test.cjs'));
const {chromium}=require('playwright');
const password=(await readFile('.staging/compose.env','utf8')).match(/^STAGING_LOGIN_PASSWORD=(.+)$/m)?.[1].trim();assert.ok(password&&password.length>=24);
const api='http://localhost:4399/api/v1',portal='http://localhost:4310';
async function call(path,{token,body,method=body?'POST':'GET',status=200}={}){const r=await fetch(api+path,{method,signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});assert.equal(r.status,status,`${method} ${path}`);return status===204?null:r.json();}
const compose=['compose','--project-name','coopengine-recovery-staging','--env-file','.staging/compose.env','-f','staging/compose.yml'];
const profile=await mkdtemp(join(tmpdir(),'coopengine-exact-reports-'));let context,staff,checker;
const platform=await call('/auth/login',{body:{email:'platform@recovery.invalid',password}});
try{
 const slug=`exact-reports-${Date.now().toString(36)}`,email=`${slug}@recovery.invalid`;
 await call('/organizations',{token:platform.tokens.accessToken,status:201,body:{name:`SYNTHETIC ${slug}`,slug,adminEmail:email,adminPassword:password}});
 staff=await call('/auth/login',{body:{email,password,organizationSlug:slug}});
 const token=staff.tokens.accessToken,me=await call('/auth/me',{token}),org=me.organizationId;
 const member=await call('/members',{token,status:201,body:{firstName:'Exact',lastName:'Synthetic'}});await call(`/members/${member.id}/approve`,{token,method:'POST'});
 const account=await call(`/savings/member/${member.id}/account`,{token,status:201,body:{}});
 const invited=await call('/users',{token,status:201,body:{email:`checker-${slug}@recovery.invalid`,roleCodes:['COOP_ADMIN']}});checker=await call('/auth/login',{body:{email:invited.email,password:invited.tempPassword}});
 const body={idempotencyKey:randomUUID(),entryDate:new Date().toISOString().slice(0,10),description:'SYNTHETIC exact report opening',lines:[{accountCode:'1000',debit:'90071992547409.91',memberId:member.id},{accountCode:'2000',credit:'90071992547409.91',memberId:member.id}]};
 const journal=await call('/ledger/journals',{token,status:201,body});await call(`/ledger/journals/${journal.id}/submit`,{token,body:{}});await call(`/ledger/journals/${journal.id}/approve-post`,{token:checker.tokens.accessToken,body:{}});
 // Synthetic precision fixture only: no guard disabling, no production access.
 for(const id of [org,account.id])assert.match(id,/^[0-9a-f-]{36}$/i);
 const seed=value=>execFileSync('docker',[...compose,'exec','-T','postgres','psql','-U','staging_admin','-d','coopengine_staging','-v','ON_ERROR_STOP=1','-c',`BEGIN; SELECT set_config('app.tenant_id','${org}',true); UPDATE member_savings_accounts SET current_balance='${value}'::numeric WHERE organization_id='${org}' AND id='${account.id}'; COMMIT;`],{stdio:'pipe',timeout:20000});
 seed('90071992547409.91');await call(`/savings/accounts/${account.id}/deposits`,{token,status:201,body:{idempotencyKey:randomUUID(),amount:0.01}});
 assert.equal((await call('/reports/savings-reconciliation',{token})).matched,1);
 context=await chromium.launchPersistentContext(join(profile,'browser'),{headless:true});await context.route('**/*',route=>[portal,'http://localhost:4399'].includes(new URL(route.request().url()).origin)?route.continue():route.abort());
 const page=context.pages()[0]??await context.newPage(),errors=[];page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.name));
 await page.goto(portal+'/login');await page.getByLabel('Email',{exact:true}).fill(email);await page.getByLabel('Password',{exact:true}).fill(password);await page.getByLabel(/^Cooperative /).fill(slug);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('heading',{name:'Dashboard',exact:true}).waitFor();await page.getByText('90,071,992,547,409.92',{exact:true}).waitFor();
 await page.goto(portal+`/members/${member.id}`);await page.getByText('₦90,071,992,547,409.92',{exact:true}).first().waitFor();
 await page.goto(portal+'/analytics');await page.getByRole('heading',{name:'Analytics & board pack',exact:true}).waitFor();await page.getByText('₦90,071,992,547,409.92',{exact:true}).first().waitFor();
 let download=page.waitForEvent('download');await page.getByRole('button',{name:'Download board pack (CSV)',exact:true}).click();let file=await download;const csv=await readFile(await file.path(),'utf8');assert.ok(csv.includes('savings,totalBalance,90071992547409.92'));
 download=page.waitForEvent('download');await page.getByRole('button',{name:'Download board pack (Excel)',exact:true}).click();file=await download;
 const xlsxPath=await file.path();const xml=execFileSync('unzip',['-p',xlsxPath,'xl/sharedStrings.xml'],{encoding:'utf8'});assert.ok(xml.includes('90071992547409.92'),'Spreadsheet shared strings retain exact amount');
 download=page.waitForEvent('download');await page.getByRole('button',{name:'Board pack (PDF)',exact:true}).click();file=await download;const pdfPath=await file.path();const text=execFileSync('pdftotext',['-layout',pdfPath,'-'],{encoding:'utf8'});assert.ok(text.includes('NGN 90,071,992,547,409.92'),'Actual downloaded PDF retains exact digits');assert.ok(text.includes('Balanced: yes'));
 const pdf=await fetch(api+`/pdf/members/${member.id}/statement.pdf`,{headers:{Authorization:`Bearer ${token}`}});assert.equal(pdf.status,200);const statement=join(profile,'statement.pdf');await writeFile(statement,Buffer.from(await pdf.arrayBuffer()));const statementText=execFileSync('pdftotext',['-layout',statement,'-'],{encoding:'utf8'});assert.ok(statementText.includes('Opening balance: NGN 90,071,992,547,409.91'));assert.ok(statementText.includes('Closing balance: NGN 90,071,992,547,409.92'));
 // Add later activity, then place both synthetic transactions on fixed dates.
 await call(`/savings/accounts/${account.id}/deposits`,{token,status:201,body:{idempotencyKey:randomUUID(),amount:0.01}});
 execFileSync('docker',[...compose,'exec','-T','postgres','psql','-U','staging_admin','-d','coopengine_staging','-v','ON_ERROR_STOP=1','-c',`BEGIN; SELECT set_config('app.tenant_id','${org}',true); UPDATE savings_transactions SET created_at=CASE WHEN running_balance=90071992547409.92 THEN '2026-01-10T12:00:00Z'::timestamptz ELSE '2026-03-10T12:00:00Z'::timestamptz END WHERE organization_id='${org}' AND account_id='${account.id}'; COMMIT;`],{stdio:'pipe',timeout:20000});
 for(const [range,opening,closing] of [
  ['from=2026-01-01&to=2026-01-31','91','92'],
  ['from=2026-02-01&to=2026-02-28','92','92'],
  ['to=2025-12-31','91','91'],
  ['from=2027-01-01','93','93'],
 ]){
  const response=await fetch(api+`/pdf/members/${member.id}/statement.pdf?${range}`,{headers:{Authorization:`Bearer ${token}`}});assert.equal(response.status,200);
  await writeFile(statement,Buffer.from(await response.arrayBuffer()));const contents=execFileSync('pdftotext',['-layout',statement,'-'],{encoding:'utf8'});
  assert.ok(contents.includes(`Opening balance: NGN 90,071,992,547,409.${opening}`),range+' opening');
  assert.ok(contents.includes(`Closing balance: NGN 90,071,992,547,409.${closing}`),range+' closing');
 }
 console.log('PASS: historical member PDF closing, empty intervening period, before-first and after-last periods preserve exact balances despite later activity.');
 seed('90071992547409.94');const mismatch=await call('/reports/savings-reconciliation',{token});assert.equal(mismatch.mismatches[0].diffDecimal,'0.01','One-kobo discrepancy survives unsafe-number boundary');
 await page.setViewportSize({width:375,height:812});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Mobile analytics fits');assert.deepEqual(errors,[]);
 console.log('PASS: synthetic large balances match exact ledger; actual dashboard/member/analytics display and browser CSV/XLSX/PDF downloads preserve every kobo; member PDF opening/closing subtraction exact; one-kobo reconciliation discrepancy detected; mobile fits. Boundary fixture only, no production/provider access or historical reconciliation claim.');
}finally{await context?.close();await rm(profile,{recursive:true,force:true});for(const login of [checker,staff,platform])if(login)await call('/auth/logout',{token:login.tokens.accessToken,method:'POST',status:204});}
