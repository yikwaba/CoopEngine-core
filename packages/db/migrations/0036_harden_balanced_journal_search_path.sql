-- Pin the trigger function's object lookup path so callers cannot shadow referenced names.
ALTER FUNCTION public.assert_balanced_journal()
SET search_path = pg_catalog, public;
