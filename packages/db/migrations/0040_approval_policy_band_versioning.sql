-- 0040_approval_policy_band_versioning.sql
--
-- Migration 0039 keyed a policy version by (organization, kind, version).
-- That permits only one amount band at a version, so the PRD's two simultaneous
-- WITHDRAWAL bands could not both be version 1. Calling the upper band "version
-- 2" would be dishonest: it is another rule in the same policy revision, not a
-- revision of the lower rule.
--
-- Version belongs to a BAND. Include min_amount in the identity. Overlap remains
-- a configuration error that the request service refuses (it requires exactly
-- one matching active policy), while exact duplicate bands at one version remain
-- structurally impossible.

DROP INDEX IF EXISTS "approval_policies_version_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX "approval_policies_band_version_unique"
  ON "approval_policies" ("organization_id", "kind", "min_amount", "version");
