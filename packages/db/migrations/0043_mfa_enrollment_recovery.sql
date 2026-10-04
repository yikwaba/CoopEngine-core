-- Limited credentials belong to global identity, like users/sessions. Never
-- expose these tables through tenant/member/report APIs.
ALTER TABLE sessions ADD COLUMN mfa_verified boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE TABLE mfa_challenges (
  token_hash varchar(64) PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  auth_version integer NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('LOGIN','ENROLL')),
  pending_secret text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((purpose='ENROLL')=(pending_secret IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX mfa_challenges_user_created_idx ON mfa_challenges(user_id,created_at);
--> statement-breakpoint
CREATE TABLE mfa_recovery_codes (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash varchar(64) NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,code_hash)
);
