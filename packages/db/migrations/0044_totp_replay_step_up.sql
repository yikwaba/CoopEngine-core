-- Global identity counters: the same factor cannot reuse a time step across
-- sessions, cooperatives, challenges or money actions. Password reset does not
-- reset this counter; a replacement authenticator has a different digest.
CREATE TABLE mfa_used_steps (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_hash varchar(64) NOT NULL,
  last_step bigint NOT NULL CHECK (last_step >= 0)
);
--> statement-breakpoint
CREATE TABLE mfa_stepup_failures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attempted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
--> statement-breakpoint
CREATE INDEX mfa_stepup_failures_user_time_idx ON mfa_stepup_failures(user_id,attempted_at);
