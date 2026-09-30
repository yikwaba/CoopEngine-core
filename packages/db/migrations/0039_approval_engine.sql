-- 0039_approval_engine.sql
--
-- FR-020: multi-step approvals with amount thresholds, versioning and delegation.
--
-- What was missing before this migration: approvals existed only as a single
-- permission check ("this caller holds payroll.approve, so the batch may post")
-- plus one ad-hoc organisation setting for withdrawals. There were no ordered
-- steps, no thresholds, no versioning and no delegation, and nothing recorded
-- *which* policy an approval was made under - so a chain could not be described,
-- replayed or audited.
--
-- The model here:
--   approval_policies      one rules per organisation, per kind, per amount band,
--                          carrying a version. A revision is a NEW row with a
--                          higher version; the old row is deactivated, never edited.
--   approval_policy_steps  the ordered approvers inside a policy: a role code
--                          (TREASURER, CREDIT_COMMITTEE, CHAIRMAN, ...) or a named user.
--   approval_requests      one request per thing needing approval, frozen against
--                          the policy version it was raised under.
--   approval_steps         the per-request snapshot of the chain, carrying the
--                          decision made at each step.
--   approval_actions       an append-only trail of every act (SUBMIT/APPROVE/
--                          REJECT/CANCEL/DELEGATE). Triggers refuse rewrites.
--   approval_delegations   cover for an absent approver, time-boxed.
--
-- A request frozen to a policy version is deliberate: revising a policy must not
-- silently change what an in-flight request must satisfy.
--
-- Test teardown and ops purges opt in with `SET LOCAL app.maintenance = 'on'`,
-- exactly as the ledger guard does.

-- ------------------------------------------------------------------ policies

CREATE TABLE IF NOT EXISTS "approval_policies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "kind" varchar(24) NOT NULL,
  "min_amount" numeric(19, 2) NOT NULL DEFAULT 0,
  "max_amount" numeric(19, 2),
  "version" integer NOT NULL DEFAULT 1,
  "is_active" boolean NOT NULL DEFAULT true,
  "description" text,
  "created_by" uuid REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "approval_policies_kind_check"
    CHECK ("kind" IN ('WITHDRAWAL', 'PAYROLL', 'LOAN', 'JOURNAL', 'EXPENSE')),
  CONSTRAINT "approval_policies_range_check"
    CHECK ("max_amount" IS NULL OR "max_amount" > "min_amount"),
  CONSTRAINT "approval_policies_min_check" CHECK ("min_amount" >= 0),
  CONSTRAINT "approval_policies_version_check" CHECK ("version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "approval_policies_version_unique"
  ON "approval_policies" ("organization_id", "kind", "version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_policies_lookup"
  ON "approval_policies" ("organization_id", "kind", "is_active");
--> statement-breakpoint

-- ------------------------------------------------------------------ policy steps

CREATE TABLE IF NOT EXISTS "approval_policy_steps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "policy_id" uuid NOT NULL REFERENCES "approval_policies"("id") ON DELETE CASCADE,
  "step_no" integer NOT NULL,
  "approver_role_code" varchar(32),
  "approver_user_id" uuid REFERENCES "users"("id"),
  "must_differ_from_requester" boolean NOT NULL DEFAULT true,
  "label" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  -- exactly one way of naming the approver: a role, or a specific person
  CONSTRAINT "approval_policy_steps_approver_check"
    CHECK (("approver_role_code" IS NOT NULL) <> ("approver_user_id" IS NOT NULL)),
  CONSTRAINT "approval_policy_steps_step_check" CHECK ("step_no" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "approval_policy_steps_unique"
  ON "approval_policy_steps" ("policy_id", "step_no");
--> statement-breakpoint

-- ------------------------------------------------------------------ requests

CREATE TABLE IF NOT EXISTS "approval_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "kind" varchar(24) NOT NULL,
  "entity_type" varchar(32) NOT NULL,
  "entity_id" uuid,
  "amount" numeric(19, 2) NOT NULL DEFAULT 0,
  "currency" varchar(3) NOT NULL DEFAULT 'NGN',
  "summary" text,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "requested_by" uuid NOT NULL REFERENCES "users"("id"),
  "policy_id" uuid REFERENCES "approval_policies"("id"),
  "policy_version" integer,
  "total_steps" integer NOT NULL DEFAULT 0,
  "current_step" integer NOT NULL DEFAULT 1,
  "status" varchar(16) NOT NULL DEFAULT 'PENDING',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "decided_at" timestamptz,
  "decided_by" uuid REFERENCES "users"("id"),
  CONSTRAINT "approval_requests_status_check"
    CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  CONSTRAINT "approval_requests_amount_check" CHECK ("amount" >= 0),
  CONSTRAINT "approval_requests_step_check" CHECK ("current_step" > 0)
);
--> statement-breakpoint
-- one open request per thing; a decided request leaves the way clear for another
CREATE UNIQUE INDEX IF NOT EXISTS "approval_requests_open_unique"
  ON "approval_requests" ("organization_id", "entity_type", "entity_id")
  WHERE "status" = 'PENDING' AND "entity_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_requests_inbox"
  ON "approval_requests" ("organization_id", "status", "created_at" DESC);
--> statement-breakpoint

-- ------------------------------------------------------------------ request steps

CREATE TABLE IF NOT EXISTS "approval_steps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "request_id" uuid NOT NULL REFERENCES "approval_requests"("id") ON DELETE CASCADE,
  "step_no" integer NOT NULL,
  "approver_role_code" varchar(32),
  "approver_user_id" uuid REFERENCES "users"("id"),
  "status" varchar(16) NOT NULL DEFAULT 'PENDING',
  "acted_by" uuid REFERENCES "users"("id"),
  "acted_at" timestamptz,
  "comment" text,
  CONSTRAINT "approval_steps_status_check"
    CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED')),
  CONSTRAINT "approval_steps_step_check" CHECK ("step_no" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "approval_steps_unique"
  ON "approval_steps" ("request_id", "step_no");
--> statement-breakpoint

-- ------------------------------------------------------------------ action trail

CREATE TABLE IF NOT EXISTS "approval_actions" (
  "id" bigserial PRIMARY KEY,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "request_id" uuid NOT NULL REFERENCES "approval_requests"("id") ON DELETE CASCADE,
  "step_no" integer,
  "actor_user_id" uuid REFERENCES "users"("id"),
  "action" varchar(16) NOT NULL,
  "comment" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "approval_actions_action_check"
    CHECK ("action" IN ('SUBMIT', 'APPROVE', 'REJECT', 'CANCEL', 'DELEGATE'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_actions_request"
  ON "approval_actions" ("request_id", "created_at");
--> statement-breakpoint

-- ------------------------------------------------------------------ delegations

CREATE TABLE IF NOT EXISTS "approval_delegations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "from_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "to_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "kind" varchar(24),
  "valid_from" timestamptz NOT NULL DEFAULT now(),
  "valid_to" timestamptz,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_by" uuid REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  -- somebody cannot cover for themselves
  CONSTRAINT "approval_delegations_self_check" CHECK ("from_user_id" <> "to_user_id"),
  CONSTRAINT "approval_delegations_window_check"
    CHECK ("valid_to" IS NULL OR "valid_to" > "valid_from")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_delegations_lookup"
  ON "approval_delegations" ("organization_id", "from_user_id", "is_active");
--> statement-breakpoint

-- ------------------------------------------------------------------ tenant isolation
-- Every new table carries organization_id so the standard tenant policy applies
-- without exception. approval_policy_steps and approval_steps are denormalised on
-- purpose: a table that can be reached without the tenant predicate is a leak.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'approval_policies', 'approval_policy_steps', 'approval_requests',
    'approval_steps', 'approval_actions', 'approval_delegations'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY "tenant_isolation" ON %I AS PERMISSIVE FOR ALL TO public '
      'USING ("organization_id" = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) '
      'WITH CHECK ("organization_id" = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- ------------------------------------------------------------------ guards

-- The approval trail is evidence. It is written once and never rewritten.
CREATE OR REPLACE FUNCTION app_forbid_approval_action_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('app.maintenance', true), 'off') = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'approval_actions is an append-only trail: refusal to delete action % (request %)',
      OLD.id, OLD.request_id;
  END IF;
  RAISE EXCEPTION 'approval_actions is an append-only trail: refusal to rewrite action % (request %)',
    OLD.id, OLD.request_id;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_approval_actions_immutable ON "approval_actions";
--> statement-breakpoint
CREATE TRIGGER trg_approval_actions_immutable
  BEFORE UPDATE OR DELETE ON "approval_actions"
  FOR EACH ROW EXECUTE FUNCTION app_forbid_approval_action_change();
--> statement-breakpoint

-- A decision is final. A decided request cannot be re-decided, reopened, or
-- have its frozen policy version swapped underneath it.
CREATE OR REPLACE FUNCTION app_guard_approval_request() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('app.maintenance', true), 'off') = 'on' THEN
    RETURN NEW;
  END IF;

  IF OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION 'approval request % is already %: a decision is final', OLD.id, OLD.status;
  END IF;

  IF NEW.status NOT IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED') THEN
    RAISE EXCEPTION 'unknown approval status %', NEW.status;
  END IF;

  IF NEW.policy_id IS DISTINCT FROM OLD.policy_id
     OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by THEN
    RAISE EXCEPTION 'approval request % was frozen to policy % version %: refusing to change policy_id, policy_version, amount or requested_by',
      OLD.id, OLD.policy_id, OLD.policy_version;
  END IF;

  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_approval_requests_guard ON "approval_requests";
--> statement-breakpoint
CREATE TRIGGER trg_approval_requests_guard
  BEFORE UPDATE ON "approval_requests"
  FOR EACH ROW EXECUTE FUNCTION app_guard_approval_request();
--> statement-breakpoint

-- A step is decided once, in order, and never by the person who raised the
-- request. Enforced here rather than in the service so that no future caller can
-- bypass the chain by writing SQL directly - the two rules FR-020 depends on.
CREATE OR REPLACE FUNCTION app_guard_approval_step() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  req_status varchar(16);
  requester uuid;
  earlier_pending integer;
BEGIN
  IF coalesce(current_setting('app.maintenance', true), 'off') = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'refusing to delete approval step % (request %): the chain is part of the record',
      OLD.id, OLD.request_id;
  END IF;

  IF OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION 'approval step % is already %: a step is decided once', OLD.id, OLD.status;
  END IF;

  SELECT status, requested_by INTO req_status, requester
    FROM approval_requests WHERE id = NEW.request_id;

  IF req_status <> 'PENDING' THEN
    RAISE EXCEPTION 'request % is %: refusing to act on a decided request', NEW.request_id, req_status;
  END IF;

  IF NEW.status <> 'PENDING' THEN
    -- a decision at this step
    IF NEW.acted_by IS NULL THEN
      RAISE EXCEPTION 'approval step % cannot be decided without recording who decided it', OLD.id;
    END IF;

    IF NEW.acted_by = requester THEN
      RAISE EXCEPTION 'segregation of duties: user % raised request % and cannot also approve it',
        NEW.acted_by, NEW.request_id;
    END IF;

    SELECT count(*) INTO earlier_pending
      FROM approval_steps
     WHERE request_id = NEW.request_id
       AND step_no < NEW.step_no
       AND status = 'PENDING';

    IF earlier_pending > 0 THEN
      RAISE EXCEPTION 'step % of request % cannot be decided while % earlier step(s) are still pending: the chain is ordered',
        NEW.step_no, NEW.request_id, earlier_pending;
    END IF;
  END IF;

  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_approval_steps_guard ON "approval_steps";
--> statement-breakpoint
CREATE TRIGGER trg_approval_steps_guard
  BEFORE UPDATE OR DELETE ON "approval_steps"
  FOR EACH ROW EXECUTE FUNCTION app_guard_approval_step();
