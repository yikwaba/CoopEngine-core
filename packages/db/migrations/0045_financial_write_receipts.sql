-- Replay receipts commit with their financial effect; failed transactions leave no claim.
CREATE TABLE financial_write_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 action varchar(80) NOT NULL,
 intent_key varchar(100) NOT NULL,
 fingerprint varchar(64) NOT NULL,
 response jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 CONSTRAINT financial_receipt_completion CHECK ((response IS NULL) = (completed_at IS NULL)),
 CONSTRAINT financial_receipt_scope UNIQUE (organization_id,action,intent_key)
);
ALTER TABLE financial_write_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_write_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON financial_write_receipts FOR ALL
 USING (organization_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (organization_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

CREATE FUNCTION app_financial_receipt_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF OLD.completed_at IS NOT NULL AND NOT app_ledger_maintenance() THEN
  RAISE EXCEPTION 'completed financial receipts are immutable' USING ERRCODE='check_violation';
 END IF;
 RETURN COALESCE(NEW,OLD);
END $$;
CREATE TRIGGER financial_receipt_immutable BEFORE UPDATE OR DELETE ON financial_write_receipts
 FOR EACH ROW EXECUTE FUNCTION app_financial_receipt_immutable();
