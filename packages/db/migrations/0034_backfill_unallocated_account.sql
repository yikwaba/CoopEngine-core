-- Custom SQL migration file, put your code below! ---- Add the Unallocated Receipts account to cooperatives that already existed when it was
-- introduced. The previous attempt inserted nothing: organisations is row-level secured, so
-- enumerating it without the internal scan policy returns no rows and the loop body never runs.
DO $$
DECLARE
  org record;
BEGIN
  PERFORM set_config('app.internal_scan', 'on', true);
  FOR org IN SELECT id FROM organizations LOOP
    PERFORM set_config('app.tenant_id', org.id::text, true);
    INSERT INTO chart_of_accounts (id, organization_id, code, name, type, category, is_system)
    SELECT gen_random_uuid(), org.id, '2990', 'Unallocated Receipts', 'LIABILITY', 'Member Funds', true
     WHERE NOT EXISTS (
       SELECT 1 FROM chart_of_accounts a
        WHERE a.organization_id = org.id AND a.code = '2990'
     );
  END LOOP;
END $$;
