#!/usr/bin/env node

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const migrationDir = join(root, 'packages/db/migrations');
const journalPath = join(migrationDir, 'meta/_journal.json');

const journal = JSON.parse(await readFile(journalPath, 'utf8'));
const entries = journal.entries ?? [];
const sqlFiles = (await readdir(migrationDir)).filter((name) => name.endsWith('.sql'));
const sqlTags = new Set(sqlFiles.map((name) => name.slice(0, -4)));
const journalTags = new Set();
const errors = [];

for (const [position, entry] of entries.entries()) {
  if (entry.idx !== position) {
    errors.push(`journal idx ${entry.idx} is at position ${position}`);
  }
  if (journalTags.has(entry.tag)) {
    errors.push(`duplicate journal tag: ${entry.tag}`);
  }
  journalTags.add(entry.tag);
  if (!sqlTags.has(entry.tag)) {
    errors.push(`journal entry has no SQL file: ${entry.tag}.sql`);
  }
}

for (const tag of sqlTags) {
  if (!journalTags.has(tag)) {
    errors.push(`SQL migration is not recorded in the journal: ${tag}.sql`);
  }
}

if (errors.length > 0) {
  console.error('Migration history is inconsistent:');
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Migration history verified: ${entries.length} journal entries and ${sqlFiles.length} SQL files.`);
}
