'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  apiFetch,
  clearSession,
  readToken,
  API_BASE,
} from '../lib/api';
import Nav from './components/Nav';

interface MemberRow {
  id: string;
  memberNo: number;
  firstName: string;
  lastName: string;
  email: string | null;
  status: string;
}

interface SavingsBook {
  totalMembers: number;
  totalBalance: number;
}

interface LoanBook {
  outstandingTotal: number;
  disbursedCount: number;
}

export default function DashboardPage() {
  const router = useRouter();
  const [memberCount, setMemberCount] = useState<number | null>(null);
  const [savings, setSavings] = useState<SavingsBook | null>(null);
  const [loans, setLoans] = useState<LoanBook | null>(null);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const token = readToken();
    if (!token) {
      router.replace('/login');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [memberList, savingsBook, loanBook] = await Promise.all([
          apiFetch<MemberRow[]>('/members', token),
          apiFetch<SavingsBook>('/reports/savings-book', token),
          apiFetch<LoanBook>('/reports/loan-book', token),
        ]);
        if (cancelled) return;
        setMembers(memberList.slice(0, 8));
        setMemberCount(memberList.length);
        setSavings(savingsBook);
        setLoans(loanBook);
        setReady(true);
      } catch (err) {
        if (cancelled) return;
        // Token likely expired/revoked -> back to login
        clearSession();
        setError(err instanceof Error ? err.message : 'Failed to load dashboard');
        router.replace('/login');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  function signOut(): void {
    clearSession();
    router.replace('/login');
  }

  if (error) {
    return (
      <main style={{ padding: 40 }}>
        <p>{error}</p>
        <button className="btn secondary" onClick={signOut}>
          Back to sign in
        </button>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 1000, margin: '0 auto', padding: 28 }}>
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 4,
        }}
      >
        <div>
          <h1 style={{ margin: 0 }}>Dashboard</h1>
          <p style={{ margin: '4px 0 0', color: '#5b6772', fontSize: 14 }}>
            API: {API_BASE}
          </p>
        </div>
        <button className="btn secondary" onClick={signOut}>
          Sign out
        </button>
      </header>
      <Nav />

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 14 }}>
        <div className="card">
          <p className="stat-label">Members</p>
          <p className="stat-value">{ready && memberCount !== null ? memberCount : '…'}</p>
        </div>
        <div className="card">
          <p className="stat-label">Member savings (₦)</p>
          <p className="stat-value">
            {ready && savings ? savings.totalBalance.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '…'}
          </p>
        </div>
        <div className="card">
          <p className="stat-label">Outstanding loans (₦)</p>
          <p className="stat-value">
            {ready && loans ? loans.outstandingTotal.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '…'}
          </p>
        </div>
        <div className="card">
          <p className="stat-label">Active loans</p>
          <p className="stat-value">{ready && loans ? loans.disbursedCount : '…'}</p>
        </div>
      </section>

      <section className="card" style={{ marginTop: 20 }}>
        <h2 style={{ margin: '0 0 10px', fontSize: 17 }}>Recent members</h2>
        {ready ? (
          <table className="data">
            <thead>
              <tr>
                <th>No.</th>
                <th>Name</th>
                <th>Email</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {members.length === 0 ? (
                <tr>
                  <td colSpan={4} style={{ color: '#5b6772' }}>
                    No members yet.
                  </td>
                </tr>
              ) : (
                members.map((m) => (
                  <tr key={m.id}>
                    <td>{m.memberNo}</td>
                    <td>
                      {m.firstName} {m.lastName}
                    </td>
                    <td>{m.email ?? '—'}</td>
                    <td>{m.status}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        ) : (
          <p style={{ color: '#5b6772' }}>Loading…</p>
        )}
      </section>
    </main>
  );
}
