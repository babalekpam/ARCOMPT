-- Preserve the single reserved-organization invariant while expressing its
-- boolean check explicitly for development-to-production schema introspection.
-- The singleton column is NOT NULL, so this is equivalent to CHECK (singleton).
ALTER TABLE platform_admin_reserved_org
  DROP CONSTRAINT platform_admin_reserved_org_singleton_check,
  ADD CONSTRAINT platform_admin_reserved_org_singleton_check CHECK (singleton IS TRUE);