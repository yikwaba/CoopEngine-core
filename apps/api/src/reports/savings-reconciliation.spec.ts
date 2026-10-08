import { describe, expect, it } from 'vitest';
import { reconcileSavings, ReconciliationAccount, SavingsLedgerGroup, SavingsMovementGroup } from './savings-reconciliation';
const account = (id: string, projected: string): ReconciliationAccount => ({ id, member_id: 'm', member_no: 1, account_no: id==='a'?1:2, product_code: id, projected });
const line = (id: string, amount: string, source?: string): SavingsLedgerGroup => ({ entry_id: id, entry_no: 1, member_id: 'm', amount, source_type: source?'savings_account':null, source_id:source??null, status:'POSTED', reversal_of_entry_id:null });
const movement = (entry: string, id: string, amount: string): SavingsMovementGroup => ({entry_id:entry,account_id:id,amount,status:'POSTED'});
describe('savings account ledger attribution', () => {
  it('keeps product balances separate and matches an unfunded account at zero', () => {
    const r=reconcileSavings([account('a','1.15'),account('b','0.23'),account('c','0.00')],[line('j','1.15','a'),line('k','0.23','b')],[movement('j','a','1.15'),movement('k','b','0.23')]);
    expect(r).toMatchObject({checked:3,matched:3,balanced:true,unresolvedEntries:0});expect(r.rows.map(x=>x.ledgerDecimal)).toEqual(['1.15','0.23','0.00']);expect(r.totals.ledgerDecimal).toBe('1.38');
  });
  it('attributes a shared batch only after its account movements equal the member ledger', () => {
    const r=reconcileSavings([account('a','0.01'),account('b','0.02')],[line('j','0.03')],[movement('j','a','0.01'),movement('j','b','0.02')]);
    expect(r.balanced).toBe(true);expect(r.rows.map(x=>x.ledgerDecimal)).toEqual(['0.01','0.02']);expect(r.rows[0]?.attribution).toEqual(['LINKED_TRANSACTIONS']);
  });
  it('refuses to spread an unallocated member journal, even when the combined balance agrees', () => {
    const r=reconcileSavings([account('a','1.00'),account('b','2.00')],[line('j','3.00')],[]);
    expect(r).toMatchObject({balanced:false,matched:0,unresolvedAccounts:2,mismatches:[]});expect(r.rows.every(x=>x.ledgerDecimal===null)).toBe(true);expect(r.unresolved[0]?.reason).toBe('MEMBER_LIABILITY_WITHOUT_ACCOUNT_ALLOCATION');expect(r.totals).toMatchObject({diffDecimal:'0.00',unallocatedLedgerDecimal:'3.00'});
  });
  it('preserves the sole-account legacy member attribution and one-kobo differences', () => {
    const r=reconcileSavings([account('a','90071992547409.91')],[line('j','90071992547409.90')],[]);
    expect(r.mismatches[0]?.diffDecimal).toBe('0.01');expect(r.rows[0]?.attribution).toEqual(['SINGLE_ACCOUNT_MEMBER']);
  });
  it('does not hide a missing batch movement behind a matching member balance', () => {
    const r=reconcileSavings([account('a','1.00'),account('b','2.00')],[line('j','3.00')],[movement('j','a','1.00')]);
    expect(r.unresolved[0]?.reason).toBe('MOVEMENT_LEDGER_DISAGREEMENT');expect(r.matched).toBe(0);expect(r.totals.unallocatedLedgerDecimal).toBe('3.00');
  });
  it('rejects a transaction assigned to another product than its direct journal source', () => {
    const r=reconcileSavings([account('a','0.00'),account('b','1.00')],[line('j','1.00','a')],[movement('j','b','1.00')]);expect(r.unresolved[0]?.reason).toBe('SOURCE_ACCOUNT_CONFLICT');expect(r.balanced).toBe(false);
  });
  it('rejects a source account belonging to another member', () => {
    const r=reconcileSavings([account('a','0.00'),{...account('b','1.00'),member_id:'other'}],[line('j','1.00','b')],[]);expect(r.unresolvedAccounts).toBe(2);expect(r.balanced).toBe(false);
  });
  it('reports an unknown source account rather than falling back to the member total', () => {
    const r=reconcileSavings([account('a','1.00')],[line('j','1.00','unknown')],[]);expect(r.unresolved[0]?.reason).toBe('SOURCE_ACCOUNT_CONFLICT');
  });
  it('flags transactions without posted savings liability evidence', () => {
    const r=reconcileSavings([account('a','1.00')],[],[{...movement('j','a','1.00'),status:'DRAFT'}]);expect(r.balanced).toBe(false);expect(r.unresolved[0]?.reason).toBe('MOVEMENT_WITHOUT_POSTED_LIABILITY');
  });
  it('flags memberless savings liability even when all product projections are zero', () => {
    const r=reconcileSavings([account('a','0.00')],[{...line('j','1.00'),member_id:null}],[]);expect(r.matched).toBe(0);expect(r.unresolved[0]?.reason).toBe('LIABILITY_WITHOUT_MEMBER_ACCOUNT');expect(r.totals.unallocatedLedgerDecimal).toBe('1.00');
  });
  it('counts both reversed originals and their counter-entries exactly once', () => {
    const original={...line('j','1.00','a'),status:'REVERSED'}, reversal={...line('k','-1.00'),reversal_of_entry_id:'j'};
    const r=reconcileSavings([account('a','0.00'),account('b','0.00')],[original,reversal],[{...movement('j','a','1.00'),status:'REVERSED'},movement('k','a','-1.00')]);expect(r.balanced).toBe(true);expect(r.totals.ledgerDecimal).toBe('0.00');
  });
  it('reveals a missing savings projection after a direct journal reversal', () => {
    const r=reconcileSavings([account('a','1.00')],[{...line('j','1.00','a'),status:'REVERSED'},{...line('k','-1.00'),reversal_of_entry_id:'j'}],[{...movement('j','a','1.00'),status:'REVERSED'}]);expect(r.mismatches[0]?.diffDecimal).toBe('1.00');
  });
  it.each(['original','reversal'])('refuses an incomplete reversal pair (%s)', kind => {
    const l=kind==='original'?{...line('j','1.00','a'),status:'REVERSED'}:{...line('j','-1.00'),reversal_of_entry_id:'missing'};
    const r=reconcileSavings([account('a','0.00')],[l],[]);expect(r.balanced).toBe(false);expect(r.unresolvedEntries).toBe(1);
  });
  it('retains aggregate values above the per-column range without narrowing', () => {
    const max='99999999999999999.99';const r=reconcileSavings([account('a',max),account('b',max)],[line('j',max,'a'),line('k',max,'b')],[]);expect(r.balanced).toBe(true);expect(r.totals.ledgerDecimal).toBe('199999999999999999.98');
  });
  it('attributes offsetting product movements even when the member net is zero', () => {
    const r=reconcileSavings([account('a','1.00'),account('b','-1.00')],[line('j','0.00')],[movement('j','a','1.00'),movement('j','b','-1.00')]);expect(r.balanced).toBe(true);expect(r.rows.map(x=>x.ledgerDecimal)).toEqual(['1.00','-1.00']);
  });
  it('detects one-kobo product disagreement despite a matching organisation total', () => {
    const r=reconcileSavings([account('a','90071992547409.92'),account('b','0.00')],[line('j','90071992547409.91','a'),line('k','0.01','b')],[]);expect(r.balanced).toBe(false);expect(r.mismatches.map(x=>x.diffDecimal)).toEqual(['0.01','-0.01']);expect(r.totals.diffDecimal).toBe('0.00');
  });
});
