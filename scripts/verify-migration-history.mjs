#!/usr/bin/env node
/**
 * Migration history is append-only.
 *
 * The collision that cost a round of work: a parallel branch deleted two already-applied migrations
 * (0036/0037) and introduced a new 0036 in their place. Nothing failed, because nothing checked that
 * the past had stayed put. This does.
 *
 * Rules enforced for every migration recorded in CHECKSUMS.json:
 *   1. it still exists — deletions are refused (add a new migration instead);
 *   2. its bytes are unchanged — edits are refused (add a new migration instead);
 *   3. no two migrations share a numeric prefix, except prefixes explicitly grandfathered below;
 *   4. every .sql file in the directory is recorded — a new migration must be accepted deliberately
 *      with `node scripts/verify-migration-history.mjs --record`;
 *   5. the drizzle journal lists exactly the recorded migrations, in order.
 *
 * Run with --record to accept the current state (only ever after adding a NEW migration).
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'packages/db/migrations');
const manifestPath = join(dir, 'CHECKSUMS.json');
const journalPath = join(dir, 'meta/_journal.json');

// There are two 0034_ files, created before this gate existed and both already applied. Renaming an
// applied migration rewrites history, so they are grandfathered until the database is next rebuilt.
const GRANDFATHERED_DUPLICATE_PREFIXES = ['0034'];

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const sqlFiles = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

if (process.argv.includes('--record')) {
  const files = {};
  for (const f of sqlFiles) files[f] = sha(join(dir, f));
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        note: 'Append-only record of applied migrations. Regenerate with --record ONLY when adding a new migration.',
        grandfatheredDuplicatePrefixes: GRANDFATHERED_DUPLICATE_PREFIXES,
        files,
        journalTags: journal.entries.map((e) => e.tag),
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`recorded ${Object.keys(files).length} migrations`);
  process.exit(0);
}

if (!existsSync(manifestPath)) {
  console.error('CHECKSUMS.json is missing — run: node scripts/verify-migration-history.mjs --record');
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const problems = [];

for (const [name, recorded] of Object.entries(manifest.files)) {
  const p = join(dir, name);
  if (!existsSync(p)) {
    problems.push(`DELETED: ${name} was applied to real environments. Re-adding it must be a new migration, never a removal.`);
  } else if (sha(p) !== recorded) {
    problems.push(`MODIFIED: ${name} changed after being applied. Environments already ran the old bytes; put the change in a NEW migration.`);
  }
}

const unrecorded = sqlFiles.filter((f) => !manifest.files[f]);
if (unrecorded.length) {
  problems.push(`UNRECORDED: ${unrecorded.join(', ')} — accept deliberately with: node scripts/verify-migration-history.mjs --record`);
}

const prefixes = {};
for (const f of sqlFiles) (prefixes[f.slice(0, 4)] ??= []).push(f);
for (const [p, list] of Object.entries(prefixes)) {
  if (list.length > 1 && !GRANDFATHERED_DUPLICATE_PREFIXES.includes(p)) {
    problems.push(`DUPLICATE NUMBER ${p}: ${list.join(' + ')} — two migrations cannot share a number.`);
  }
}

const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
const journalSql = journal.entries.map((e) => e.tag).filter((t) => manifest.files[`${t}.sql`]);
const missingFromJournal = Object.keys(manifest.files).filter((f) => !journal.entries.some((e) => `${e.tag}.sql` === f));
if (missingFromJournal.length) problems.push(`NOT IN JOURNAL: ${missingFromJournal.join(', ')} — an applied migration must appear in meta/_journal.json.`);
if (journalSql.length === 0) problems.push('JOURNAL: no migration tags match files on disk.');

if (problems.length) {
  console.error('\nMIGRATION HISTORY CHECK FAILED\n');
  for (const p of problems) console.error(`  • ${p}`);
  console.error('\nThe migrations directory is append-only. Add a NEW migration for new changes.\n');
  process.exit(1);
}
console.log(`migration history intact: ${Object.keys(manifest.files).length} migrations recorded, ${journal.entries.length} journal entries`);
