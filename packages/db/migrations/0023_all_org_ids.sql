-- Cross-tenant helper for the internal (machine) endpoints and cron tooling.
--
-- RLS on `organizations` correctly hides other tenants from the app role, which
-- also means a cron worker cannot enumerate the tenants to sweep. This
-- SECURITY DEFINER function exposes ONLY organization ids (no names, no data)
-- to the application role, and nothing else.
CREATE OR REPLACE FUNCTION coopengine_all_org_ids()
RETURNS SETOF uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id FROM organizations ORDER BY created_at
$$;

REVOKE ALL ON FUNCTION coopengine_all_org_ids() FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coopengine_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION coopengine_all_org_ids() TO coopengine_app';
  END IF;
END $$;
