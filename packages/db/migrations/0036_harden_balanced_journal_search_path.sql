-- The ledger guard is installed after schema migrations in fresh environments.
-- Harden it when it already exists, while allowing a clean database to migrate safely.
DO $$
BEGIN
  IF pg_catalog.to_regprocedure('public.assert_balanced_journal()') IS NOT NULL THEN
    ALTER FUNCTION public.assert_balanced_journal()
      SET search_path = pg_catalog, public;
  END IF;
END
$$;
