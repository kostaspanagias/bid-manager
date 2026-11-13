-- Admin-triggered password reset: a single-use, expiring set-password link (same mechanics as `invitation`).
-- Only the SHA-256 of the token is stored; the link itself is shown once to the admin and e-mailed to the user.
CREATE TABLE password_reset (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organization(id),
  user_id     uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  token_hash  text NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES "user"(id) ON DELETE SET NULL,
  UNIQUE (org_id, token_hash)
);
CREATE INDEX password_reset_token_idx ON password_reset (token_hash);
CREATE INDEX password_reset_user_idx ON password_reset (org_id, user_id);
CREATE TRIGGER password_reset_set_updated_at BEFORE UPDATE ON password_reset
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
