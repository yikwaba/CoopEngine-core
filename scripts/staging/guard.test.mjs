import test from 'node:test';
import assert from 'node:assert/strict';
import { validateStaging } from './guard.mjs';
const valid={COOPENGINE_ENVIRONMENT:'isolated-staging',DATABASE_URL:'postgresql://staging_app:test@postgres:5432/coopengine_staging',MEMBER_OTP_PROVIDER:'dev',MONNIFY_PROVIDER:'dev'};
test('dedicated simulated configuration accepted',()=>assert.doesNotThrow(()=>validateStaging(valid)));
for(const [label,patch] of [
 ['live database',{DATABASE_URL:'postgresql://staging_app:test@api.coopengine.com.ng:5432/coopengine_staging'}],
 ['wrong database',{DATABASE_URL:'postgresql://staging_app:test@postgres:5432/coopengine'}],
 ['superuser',{DATABASE_URL:'postgresql://staging_admin:test@postgres:5432/coopengine_staging'}],
 ['missing marker',{COOPENGINE_ENVIRONMENT:''}],
 ['real SMS key',{TERMII_API_KEY:'fixture-key'}],
 ['real email',{SMTP_HOST:'smtp.example.invalid'}],
 ['real payments',{MONNIFY_PROVIDER:'monnify'}],
 ['real OTP',{MEMBER_OTP_PROVIDER:'termii'}],
]) test(`rejects ${label}`,()=>assert.throws(()=>validateStaging({...valid,...patch})));
