import { randomBytes } from 'node:crypto';
import { mkdir,writeFile,readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const sha=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
await mkdir(root+'.staging',{recursive:true,mode:0o700});
const names=['STAGING_ADMIN_PASSWORD','STAGING_OWNER_PASSWORD','STAGING_APP_PASSWORD','STAGING_LOGIN_PASSWORD','STAGING_JWT_SECRET','STAGING_CRON_SECRET','STAGING_WEBHOOK_SECRET'];
const text=['STAGING_SOURCE_SHA='+sha,...names.map(n=>n+'='+randomBytes(32).toString('hex'))].join('\n')+'\n';
try {await writeFile(root+'.staging/compose.env',text,{flag:'wx',mode:0o600});console.log('Generated private staging configuration. Passwords not printed.');}
catch(e){if(e.code==='EEXIST'){const existing=await readFile(root+'.staging/compose.env','utf8');
 const updated=existing.replace(/^STAGING_SOURCE_SHA=.*$/m,'STAGING_SOURCE_SHA='+sha);
 await writeFile(root+'.staging/compose.env',updated,{mode:0o600});
 console.log('Existing credentials preserved; source identity refreshed.');}else throw e;}
