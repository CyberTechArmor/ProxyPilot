-- Provision read-only SQL access by hand.
--
-- The application can do this itself (Admin → Integration → Database access)
-- PROVIDED its own database role holds CREATEROLE. On a locked-down deployment
-- where it does not — which is a perfectly reasonable posture — run this once
-- as a database owner or superuser instead.
--
-- Substitute:
--   :app_role   the role the application connects as (DATABASE_URL)
--   :ro_role    the read-only role (default: app_readonly)
--   :ro_pass    a long random password you generate
--
-- Nothing here grants access to a base table. Consumers read curated VIEWS in
-- the api_read schema, which the application creates and owns; the base tables
-- hold password hashes, refresh-token hashes and encrypted bind passwords, and
-- must never be exposed. See lib/readonly.js.

-- 1. The role. No superuser, no createdb, no createrole, no inheritance —
--    it must never be able to widen its own access.
CREATE ROLE app_readonly WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
  PASSWORD 'REPLACE_WITH_A_LONG_RANDOM_PASSWORD';

-- 2. Make sure the views exist. The application creates them at boot and when a
--    credential is issued; this is only needed if you are provisioning before
--    the app has ever run.
--    (Run the app once, or copy the VIEWS block from lib/readonly.js.)

-- 3. Nothing in public, everything in api_read.
REVOKE ALL ON SCHEMA public FROM app_readonly;
GRANT USAGE ON SCHEMA api_read TO app_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA api_read TO app_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA api_read GRANT SELECT ON TABLES TO app_readonly;

-- 4. Verify. Every one of these MUST fail for app_readonly:
--      SELECT * FROM public.users;
--      UPDATE public.users SET active = false;
--      CREATE TABLE evil (x int);
--    and this must succeed:
--      SELECT username, active FROM api_read.users;

-- Alternatively, to let the application manage the credential itself
-- (issue, rotate, disable from the admin console):
--   ALTER ROLE <app_role> CREATEROLE;
