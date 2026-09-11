'use client';

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { apiFetch, downloadPdf, readToken } from '../../lib/api';

interface MemberRow {
  id: string;
  memberNo: number | string;
  firstName: string;
  lastName: string;
  phone?: string | null;
  email?: string | null;
  status: string;
}

interface SavingsAccount {
  accountId: string;
  accountNo: string;
  balance: string | number;
  productCode?: string;
  status?: string;
}

interface LoanRow {
  id: string;
  productCode?: string;
  principal?: string | number;
  outstandingPrincipal?: string | number;
  status?: string;
}

interface Member360 {
  member: MemberRow;
  savings?: SavingsAccount[];
  loans?: LoanRow[];
}

const naira = (v: string | number | undefined | null): string => {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return '₦0.00';
  const sign = n < 0 ? '-' : '';
  return `${sign}₦${Math.abs(n).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

export default function FrontDeskPage() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MemberRow[]>([]);
  const [selected, setSelected] = useState<Member360 | null>(null);
  const [amount, setAmount] = useState('');
  const [loanId, setLoanId] = useState('');
  const [note, setNote] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState(false);

  const token = () => {
    const t = readToken();
    if (!t) setError('Please sign in first.');
    return t;
  };

  const openMember = useCallback(async (id: string) => {
    const t = readToken();
    if (!t) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const data = await apiFetch<Member360>(`/reports/member/${id}/360`, t);
      setSelected(data);
      const firstLoan = (data.loans ?? [])[0];
      setLoanId(firstLoan ? String(firstLoan.id) : '');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open that member.');
      setSelected(null);
    } finally {
      setBusy(false);
    }
  }, []);

  async function search() {
    const t = token();
    if (!t) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const q = query.trim();
      const list = await apiFetch<MemberRow[]>(`/members?limit=20${q ? `&q=${encodeURIComponent(q)}` : ''}`, t);
      setResults(list);
      setSearched(true);
      const only = list[0];
      if (list.length === 1 && only) await openMember(only.id);
      else setSelected(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Search failed.');
    } finally {
      setBusy(false);
    }
  }

  const primaryAccount = useMemo(
    () => (selected?.savings ?? []).find((a) => (a.status ?? 'ACTIVE') === 'ACTIVE') ?? selected?.savings?.[0],
    [selected],
  );

  async function afterAction(text: string) {
    setMessage(text);
    if (selected) await openMember(selected.member.id);
    setAmount('');
    setNote('');
  }

  async function takeDeposit() {
    const t = token();
    if (!t || !primaryAccount) return;
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      setError('Enter the amount received, for example 5000.');
      return;
    }
    if (!window.confirm(`Record ${naira(value)} as a deposit for ${selected?.member.firstName} ${selected?.member.lastName}?`)) return;
    setBusy(true);
    setError('');
    try {
      await apiFetch(`/savings/accounts/${primaryAccount.accountId}/deposits`, t, {
        method: 'POST',
        body: JSON.stringify({ amount: value, description: note || 'Counter deposit' }),
      });
      await afterAction(`Deposit of ${naira(value)} recorded.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The deposit could not be recorded.');
    } finally {
      setBusy(false);
    }
  }

  async function takeRepayment() {
    const t = token();
    if (!t) return;
    const value = Number(amount);
    if (!loanId) {
      setError('This member has no loan to repay.');
      return;
    }
    if (!Number.isFinite(value) || value <= 0) {
      setError('Enter the amount received.');
      return;
    }
    if (!window.confirm(`Record ${naira(value)} as a loan repayment?`)) return;
    setBusy(true);
    setError('');
    try {
      await apiFetch(`/loans/${loanId}/repayments`, t, {
        method: 'POST',
        body: JSON.stringify({ amount: value, note: note || 'Counter repayment' }),
      });
      await afterAction(`Repayment of ${naira(value)} recorded.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The repayment could not be recorded.');
    } finally {
      setBusy(false);
    }
  }

  async function requestWithdrawal() {
    const t = token();
    if (!t || !primaryAccount) return;
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      setError('Enter the amount to withdraw.');
      return;
    }
    if (!window.confirm(`Request a withdrawal of ${naira(value)}? Any amount above the cooperative's limit needs a second officer's approval.`)) return;
    setBusy(true);
    setError('');
    try {
      await apiFetch(`/savings/accounts/${primaryAccount.accountId}/withdrawals`, t, {
        method: 'POST',
        body: JSON.stringify({ amount: value, note: note || 'Counter withdrawal request' }),
      });
      await afterAction(`Withdrawal of ${naira(value)} requested.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The withdrawal could not be requested.');
    } finally {
      setBusy(false);
    }
  }

  function printStatement() {
    if (!selected) return;
    void downloadPdf(
      `/pdf/members/${selected.member.id}/statement.pdf`,
      `statement-${selected.member.memberNo}.pdf`,
    );
  }

  const btn: React.CSSProperties = {
    padding: '12px 18px',
    borderRadius: 8,
    border: 'none',
    fontSize: 15,
    cursor: 'pointer',
  };

  return (
    <main style={{ maxWidth: 960, margin: '0 auto', padding: 24 }}>
      <Link href="/">← Dashboard</Link>
      <h1 style={{ marginTop: 12, marginBottom: 4 }}>Front desk</h1>
      <p style={{ color: '#555', marginTop: 0 }}>
        Find a member, then take a deposit, record a repayment or print a statement. Nothing here needs a manual.
      </p>

      <section style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && search()}
          placeholder="Name, phone, email or member number"
          style={{ flex: 1, padding: 14, fontSize: 16, border: '1px solid #ccc', borderRadius: 8 }}
        />
        <button onClick={search} disabled={busy} style={{ ...btn, background: '#1d4ed8', color: '#fff' }}>
          {busy ? 'Working…' : 'Find member'}
        </button>
      </section>

      {error && <p style={{ color: '#b91c1c', marginTop: 12 }}>⚠️ {error}</p>}
      {message && <p style={{ color: '#166534', marginTop: 12 }}>✅ {message}</p>}

      {searched && results.length === 0 && (
        <p style={{ marginTop: 16, color: '#666' }}>
          No member matched “{query}”. Check the spelling, or{' '}
          <Link href="/members">register a new member</Link>.
        </p>
      )}

      {results.length > 1 && (
        <ul style={{ listStyle: 'none', padding: 0, marginTop: 16 }}>
          {results.map((m) => (
            <li key={m.id} style={{ borderBottom: '1px solid #eee', padding: '10px 0' }}>
              <button
                onClick={() => openMember(m.id)}
                style={{ ...btn, background: 'transparent', textAlign: 'left', width: '100%' }}
              >
                <strong>
                  {m.firstName} {m.lastName}
                </strong>{' '}
                <span style={{ color: '#666' }}>
                  #{m.memberNo} · {m.phone ?? m.email ?? 'no contact'} · {m.status}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected && (
        <section style={{ marginTop: 20, border: '1px solid #e5e7eb', borderRadius: 12, padding: 18 }}>
          <h2 style={{ margin: 0 }}>
            {selected.member.firstName} {selected.member.lastName}{' '}
            <span style={{ fontSize: 15, color: '#666', fontWeight: 400 }}>
              #{selected.member.memberNo} · {selected.member.status}
            </span>
          </h2>

          <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', marginTop: 12 }}>
            <div>
              <div style={{ fontSize: 13, color: '#666' }}>Savings balance</div>
              <div style={{ fontSize: 22, fontWeight: 600 }}>{naira(primaryAccount?.balance)}</div>
              {primaryAccount && (
                <div style={{ fontSize: 12, color: '#888' }}>account {primaryAccount.accountNo}</div>
              )}
            </div>
            <div>
              <div style={{ fontSize: 13, color: '#666' }}>Loans</div>
              {(selected.loans ?? []).length === 0 ? (
                <div style={{ fontSize: 16, color: '#666' }}>none</div>
              ) : (
                <div style={{ fontSize: 16 }}>
                  {(selected.loans ?? []).length} loan(s) ·{' '}
                  <strong>
                    {naira(
                      (selected.loans ?? []).reduce(
                        (acc, l) => acc + Number(l.outstandingPrincipal ?? 0),
                        0,
                      ),
                    )}
                  </strong>{' '}
                  outstanding
                  {(selected.loans ?? []).some((l) => l.status === 'DEFAULTED') && (
                    <span style={{ color: '#b45309' }}> · in default</span>
                  )}
                </div>
              )}
            </div>
          </div>

          <div style={{ marginTop: 18, display: 'grid', gap: 12 }}>
            <label style={{ fontWeight: 600 }}>Amount (₦)</label>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              placeholder="5000"
              style={{ padding: 14, fontSize: 16, border: '1px solid #ccc', borderRadius: 8, maxWidth: 260 }}
            />
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Note (optional) — e.g. October savings"
              style={{ padding: 12, fontSize: 15, border: '1px solid #ccc', borderRadius: 8 }}
            />
            {(selected.loans ?? []).length > 1 && (
              <select
                value={loanId}
                onChange={(e) => setLoanId(e.target.value)}
                style={{ padding: 12, fontSize: 15, border: '1px solid #ccc', borderRadius: 8, maxWidth: 320 }}
              >
                {(selected.loans ?? []).map((l) => (
                  <option key={l.id} value={l.id}>
                    Loan {l.productCode ?? 'loan'} · {naira(l.outstandingPrincipal)} outstanding
                  </option>
                ))}
              </select>
            )}

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
              <button onClick={takeDeposit} disabled={busy} style={{ ...btn, background: '#16a34a', color: '#fff' }}>
                Take a deposit
              </button>
              <button
                onClick={takeRepayment}
                disabled={busy || (selected.loans ?? []).length === 0}
                style={{ ...btn, background: '#0e7490', color: '#fff', opacity: (selected.loans ?? []).length === 0 ? 0.5 : 1 }}
              >
                Record a repayment
              </button>
              <button onClick={requestWithdrawal} disabled={busy} style={{ ...btn, background: '#f59e0b', color: '#3f2d00' }}>
                Request a withdrawal
              </button>
              <button onClick={printStatement} style={{ ...btn, border: '1px solid #d1d5db', background: '#fff' }}>
                Print statement (PDF)
              </button>
            </div>
          </div>

          <p style={{ fontSize: 13, color: '#666', marginTop: 14 }}>
            Deposits and repayments post straight away and appear on the member's statement. A withdrawal
            above your cooperative's limit is held for a second officer to approve.
          </p>
        </section>
      )}
    </main>
  );
}
