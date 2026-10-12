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
