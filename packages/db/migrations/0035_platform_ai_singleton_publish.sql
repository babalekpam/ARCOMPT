-- Equivalent constraint, expressed explicitly so publish introspection does not
-- generate invalid CHECK (CHECK (singleton)). No rows or credentials are changed.
ALTER TABLE public.platform_ai_settings
  DROP CONSTRAINT platform_ai_settings_singleton_check,
  ADD CONSTRAINT platform_ai_settings_singleton_check CHECK (singleton IS TRUE);
