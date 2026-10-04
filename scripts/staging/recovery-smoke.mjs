import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { validateStaging } from './guard.mjs';

// Local/disposable isolated staging only. Existing synthetic records are read;
// writes are limited to login/session/audit rows. No credentials are printed.
validateStaging(process.env);
const base = process.env.API_BASE;
if (base !== 'http://api:4399/api/v1') throw new Error('Smoke checks require the isolated Compose API');
const password = process.env.STAGING_LOGIN_PASSWORD;
if (!password || password.length < 24) throw new Error('Private synthetic login configuration is required');
const require = createRequire(new URL('../../packages/db/package.json', import.meta.url));
const { Client } = require('pg');
const db = new Client({ connectionString: process.env.DATABASE_URL });
const active = new Set();
async function call(path, { token, body, status = 200, method = body ? 'POST' : 'GET', cookie = false } = {}) {
  const response = await fetch(base + path, {
    method, signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', ...(token ? cookie ? { Cookie: `ce_at=${token}` } : { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal(response.status, status, `Smoke check failed: ${method} ${path} expected HTTP ${status}`);
  return status === 204 ? null : response.json();
}
async function login(email) {
  const response = await call('/auth/login', { body: { email, password } });
  assert.ok(response.tokens?.accessToken, 'Synthetic sign-in must issue a session');
  active.add(response.tokens.accessToken); return response.tokens;
}
async function logout(token) {
  await call('/auth/logout', { token, method: 'POST', status: 204 }); active.delete(token);
}
await db.connect();
try {
  const role = (await db.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
  assert.equal(role.rolsuper, false); assert.equal(role.rolbypassrls, false);
  const account = (await db.query(`SELECT u.email FROM users u
    WHERE u.status='ACTIVE' AND u.email LIKE 'recovery-a-%@recovery.invalid'
    ORDER BY u.created_at DESC LIMIT 1`)).rows[0];
  assert.ok(account, 'An existing synthetic tenant A account is required');
  const platform = await login('platform@recovery.invalid');
  await call('/auth/me', { token: platform.accessToken });
  const first = await login(account.email); const independent = await login(account.email);
  const members = await call('/members', { token: first.accessToken, cookie: true });
  assert.ok(Array.isArray(members) && members.length, 'Synthetic member list must load');
  await call(`/members/${members[0].id}`, { token: first.accessToken, cookie: true });
  await call('/products/savings', { token: first.accessToken });
  const rotated = await call('/auth/refresh', { body: { refreshToken: first.refreshToken } });
  active.add(rotated.accessToken);
  await call('/auth/me', { token: first.accessToken, status: 401 });
  await call('/auth/me', { token: rotated.accessToken, cookie: true });
  await logout(first.accessToken);
  await call('/auth/me', { token: rotated.accessToken, status: 401 }); active.delete(rotated.accessToken);
  await call('/auth/refresh', { body: { refreshToken: rotated.refreshToken }, status: 401 });
  await call('/auth/me', { token: independent.accessToken });
  await logout(independent.accessToken); await logout(platform.accessToken);
  console.log('PASS: synthetic platform/staff sign-in, cookie member list/detail, products, one-use refresh, predecessor logout and independent device session. No money/provider operations performed.');
} finally {
  for (const token of active) { try { await logout(token); } catch { console.error('Smoke session cleanup failed; no credentials printed'); } }
  await db.end();
}
