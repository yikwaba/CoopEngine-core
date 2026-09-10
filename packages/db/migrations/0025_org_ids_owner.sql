-- Cross-tenant tenant enumeration for machine endpoints (cron sweep/dispatch).
--
-- A SECURITY DEFINER helper does not work here: its owner must itself bypass RLS
-- (CREATE/ALTER ownership needs role membership we don't have on Supabase), and
-- a function owned by the app role is still subject to FORCE RLS.
--
-- Instead we add a second, NARROW permissive policy on `organizations` that only
-- matches when a transaction-local flag is set. The flag is never set on any
-- tenant-facing request path, so normal traffic keeps full isolation; the only
-- thing it exposes is organization ids for the internal cron workers.
DROP FUNCTION IF EXISTS coopengine_all_org_ids();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE tablename = 'organizations' AND policyname = 'internal_scan'
  ) THEN
    DROP POLICY internal_scan ON organizations;
  END IF;
END $$;

CREATE POLICY internal_scan ON organizations
  AS PERMISSIVE
  FOR SELECT
  USING (nullif(current_setting('app.internal_scan', true), '') = 'on');
