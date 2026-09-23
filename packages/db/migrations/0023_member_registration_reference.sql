-- Stable platform-wide registration order for human-readable member references.
-- The visible company/exercise portion is resolved at read time, never used for auth.
CREATE SEQUENCE app_user_registration_number_seq AS bigint;
ALTER TABLE app_user ADD COLUMN registration_number bigint;

WITH ordered AS (
  SELECT id, row_number() OVER (ORDER BY created_at, id) AS number
  FROM app_user
)
UPDATE app_user u
SET registration_number = ordered.number
FROM ordered
WHERE ordered.id = u.id;

SELECT setval(
  'app_user_registration_number_seq',
  COALESCE(MAX(registration_number), 1),
  COUNT(*) > 0
) FROM app_user;

ALTER TABLE app_user
  ALTER COLUMN registration_number SET DEFAULT nextval('app_user_registration_number_seq'),
  ALTER COLUMN registration_number SET NOT NULL,
  ADD CONSTRAINT app_user_registration_number_unique UNIQUE (registration_number);
ALTER SEQUENCE app_user_registration_number_seq OWNED BY app_user.registration_number;
GRANT USAGE, SELECT ON SEQUENCE app_user_registration_number_seq TO arcompt_app;