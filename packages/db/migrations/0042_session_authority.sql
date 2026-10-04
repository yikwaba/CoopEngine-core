-- Global identity state, matching users/sessions; no tenant API exposes it.
ALTER TABLE users ADD COLUMN auth_version integer NOT NULL DEFAULT 0;
--> statement-breakpoint
-- Existing sessions each form an independent family; future rotations inherit it.
ALTER TABLE sessions ADD COLUMN family_id uuid NOT NULL DEFAULT gen_random_uuid();
--> statement-breakpoint
CREATE INDEX sessions_user_family_idx ON sessions(user_id,family_id);
