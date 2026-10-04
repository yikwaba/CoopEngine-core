import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

// Disposable/local isolated Compose only. No production host, existing-user
// edits, money movement, provider calls, traces, screenshots or secret logs.
assert.equal(process.env.COOPENGINE_BROWSER_TEST, 'isolated-staging', 'Explicit isolated browser-test marker required');
assert.ok(process.env.BROWSER_TEST_MODULE_ROOT, 'Ephemeral test modules required');
const require = createRequire(resolve(process.env.BROWSER_TEST_MODULE_ROOT, 'browser-test.cjs'));
const { chromium } = require('playwright');
const { generateSync } = require('otplib/functional');
const settings = await readFile('.staging/compose.env', 'utf8');
assert.equal((settings.match(/^STAGING_LOGIN_PASSWORD=/gm) ?? []).length, 1, 'One private synthetic password required');
const password = settings.match(/^STAGING_LOGIN_PASSWORD=(.+)$/m)?.[1].trim();
assert.ok(password && password.length >= 24, 'Generated synthetic password required');
const api = 'http://localhost:4399/api/v1';
const portal = 'http://localhost:4310';
async function call(path, { body, token, method = body ? 'POST' : 'GET', status = 200 } = {}) {
  const res = await fetch(api + path, { method, signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal(res.status, status, `Synthetic MFA API check failed: ${method} ${path}`);
  return status === 204 ? null : res.json();
}
const platform = await call('/auth/login', { body: { email: 'platform@recovery.invalid', password } });
const slug = `mfa-browser-${Date.now().toString(36)}`, email = `${slug}@recovery.invalid`;
try {
  await call('/organizations', { token: platform.tokens.accessToken, status: 201,
    body: { name: `SYNTHETIC MFA Browser ${slug}`, slug, adminEmail: email, adminPassword: password } });
  const staff = await call('/auth/login', { body: { email, password, organizationSlug: slug } });
  await call('/settings', { token: staff.tokens.accessToken, method: 'PATCH', body: { security: { mfaRequiredForPrivilegedRoles: true } } });
  await call('/auth/me', { token: staff.tokens.accessToken, status: 401 });
  await call('/auth/logout', { token: staff.tokens.accessToken, method: 'POST', status: 204 });
} finally {
  await call('/auth/logout', { token: platform.tokens.accessToken, method: 'POST', status: 204 });
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ acceptDownloads: true });
// Even browser assets/redirects may only visit the two loopback test origins.
await context.route('**/*', route => {
  const url = new URL(route.request().url());
  return [portal, 'http://localhost:4399'].includes(url.origin) ? route.continue() : route.abort();
});
const page = await context.newPage();
page.setDefaultTimeout(20000);
const pageErrors = [], failedRequests = [];
page.on('pageerror', error => { pageErrors.push({ name: error.name, message: error.message.replace(/[a-f0-9]{32,}/gi, '[redacted]').slice(0, 200) }); });
page.on('requestfailed', req => { const url = new URL(req.url()); failedRequests.push({ origin: url.origin, path: url.pathname, error: req.failure()?.errorText }); });
async function responseTo(path, action) {
  const pending = page.waitForResponse(res => res.url() === api + path && res.request().method() === 'POST');
  await action(); const res = await pending;
  assert.equal(res.status(), 200, `Browser MFA endpoint failed: ${path}`);
  assert.equal(res.headers()['cache-control'], 'no-store', 'Sensitive MFA response must not be cached');
  return res.json();
}
async function signIn() {
  await page.goto(portal + '/login');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel(/^Cooperative /).fill(slug);
  return responseTo('/auth/login', () => page.getByRole('button', { name: 'Sign in', exact: true }).click());
}
async function finishSetup() {
  await page.getByRole('heading', { name: 'Set up two-step verification' }).waitFor();
  const secret = (await page.getByTestId('mfa-setup-secret').textContent()).trim();
  await page.getByLabel('Authenticator code', { exact: true }).fill(generateSync({ secret }));
  const enrolled = await responseTo('/auth/mfa/enroll', () => page.getByRole('button', { name: 'Finish setup', exact: true }).click());
  assert.ok(enrolled.tokens?.accessToken, 'Enrollment must issue a verified session');
  await page.getByRole('heading', { name: 'Save your recovery codes' }).waitFor();
  const codes = (await page.getByRole('textbox', { name: 'Recovery codes', exact: true }).inputValue()).split('\n');
  assert.equal(codes.length, 10, 'Browser must show ten recovery codes');
  assert.ok(codes.every(code => /^[a-f0-9]{8}(-[a-f0-9]{8}){3}$/.test(code)), 'Recovery code format');
  const local = await page.evaluate(() => JSON.stringify(localStorage));
  assert.ok(!local.includes(secret) && !local.includes(codes[0]) && !local.includes(enrolled.tokens.accessToken), 'No MFA secret, backup code or access token in localStorage');
  return { secret, codes, tokens: enrolled.tokens };
}
async function acknowledge() {
  await page.getByRole('button', { name: 'I have saved my codes', exact: true }).click();
  await page.getByRole('heading', { name: 'Dashboard', exact: true }).waitFor();
  await page.getByText('No members yet.', { exact: true }).waitFor();
  assert.equal((await context.request.get(api + '/auth/me')).status(), 200, 'Dashboard session cookie is valid');
}
async function signOut() {
  assert.ok(await page.evaluate(() => localStorage.getItem('coopengine_session') === 'cookie'), 'Session marker must survive recovery-code management');
  await page.goto(portal + '/');
  await page.getByText('No members yet.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.waitForURL(portal + '/login');
}
try {
  const limited = await signIn();
  assert.ok(limited.requiresMfaEnrollment && !limited.tokens, 'Required enrollment must grant no ordinary session');
  await call('/auth/me', { token: limited.mfaToken, status: 401 });
  const first = await finishSetup();
  const downloadPending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download recovery codes' }).click();
  const download = await downloadPending;
  assert.equal(download.suggestedFilename(), 'coopengine-recovery-codes.txt');
  const stream = await download.createReadStream(); let downloaded = '';
  for await (const chunk of stream) downloaded += chunk.toString();
  assert.ok(downloaded.includes(first.codes[0]), 'Recovery-code download must contain displayed codes');
  await acknowledge();

  await page.goto(portal + '/security');
  await page.getByRole('heading', { name: 'Security', exact: true }).waitFor();
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel(/^Authenticator code /).fill(generateSync({ secret: first.secret }));
  const regenerated = await responseTo('/auth/mfa/recovery-codes', () => page.getByRole('button', { name: 'Generate recovery codes', exact: true }).click());
  assert.equal(regenerated.recoveryCodes.length, 10);
  await page.getByRole('heading', { name: 'Save your recovery codes' }).waitFor();
  await page.getByRole('button', { name: 'I have saved my codes', exact: true }).click();
  await signOut();

  const challenge = await signIn();
  assert.ok(challenge.requiresMfa && !challenge.tokens, 'Authenticator sign-in must be limited until verified');
  await page.getByLabel('Authenticator code', { exact: true }).fill(generateSync({ secret: first.secret }));
  await responseTo('/auth/mfa/login-verify', () => page.getByRole('button', { name: 'Verify code', exact: true }).click());
  await page.getByRole('heading', { name: 'Dashboard', exact: true }).waitFor();
  await call('/auth/mfa/login-verify', { status: 401, body: { mfaToken: challenge.mfaToken, code: generateSync({ secret: first.secret }), organizationSlug: slug } });
  await signOut();

  const recoveryChallenge = await signIn();
  await page.getByRole('button', { name: 'Use a recovery code', exact: true }).click();
  await page.getByLabel('Recovery code', { exact: true }).fill(regenerated.recoveryCodes[0]);
  const recovery = await responseTo('/auth/mfa/recover', () => page.getByRole('button', { name: 'Recover authenticator', exact: true }).click());
  assert.ok(recovery.requiresMfaEnrollment && !recovery.tokens, 'Recovery must grant replacement enrollment, not an ordinary session');
  await call('/auth/me', { token: recovery.mfaToken, status: 401 });
  const replacement = await finishSetup();
  assert.ok(replacement.secret !== first.secret && !replacement.codes.includes(regenerated.recoveryCodes[0]), 'Recovery must replace factor and backup codes');
  await acknowledge();
  await call('/auth/mfa/recover', { status: 401, body: { mfaToken: recoveryChallenge.mfaToken, recoveryCode: regenerated.recoveryCodes[0] } });
  await call('/auth/me', { token: first.tokens.accessToken, status: 401 });
  await signOut();
  assert.equal(pageErrors.length, 0, 'No browser runtime errors');
  console.log('PASS: real Chromium required MFA enrollment, cookie dashboard, recovery-code download/regeneration, authenticator sign-in, challenge replay denial, backup recovery/re-enrollment and old-session revocation. No money/provider operations.');
} catch (error) {
  console.error('Browser failure diagnostics (no bodies, keys, cookies or backup codes):', JSON.stringify({
    url: new URL(page.url()).pathname, sessionMarker: await page.evaluate(() => localStorage.getItem('coopengine_session') === 'cookie').catch(() => false),
    pageErrors, failedRequests: failedRequests.slice(-10),
  }));
  throw error;
} finally { await context.close(); await browser.close(); }
