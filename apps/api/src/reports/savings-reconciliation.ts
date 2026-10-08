import { ledgerDecimal, ledgerKobo } from '../ledger/ledger-money';

export interface ReconciliationAccount {
  id: string; member_id: string; member_no: number; account_no: number;
  product_code: string; projected: string;
}
export interface SavingsLedgerGroup {
  entry_id: string; entry_no: number | null; member_id: string | null;
  amount: string; source_type: string | null; source_id: string | null;
  status: string; reversal_of_entry_id: string | null;
}
export interface SavingsMovementGroup {
  entry_id: string; account_id: string; amount: string; status: string | null;
}

/** Attribute only explicit source accounts, ledger-validated movements, or
 * an unambiguous sole account. Never spread a member total across products. */
export function reconcileSavings(
  accounts: ReconciliationAccount[], ledger: SavingsLedgerGroup[], movements: SavingsMovementGroup[],
) {
  const byId = new Map(accounts.map(a => [a.id, a]));
  const byMember = new Map<string, ReconciliationAccount[]>();
  for (const a of accounts) byMember.set(a.member_id, [...(byMember.get(a.member_id) ?? []), a]);
  const key = (entry: string, member: string | null) => JSON.stringify([entry, member]);
  const groups = new Map<string, { ledger?: SavingsLedgerGroup; movements: SavingsMovementGroup[] }>();
  const journals = new Map(ledger.map(r => [r.entry_id, r]));
  const reversed = new Set(ledger.map(r => r.reversal_of_entry_id).filter(Boolean));
  const amounts = new Map(accounts.map(a => [a.id, 0n]));
  const bases = new Map(accounts.map(a => [a.id, new Set<string>()]));
  const unresolvedIds = new Set<string>();
  const unresolved: {
    entryId: string; entryNo: number | null; memberId: string | null;
    memberNo: number | null; accountIds: string[]; reason: string;
    ledgerDecimal: string | null; transactionsDecimal: string;
  }[] = [];
  for (const row of ledger) groups.set(key(row.entry_id, row.member_id), { ledger: row, movements: [] });
  for (const row of movements) {
    const member = byId.get(row.account_id)?.member_id ?? null;
    const k = key(row.entry_id, member), group = groups.get(k) ?? { movements: [] };
    group.movements.push(row); groups.set(k, group);
  }
  let ledgerTotal = 0n, allocatedTotal = 0n;
  for (const row of ledger) ledgerTotal += ledgerKobo(row.amount);
  for (const group of groups.values()) {
    const l = group.ledger, tx = group.movements;
    const entryId = l?.entry_id ?? tx[0]!.entry_id;
    const memberId = l?.member_id ?? byId.get(tx[0]?.account_id ?? '')?.member_id ?? null;
    const membersAccounts = memberId ? byMember.get(memberId) ?? [] : [];
    const total = tx.reduce((sum, r) => sum + ledgerKobo(r.amount), 0n);
    const value = l ? ledgerKobo(l.amount) : 0n;
    const original = l?.reversal_of_entry_id ? journals.get(l.reversal_of_entry_id) : undefined;
    const source = l?.source_type === 'savings_account' ? l
      : original?.source_type === 'savings_account' ? original : undefined;
    const sourceAccount = source?.source_id ? byId.get(source.source_id) : undefined;
    const fail = (reason: string) => {
      const affected = new Set([...membersAccounts.map(a => a.id), ...tx.map(t => t.account_id), ...(sourceAccount ? [sourceAccount.id] : [])]);
      // An unlinked liability cannot certify any member/product balance.
      if (!memberId) for (const a of accounts) affected.add(a.id);
      for (const id of affected) if (byId.has(id)) unresolvedIds.add(id);
      unresolved.push({ entryId, entryNo: l?.entry_no ?? null, memberId,
        memberNo: membersAccounts[0]?.member_no ?? null, accountIds: [...affected].sort(), reason,
        ledgerDecimal: l ? ledgerDecimal(value) : null, transactionsDecimal: ledgerDecimal(total) });
    };
    const allocate = (id: string, amount: bigint, basis: string) => {
      amounts.set(id, amounts.get(id)! + amount); bases.get(id)!.add(basis); allocatedTotal += amount;
    };
    if (!l) { fail('MOVEMENT_WITHOUT_POSTED_LIABILITY'); continue; }
    if (!memberId || !membersAccounts.length) { fail('LIABILITY_WITHOUT_MEMBER_ACCOUNT'); continue; }
    if (l.reversal_of_entry_id && !journals.has(l.reversal_of_entry_id)) { fail('REVERSAL_WITHOUT_ORIGINAL'); continue; }
    if (l.status === 'REVERSED' && !reversed.has(l.entry_id)) { fail('REVERSED_WITHOUT_REVERSAL'); continue; }
    if (tx.some(t => !['POSTED', 'REVERSED'].includes(t.status ?? ''))) { fail('MOVEMENT_NOT_POSTED'); continue; }
    if (source) {
      if (!sourceAccount || sourceAccount.member_id !== memberId || tx.some(t => t.account_id !== sourceAccount.id)) {
        fail('SOURCE_ACCOUNT_CONFLICT'); continue;
      }
      if (tx.length && total !== value) { fail('MOVEMENT_LEDGER_DISAGREEMENT'); continue; }
      allocate(sourceAccount.id, value, 'SOURCE_ACCOUNT');
    } else if (tx.length) {
      if (total !== value) { fail('MOVEMENT_LEDGER_DISAGREEMENT'); continue; }
      for (const t of tx) allocate(t.account_id, ledgerKobo(t.amount), 'LINKED_TRANSACTIONS');
    } else if (membersAccounts.length === 1) {
      allocate(membersAccounts[0]!.id, value, 'SINGLE_ACCOUNT_MEMBER');
    } else {
      fail('MEMBER_LIABILITY_WITHOUT_ACCOUNT_ALLOCATION');
    }
  }
  const rows = accounts.map(a => {
    const projected = ledgerKobo(a.projected), known = !unresolvedIds.has(a.id), amount = amounts.get(a.id)!;
    return { accountId: a.id, accountNo: Number(a.account_no), memberNo: Number(a.member_no), productCode: a.product_code,
      projectedDecimal: ledgerDecimal(projected), ledgerDecimal: known ? ledgerDecimal(amount) : null,
      diffDecimal: known ? ledgerDecimal(projected - amount) : null,
      status: known ? (projected === amount ? 'MATCHED' : 'MISMATCH') : 'UNRESOLVED',
      attribution: [...bases.get(a.id)!].sort() };
  });
  const mismatches = rows.filter(r => r.status === 'MISMATCH').map(r => ({
    accountId: r.accountId, memberNo: r.memberNo, productCode: r.productCode,
    projected: Number(r.projectedDecimal), projectedDecimal: r.projectedDecimal,
    ledger: Number(r.ledgerDecimal), ledgerDecimal: r.ledgerDecimal!,
    diff: Number(r.diffDecimal), diffDecimal: r.diffDecimal!,
  }));
  const projectedTotal = accounts.reduce((sum, a) => sum + ledgerKobo(a.projected), 0n);
  const matched = rows.filter(r => r.status === 'MATCHED').length;
  return { checked: accounts.length, matched, mismatches,
    balanced: matched === accounts.length && !unresolved.length && projectedTotal === ledgerTotal,
    unresolvedAccounts: unresolvedIds.size, unresolvedEntries: new Set(unresolved.map(issue => issue.entryId)).size,
    rows, unresolved, ledgerStatuses: ['POSTED', 'REVERSED'],
    totals: { projectedDecimal: ledgerDecimal(projectedTotal), ledgerDecimal: ledgerDecimal(ledgerTotal),
      allocatedLedgerDecimal: ledgerDecimal(allocatedTotal), unallocatedLedgerDecimal: ledgerDecimal(ledgerTotal - allocatedTotal),
      diffDecimal: ledgerDecimal(projectedTotal - ledgerTotal) } };
}
