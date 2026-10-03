import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test, beforeEach, afterEach } from 'node:test';
import { apiResponse, apiFetch, SESSION_MARKER, USER_KEY } from '../src/lib/api.ts';

const originalFetch = globalThis.fetch;
beforeEach(() => {
  const storage = new Map([[SESSION_MARKER, 'cookie'], [USER_KEY, '{}']]);
  globalThis.localStorage = {
    getItem: key => storage.get(key) ?? null,
    removeItem: key => storage.delete(key),
  };
  globalThis.window = { location: { pathname: '/members', href: '/members' } };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete globalThis.localStorage;
  delete globalThis.window;
});

test('member pagination sends cookies and retains response headers', async () => {
  globalThis.fetch = async (url, init) => {
    assert.match(url, /\/members\?limit=10&offset=0$/);
    assert.equal(init.credentials, 'include');
    assert.equal(new Headers(init.headers).get('Authorization'), null);
    return Response.json([{ id: 'synthetic-member' }], { headers: { 'x-total-count': '3' } });
  };
  const response = await apiResponse('/members?limit=10&offset=0', { credentials: 'omit' });
  assert.equal(response.headers.get('x-total-count'), '3');
  assert.deepEqual(await response.json(), [{ id: 'synthetic-member' }]);
});

test('binary downloads retain content and use cookie authentication', async () => {
  globalThis.fetch = async (_url, init) => {
    assert.equal(init.credentials, 'include');
    assert.equal(new Headers(init.headers).get('Authorization'), null);
    return new Response('statement-data', { headers: { 'Content-Type': 'text/csv' } });
  };
  assert.equal(await (await apiResponse('/reports/export/member-statement')).text(), 'statement-data');
});

test('401 clears the session and redirects to login', async () => {
  globalThis.fetch = async () => new Response('', { status: 401 });
  assert.equal((await apiResponse('/members')).status, 401);
  assert.equal(localStorage.getItem(SESSION_MARKER), null);
  assert.equal(localStorage.getItem(USER_KEY), null);
  assert.equal(window.location.href, '/login');
});

for (const status of [403, 500]) {
  test(`${status} displays an API error without erasing the session`, async () => {
    globalThis.fetch = async () => Response.json({ message: 'Request denied' }, { status });
    await assert.rejects(apiFetch('/members'), /Request denied/);
    assert.equal(localStorage.getItem(SESSION_MARKER), 'cookie');
    assert.equal(window.location.href, '/members');
  });
}

test('network failure preserves the session', async () => {
  globalThis.fetch = async () => { throw new TypeError('Network unavailable'); };
  await assert.rejects(apiResponse('/members'), /Network unavailable/);
  assert.equal(localStorage.getItem(SESSION_MARKER), 'cookie');
  assert.equal(window.location.href, '/members');
});

test('all seven affected pages use the shared cookie transport', async () => {
  for (const page of ['members', 'loans', 'collections', 'audit', 'analytics', 'documents', 'members/[id]']) {
    const source = await readFile(new URL(`../src/app/${page}/page.tsx`, import.meta.url), 'utf8');
    assert.match(source, /await apiResponse\(/, page);
    assert.doesNotMatch(source, /\bfetch\(|Bearer|clearSession\(/, page);
  }
});
