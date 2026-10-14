/** Authoritative current receipt state, with the stored notification retained as delivery evidence. */
export const notificationJoins=`LEFT JOIN provider_transactions p ON p.organization_id=n.organization_id
 AND p.provider='MONNIFY' AND p.provider_reference=n.transaction_reference
 LEFT JOIN journal_entries je ON je.organization_id=p.organization_id AND je.id=p.journal_entry_id`;
export const notificationStatus=`CASE
 WHEN p.id IS NULL THEN 'REVIEW_REQUIRED'
 WHEN p.amount<>n.amount OR p.virtual_account_no IS DISTINCT FROM n.account_number THEN 'REVIEW_REQUIRED'
 WHEN p.status='MATCHED' AND je.status='POSTED' THEN 'POSTED'
 WHEN p.status='EXCEPTION' AND je.status='POSTED' AND je.source='PAYMENT_UNALLOCATED' AND je.source_id=p.id THEN 'PARKED'
 ELSE 'REVIEW_REQUIRED' END`;
export const notificationJournal=`CASE WHEN p.amount=n.amount AND p.virtual_account_no=n.account_number AND je.status='POSTED'
 AND (p.status='MATCHED' OR (p.status='EXCEPTION' AND je.source='PAYMENT_UNALLOCATED' AND je.source_id=p.id))
 THEN p.journal_entry_id END`;

/** Collapse delivery aliases only after exact bank identity correlation; preserve inconsistent evidence rows. */
export const notificationReceiptIdentity=`CASE WHEN p.id IS NOT NULL AND p.amount=n.amount
 AND p.virtual_account_no=n.account_number THEN p.id::text ELSE n.id::text END`;
export const notificationDeliveryPartition=`n.organization_id, (${notificationReceiptIdentity}), n.member_id`;
