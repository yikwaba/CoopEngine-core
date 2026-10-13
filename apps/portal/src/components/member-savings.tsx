'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, FINANCIAL_WRITES_EVENT, pendingFinancialWrites, readToken, syncFinancialWrites } from '../lib/api';
import { reportMoney } from '../lib/report-money';
import { savingsAmount } from '../lib/savings-money';

interface Account { accountId: string; accountNo: number; productCode: string; balance: number; balanceDecimal?: string; status: string }
interface Product { id: string; code: string; name: string; status: string; allowWithdrawal: boolean; minDeposit: number; minDepositDecimal?: string }
export default function MemberSavings({ memberId, memberStatus, accounts, reload }: {
  memberId: string; memberStatus: string; accounts: Account[]; reload: () => Promise<void>;
}) {
  const [products, setProducts] = useState<Product[]>([]), [permissions, setPermissions] = useState<string[]>([]);
  const [productId, setProductId] = useState(''), [amounts, setAmounts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [pending, setPending] = useState<ReturnType<typeof pendingFinancialWrites>>([]);
  const previousPending = useRef<string[]>([]);
  const openPath = `/savings/member/${memberId}/account`;
  const opening = pending.find(record => record.path === openPath);
  const pendingAccount = (id: string) => pending.some(record => record.path.startsWith(`/savings/accounts/${id}/`));
  const canPost = permissions.includes('savings.post'), canWithdraw = permissions.includes('savings.withdraw');
  const readPending = useCallback(async () => {
    const records = pendingFinancialWrites();
    const paths = records.map(record => record.path);
    // Acknowledging a recovered posting clears its old amount, even in another tab.
    const acknowledged = previousPending.current.filter(path => !paths.includes(path));
    previousPending.current = paths;
    setPending(records);
    if (acknowledged.length) {
      setError('');
      if (acknowledged.includes(`/savings/member/${memberId}/account`)) setProductId('');
      setAmounts(current => {
        const next = { ...current };
        for (const path of acknowledged) { const id = path.split('/')[3]; if (id) delete next[id]; }
        return next;
      });
      await reload();
    }
  }, [reload, memberId]);
  useEffect(() => {
    let cancelled = false;
    const token = readToken();
    if (!token) return;
    void (async () => {
      try {
        const me = await apiFetch<{ permissions: string[] }>('/auth/me', token);
        if (cancelled) return;
        setPermissions(me.permissions);
        if (!me.permissions.includes('savings.post')) return;
        const available = await apiFetch<Product[]>('/savings/products', token);
        if (!cancelled) setProducts(available.filter(product => product.status === 'ACTIVE'));
      } catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load savings permissions and products.'); }
    })();
    return () => { cancelled = true; };
  }, [memberId]);
  useEffect(() => {
    const refresh = () => { void readPending().catch(e => setError(e instanceof Error ? e.message : 'Could not read pending requests.')); };
    refresh();
    // Show current intent immediately while another tab holds the write lock.
    void syncFinancialWrites().then(refresh).catch(e => setError(e instanceof Error ? e.message : 'Could not migrate pending requests.'));
    window.addEventListener(FINANCIAL_WRITES_EVENT, refresh); window.addEventListener('storage', refresh); window.addEventListener('focus', refresh);
    return () => { window.removeEventListener(FINANCIAL_WRITES_EVENT, refresh); window.removeEventListener('storage', refresh); window.removeEventListener('focus', refresh); };
  }, [readPending]);
  let selectedProduct = productId;
  if (opening) { try { selectedProduct = JSON.parse(opening.payload).productId ?? ''; } catch { selectedProduct = ''; } }
  async function openAccount() {
    const token = readToken(); if (!token || !selectedProduct || opening || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const account = await apiFetch<{ accountNo: number; status: string }>(openPath, token, { method: 'POST', body: JSON.stringify({ productId: selectedProduct }) });
      setNotice(`Savings account #${account.accountNo} confirmed (${account.status}). Opening an account does not deposit money.`);
      setProductId(''); await reload();
    } catch (e) { setError(e instanceof Error ? e.message : 'Account opening failed.'); }
    finally { setBusy(false); }
  }
  async function postMoney(accountId: string, action: 'deposits' | 'withdrawals') {
    const token = readToken(); if (!token || busy || pendingAccount(accountId)) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const amount = savingsAmount(amounts[accountId] ?? '');
      const result = await apiFetch<{ kind?: string }>(`/savings/accounts/${accountId}/${action}`, token, { method: 'POST', body: JSON.stringify({ amount }) });
      setAmounts(current => ({ ...current, [accountId]: '' }));
      setNotice(action === 'deposits' ? 'Deposit acknowledged. Check the refreshed account balance.' : result.kind === 'PENDING' ? 'Withdrawal submitted for approval; no payout yet.' : 'Withdrawal acknowledged. Check the refreshed account balance.');
      await reload();
    } catch (e) { setError(e instanceof Error ? e.message : 'Transaction failed.'); }
    finally { setBusy(false); }
  }
  return <section className="card" style={{ marginTop: 14 }} aria-label="Member savings accounts">
    <h2 style={{ margin: '0 0 10px', fontSize: 16 }}>Savings accounts</h2>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {canPost && <fieldset disabled={busy || !!opening || memberStatus !== 'ACTIVE'} style={{ border: 0, padding: 0, marginBottom: 16, minWidth: 0 }}>
      <legend>Open savings account</legend>
      <label htmlFor="savings-product">Savings product</label>
      <select id="savings-product" className="field" style={{ width: '100%', maxWidth: '100%', padding: 10, marginBottom: 10 }} value={selectedProduct} onChange={e => setProductId(e.target.value)}>
        <option value="">Choose a product</option>
        {products.map(product => <option key={product.id} value={product.id}>{product.code} · {product.name}{product.allowWithdrawal ? ' · withdrawals allowed' : ' · withdrawals restricted'} · minimum deposit {reportMoney(product.minDepositDecimal ?? product.minDeposit)}</option>)}
        {opening && selectedProduct && !products.some(p => p.id === selectedProduct) && <option value={selectedProduct}>Original requested product</option>}
      </select>
      <button className="btn" type="button" disabled={!selectedProduct} onClick={() => void openAccount()}>Open savings account</button>
      {!products.length && <p>No active savings products are available.</p>}
    </fieldset>}
    {memberStatus !== 'ACTIVE' && <p>Account opening and money posting on this page require an active member.</p>}
    {opening && <p>Account opening has an unconfirmed result. Use Recover original request before selecting another product.</p>}
    {accounts.length === 0 ? <p>No savings account yet.</p> : <div style={{ overflowX: 'auto' }}><table className="data">
      <thead><tr><th>Account / product</th><th>Balance</th><th>Status</th>{(canPost || canWithdraw) && <><th>Amount</th><th>Action</th></>}</tr></thead>
      <tbody>{accounts.map(account => {
        const disabled = busy || pendingAccount(account.accountId) || memberStatus !== 'ACTIVE' || account.status !== 'ACTIVE';
        return <tr key={account.accountId} aria-label={`Savings account ${account.accountNo}`}>
          <td>#{account.accountNo} · {account.productCode}</td><td>{reportMoney(account.balanceDecimal ?? account.balance)}</td><td>{account.status}</td>
          {(canPost || canWithdraw) && <><td><label htmlFor={`amount-${account.accountId}`}>Amount for account #{account.accountNo}</label>
            <input id={`amount-${account.accountId}`} className="field" inputMode="decimal" disabled={disabled} value={amounts[account.accountId] ?? ''} onChange={e => setAmounts(current => ({ ...current, [account.accountId]: e.target.value }))} />
          </td><td>{canPost && <button className="btn" disabled={disabled || !amounts[account.accountId]} onClick={() => void postMoney(account.accountId, 'deposits')}>Deposit</button>}
            {canWithdraw && <button className="btn secondary" disabled={disabled || !amounts[account.accountId]} onClick={() => void postMoney(account.accountId, 'withdrawals')}>Withdraw</button>}
            {pendingAccount(account.accountId) && <p>Unconfirmed transaction. Recover the original request first.</p>}
          </td></>}
        </tr>;
      })}</tbody>
    </table></div>}
    <button type="button" disabled={busy} onClick={() => void reload()}>Refresh member accounts</button>
  </section>;
}
