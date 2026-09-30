#!/usr/bin/env node
/** Accounting periods follow the Nigerian business day, never the host timezone. */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const src = join(root, 'apps/api/src');
const failures = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path);
    else if (name.endsWith('.ts')) {
      const text = readFileSync(path, 'utf8');
      if (/now\(\)::date\s+BETWEEN\s+start_date\s+AND\s+end_date/i.test(text)) {
        failures.push(relative(root, path));
      }
    }
  }
}
walk(src);
if (failures.length) {
  console.error('business-timezone invariant FAILED: server-local period lookup in');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('business-timezone invariant: accounting period lookups use Africa/Lagos date');
