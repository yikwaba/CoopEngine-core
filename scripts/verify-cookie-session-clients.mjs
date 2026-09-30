#!/usr/bin/env node
/**
 * Browser sessions are httpOnly cookies. `readToken()` returns only the marker
 * string "cookie"; using it as `Authorization: Bearer cookie` guarantees a 401.
 * A page that then clears local session state turns an ordinary page visit into
 * an apparent logout. Keep every browser request on the central cookie client.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const appRoots = [join(root, 'apps/portal/src'), join(root, 'apps/member-pwa/src')];
const failures = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path);
    else if (/\.(ts|tsx)$/.test(name)) inspect(path);
  }
}

function inspect(path) {
  const text = readFileSync(path, 'utf8');
  // The API client itself may discuss Authorization in comments/types, but page
  // code must never synthesize a bearer header from readToken/readMemberToken.
  if (/headers\s*:\s*\{[^}]*Authorization\s*:/s.test(text)) {
    failures.push(`${relative(root, path)} constructs an Authorization header; use apiResponse/apiFetch`);
  }
}

for (const dir of appRoots) walk(dir);
if (failures.length) {
  console.error('cookie-session client invariant FAILED');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('cookie-session client invariant: browser pages use the central cookie client');
