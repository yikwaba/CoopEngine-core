#!/usr/bin/env node
/**
 * CI-only helper: create the non-superuser `coopengine` app role + database.
 *
 * The official postgres image creates POSTGRES_USER as a SUPERUSER, and
 * superusers bypass row-level security even when FORCE RLS is set — which
 * would make every isolation test meaningless. Local dev creates the role
 * with CREATE ROLE (plain login), matching what this script restores in CI.
 */
import { Client } from 'pg';

const admin = new Client({
  host: process.env.PGHOST ?? 'localhost',
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.CI_DB_ADMIN_USER ?? 'postgres',
  password: process.env.CI_DB_ADMIN_PASSWORD ?? 'postgres',
  database: 'postgres',
});

async function main() {
  await admin.connect();
  const role = await admin.query(`SELECT 1 FROM pg_roles WHERE rolname = 'coopengine'`);
  if (role.rows.length === 0) {
    await admin.query(
      `CREATE ROLE coopengine LOGIN PASSWORD 'coopengine' NOSUPERUSER NOCREATEDB NOCREATEROLE`,
    );
    console.log('created role: coopengine (NOSUPERUSER)');
  } else {
    // Make sure the pre-created image role is not a superuser
    await admin.query(`ALTER ROLE coopengine NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    console.log('role coopengine exists — demoted to NOSUPERUSER');
  }
  const db = await admin.query(`SELECT 1 FROM pg_database WHERE datname = 'coopengine'`);
  if (db.rows.length === 0) {
    await admin.query(`CREATE DATABASE coopengine OWNER coopengine`);
    console.log('created database: coopengine');
  }
  await admin.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
