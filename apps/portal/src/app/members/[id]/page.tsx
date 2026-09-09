'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { apiFetch, clearSession, readToken } from '../../../lib/api';

interface Member360 {
  member: { id: string; memberNo: number; firstName: string; lastName: string; email: string | null; status: string };
  savings: { id: string; accountNo: number; currentBalance: number; status: string }[];
  savingsTotal: number;
  shareBalance: number;
  loans: { id: string; code: string; principal: number; outstandingPrincipal: number; status: string }[];
  loansOutstanding: number;
}

const naira = (n: number): string => `₦${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

export default function MemberDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const memberId = params.id;
  const [data, setData] = useState<Member360 | null>(null);
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState<'DEPOSIT' | 'WITHDRAWAL'>('DEPOSIT');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const token = readToken();
    if (!token) {
      router.replace('/login');
      return;
    }
    try {
      const d = await apiFetch<Member360>(`/reports/member/${memberId}/360`, token);
      setData(d);
      setError(null);
    } catch (err) {
      clearSession();
      setError(err instanceof Error ? err.message : 'Failed to load member');
      router.replace('/login');
    }
  }, [router, memberId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function postMoney(accountId: string): Promise<void> {
    const token = readToken();
    if (!token || !amount) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/savings/accounts/${accountId}/${mode.toLowerCase()}s`, token, {
        method: 'POST',
        body: JSON.stringify({ amount: Number(amount) }),
      });
      setAmount('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Transaction failed');
    } finally {
      setBusy(false);
    }
  }

  async function setMemberStatus(action: 'approve' | 'suspend' | 'exit'): Promise<void> {
    const token = readToken();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      if (action === 'exit') {
        await apiFetch(`/members/${memberId}/exit`, token, { method: 'POST' });
      } else {
        await apiFetch(`/members/${memberId}/${action}`, token, { method: 'POST' });
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return (
      <main style={{ maxWidth: 900, margin: '0 auto', padding: 28 }}>
        <p>{error ?? 'Loading…'}</p>
      </main>
    );
  }
  const m = data.member;

  return (
    <main style={{ maxWidth: 900, margin: '0 auto', padding: 28 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <p style={{ margin: 0, color: '#5b6772', fontSize: 13 }}>
            Member #{m.memberNo} · {m.status}
          </p>
          <h1 style={{ margin: '2px 0 0' }}>
            {m.firstName} {m.lastName}
          </h1>
          <p style={{ margin: '4px 0 0', color: '#5b6772' }}>{m.email ?? 'No email'}</p>
        </div>
        <Link href="/members" style={{ fontSize: 14 }}>
          ← Members
        </Link>
      </div>

      {error && (
        <p style={{ background: '#fdecea', color: '#b42318', borderRadius: 8, padding: '10px 12px', marginTop: 14 }}>
          {error}
        </p>
      )}

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginTop: 18 }}>
        <div className="card">
          <p className="stat-label">Savings</p>
          <p className="stat-value">{naira(data.savingsTotal)}</p>
        </div>
        <div className="card">
          <p className="stat-label">Shares</p>
          <p className="stat-value">{naira(data.shareBalance)}</p>
        </div>
        <div className="card">
          <p className="stat-label">Loan outstanding</p>
          <p className="stat-value">{naira(data.loansOutstanding)}</p>
        </div>
      </section>

      <section className="card" style={{ marginTop: 14 }}>
        <h2 style={{ margin: '0 0 10px', fontSize: 16 }}>Savings accounts</h2>
        {data.savings.length === 0 ? (
          <p style={{ color: '#5b6772' }}>No savings account yet.</p>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Account</th>
                <th>Balance</th>
                <th>Status</th>
                <th>Amount</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {data.savings.map((a) => (
                <tr key={a.id}>
                  <td>#{a.accountNo}</td>
                  <td>{naira(a.currentBalance)}</td>
                  <td>{a.status}</td>
                  <td style={{ width: 140 }}>
                    <input
                      className="field"
                      type="number"
                      min="0"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder="Amount"
                      style={{ padding: '6px 8px', fontSize: 14 }}
                    />
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button
                      className="btn"
                      style={{ padding: '6px 10px', marginRight: 6 }}
                      disabled={busy || !amount}
                      onClick={() => {
                        setMode('DEPOSIT');
                        void postMoney(a.id);
                      }}
                    >
                      Deposit
                    </button>
                    <button
                      className="btn secondary"
                      style={{ padding: '6px 10px' }}
                      disabled={busy || !amount}
                      onClick={() => {
                        setMode('WITHDRAWAL');
                        void postMoney(a.id);
                      }}
                    >
                      Withdraw
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card" style={{ marginTop: 14 }}>
        <h2 style={{ margin: '0 0 10px', fontSize: 16 }}>Loans</h2>
        {data.loans.length === 0 ? (
          <p style={{ color: '#5b6772' }}>No loans.</p>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Product</th>
                <th>Principal</th>
                <th>Outstanding</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.loans.map((l) => (
                <tr key={l.id}>
                  <td>{l.code}</td>
                  <td>{naira(l.principal)}</td>
                  <td>{naira(l.outstandingPrincipal)}</td>
                  <td>{l.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button className="btn" disabled={busy} onClick={() => void setMemberStatus('approve')}>
          Approve
        </button>
        <button className="btn secondary" disabled={busy} onClick={() => void setMemberStatus('suspend')}>
          Suspend
        </button>
        <button
          className="btn secondary"
          style={{ color: '#b42318' }}
          disabled={busy}
          onClick={() => {
            if (confirm(`Exit member #${m.memberNo}? Balances will be paid out and accounts closed.`)) {
              void setMemberStatus('exit');
            }
          }}
        >
          Exit member
        </button>
      </section>
    </main>
  );
}
