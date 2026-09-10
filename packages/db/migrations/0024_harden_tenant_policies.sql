-- Harden every tenant-isolation policy against a blank GUC.
--
-- Background: `current_setting('app.tenant_id', true)::uuid` raises
-- `invalid input syntax for type uuid: ""` whenever the setting exists but is
-- empty (e.g. a pooled connection that ran a session-level reset). Wrapping the
-- setting in NULLIF makes "no tenant context" mean "no rows" — the safe
-- interpretation — instead of a runtime error.
DO $$
DECLARE
  r record;
  tenant_expr text := 'nullif(current_setting(''app.tenant_id'', true), '''')::uuid';
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname
      FROM pg_policies
     WHERE policyname IN ('tenant_isolation', 'tenant_self_isolation')
  LOOP
    IF r.policyname = 'tenant_self_isolation' THEN
      EXECUTE format('DROP POLICY %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
      EXECUTE format(
        'CREATE POLICY %I ON %I.%I AS PERMISSIVE FOR ALL USING (id = %s) WITH CHECK (id = %s)',
        r.policyname, r.schemaname, r.tablename, tenant_expr, tenant_expr);
    ELSE
      EXECUTE format('DROP POLICY %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
      EXECUTE format(
        'CREATE POLICY %I ON %I.%I AS PERMISSIVE FOR ALL USING (organization_id = %s) WITH CHECK (organization_id = %s)',
        r.policyname, r.schemaname, r.tablename, tenant_expr, tenant_expr);
    END IF;
  END LOOP;
END $$;
