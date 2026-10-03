import { createRequire } from 'node:module';
import { validateStaging } from './guard.mjs';
validateStaging(process.env);
const require = createRequire(new URL('../../packages/db/package.json', import.meta.url));
const { Client } = require('pg');
const client = new Client({connectionString:process.env.DATABASE_URL});
await client.connect();
try {
  await client.query('GRANT USAGE ON SCHEMA public TO staging_app');
  await client.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO staging_app');
  await client.query('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO staging_app');
  await client.query('ALTER DEFAULT PRIVILEGES FOR ROLE staging_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO staging_app');
  await client.query('ALTER DEFAULT PRIVILEGES FOR ROLE staging_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO staging_app');
  const result=await client.query("SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname='staging_app'");
  if(result.rows.length!==1 || result.rows[0].rolsuper || result.rows[0].rolbypassrls) throw new Error('Invalid staging runtime role');
  console.log('Staging runtime grants verified (non-owner, no superuser/RLS bypass)');
} finally {await client.end();}
