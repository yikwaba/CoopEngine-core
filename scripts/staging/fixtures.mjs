import { verifyFixtures } from './verify.mjs';
import { validateStaging } from './guard.mjs';
validateStaging(process.env);
if(process.env.API_BASE!=='http://api:4399/api/v1') throw new Error('Fixture writes restricted to isolated Compose API');
const password=process.env.STAGING_LOGIN_PASSWORD;
if(!password || password.length<24) throw new Error('Generated staging password required');
const base=process.env.API_BASE;
async function request(path,body,token,method='POST') {
  const res=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
  if(!res.ok) throw new Error(`Fixture API failed: ${method} ${path} HTTP ${res.status}`);
  return res.json();
}
const login=await request('/auth/login',{email:'platform@recovery.invalid',password});
const rootToken=login.tokens?.accessToken;
if(!rootToken) throw new Error('Platform authentication failed');
// Each invocation creates a new explicitly synthetic pair; no existing tenant is edited.
const run=Date.now().toString(36);
const fixtures=[];
for(const suffix of ['a','b']) {
 const slug=`recovery-${suffix}-${run}`,adminEmail=`${slug}@recovery.invalid`;
 const org=await request('/organizations',{name:`SYNTHETIC Recovery ${suffix.toUpperCase()} ${run}`,slug,adminEmail,adminPassword:password},rootToken);
 const staff=await request('/auth/login',{email:adminEmail,password,organizationSlug:slug});
 const token=staff.tokens?.accessToken;
 if(!token) throw new Error('Tenant authentication failed');
 const members=[];
 for(let n=1;n<=3;n++) {
   const m=await request('/members',{firstName:`Synthetic${n}`,lastName:`Tenant${suffix.toUpperCase()}`,email:`member${n}-${slug}@recovery.invalid`},token);
   await request(`/members/${m.id}/approve`,{},token);
   members.push(m);
 }
 fixtures.push({id:org.id,token,members});
 console.log(`Created synthetic tenant: ${slug}; staff account: ${adminEmail}`);
}
console.log('Two synthetic tenants with three members each created; no money posted and no providers contacted.');

await verifyFixtures(fixtures,base);
