-- Auth hardening (review M5).
-- 1. Wrong second-factor codes are counted per USER (not only per login session), so somebody who knows the password
--    cannot keep guessing codes by logging in again and again.
ALTER TABLE "user"
  ADD COLUMN totp_failed_count integer NOT NULL DEFAULT 0,
  ADD COLUMN totp_locked_until timestamptz;

-- 2. Wrong passwords lock the pair (account, client address) instead of the whole account, so a stranger who only
--    knows an e-mail address can no longer lock its owner out. ("user".locked_until is no longer set by the login.)
CREATE TABLE login_throttle (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organization(id),
  user_id       uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  ip            text NOT NULL,
  failures      integer NOT NULL DEFAULT 0,
  locked_until  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES "user"(id) ON DELETE SET NULL,
  UNIQUE (org_id, user_id, ip)
);
CREATE TRIGGER login_throttle_set_updated_at BEFORE UPDATE ON login_throttle
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
