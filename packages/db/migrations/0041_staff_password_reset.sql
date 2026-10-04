-- Global staff identity recovery: users and sessions are global identities.
-- Never expose either table through tenant/member/report APIs. Token secrets
-- are stored only as SHA-256 digests; attempt identifiers are also hashed.
CREATE TABLE password_reset_tokens (
  token_hash varchar(64) PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX password_reset_tokens_user_idx ON password_reset_tokens(user_id);
--> statement-breakpoint
CREATE TABLE password_reset_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_hash varchar(64) NOT NULL,
  ip_hash varchar(64) NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX password_reset_requests_email_idx ON password_reset_requests(email_hash,requested_at);
--> statement-breakpoint
CREATE INDEX password_reset_requests_ip_idx ON password_reset_requests(ip_hash,requested_at);
