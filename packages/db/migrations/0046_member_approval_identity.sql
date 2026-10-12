-- Explicit member origins; preserve historical staff identities and decisions.
CREATE UNIQUE INDEX members_org_id_approval_identity ON members (organization_id, id);
ALTER TABLE approval_requests ALTER COLUMN requested_by DROP NOT NULL;
ALTER TABLE approval_requests ADD COLUMN requested_by_member_id uuid;
ALTER TABLE approval_requests ADD CONSTRAINT approval_request_member_tenant_fk
 FOREIGN KEY (organization_id, requested_by_member_id) REFERENCES members(organization_id,id);
ALTER TABLE approval_requests ADD CONSTRAINT approval_request_identity_check
 CHECK ((requested_by IS NOT NULL) <> (requested_by_member_id IS NOT NULL));
ALTER TABLE approval_requests ADD CONSTRAINT approval_request_member_kind_check
 CHECK (requested_by_member_id IS NULL OR (kind='WITHDRAWAL' AND entity_type='savings_withdrawal_request'));
ALTER TABLE approval_actions ADD COLUMN actor_member_id uuid;
ALTER TABLE approval_actions ADD CONSTRAINT approval_action_member_tenant_fk
 FOREIGN KEY (organization_id, actor_member_id) REFERENCES members(organization_id,id);
ALTER TABLE approval_actions ADD CONSTRAINT approval_action_member_origin_check
 CHECK (actor_member_id IS NULL OR (actor_user_id IS NULL AND action='SUBMIT'));

-- The existing request guard lists only historical staff-origin columns.
-- Freeze the newly introduced member origin for pending and decided requests.
CREATE FUNCTION app_guard_member_approval_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.requested_by_member_id IS DISTINCT FROM OLD.requested_by_member_id THEN
  RAISE EXCEPTION 'approval member requester identity is immutable' USING ERRCODE='check_violation';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER approval_member_identity_immutable BEFORE UPDATE ON approval_requests
 FOR EACH ROW EXECUTE FUNCTION app_guard_member_approval_identity();
