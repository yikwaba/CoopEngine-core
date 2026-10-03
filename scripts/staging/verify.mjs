import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
export async function verifyFixtures(fixtures,base) {
 assert.equal(fixtures.length,2);
 const [a,b]=fixtures;
 for(const [own,other] of [[a,b],[b,a]]) {
  const list=await fetch(`${base}/members`,{headers:{Authorization:`Bearer ${own.token}`}});
  assert.equal(list.status,200);const members=await list.json();
  assert.equal(members.length,3);assert.deepEqual(new Set(members.map(x=>x.id)),new Set(own.members.map(x=>x.id)));
  const foreign=await fetch(`${base}/members/${other.members[0].id}`,{headers:{Authorization:`Bearer ${own.token}`}});
  assert.ok([403,404].includes(foreign.status),'Guessed foreign member must be denied');
 }
 assert.equal(a.members[0].memberNo,b.members[0].memberNo,'Test tenants must reuse a member number');
 const require=createRequire(new URL('../../packages/db/package.json',import.meta.url));
 const {Client}=require('pg');const client=new Client({connectionString:process.env.DATABASE_URL});await client.connect();
 try {
  const role=await client.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user');
  assert.equal(role.rows[0].rolsuper,false);assert.equal(role.rows[0].rolbypassrls,false);
  const table=await client.query("SELECT relrowsecurity,relforcerowsecurity, pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid='public.members'::regclass");
  assert.equal(table.rows[0].relrowsecurity,true);assert.equal(table.rows[0].relforcerowsecurity,true);assert.notEqual(table.rows[0].owner,'staging_app');
  assert.equal((await client.query('SELECT id FROM members')).rows.length,0,'No tenant context must see no members');
  await client.query('BEGIN');await client.query("SELECT set_config('app.tenant_id',$1,true)",[a.id]);
  const visible=await client.query('SELECT id FROM members');assert.deepEqual(new Set(visible.rows.map(x=>x.id)),new Set(a.members.map(x=>x.id)));
  await client.query('ROLLBACK');
  assert.equal((await client.query('SELECT id FROM members')).rows.length,0,'Tenant context must not leak after transaction');
 } finally {await client.end();}
 console.log('Baseline passed: two authenticated synthetic tenants, same member number, guessed-ID denial, runtime non-owner/no-bypass role and members RLS isolation. Full acceptance remains pending.');
}
