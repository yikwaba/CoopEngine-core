'use client';
import {reportMoney} from '../lib/report-money';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  apiFetch,
  logoutSession,
  readToken,
  API_BASE,
} from '../lib/api';
import Nav from './components/Nav';
import TodayStrip from './components/TodayStrip';

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
  totalBalance: number; totalBalanceDecimal?: string;
}

interface LoanBook {
  outstandingTotal: number; outstandingTotalDecimal?: string;
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
        const [memberList, savingsBook, loanBook] = await Promise.allSettled([
          apiFetch<MemberRow[]>('/members', token),
          apiFetch<SavingsBook>('/reports/savings-book', token),
          apiFetch<LoanBook>('/reports/loan-book', token),
        ]);
        if (cancelled || !readToken()) return;
        if (memberList.status === 'fulfilled') {
          setMembers(memberList.value.slice(0, 8));
          setMemberCount(memberList.value.length);
        }
        if (savingsBook.status === 'fulfilled') setSavings(savingsBook.value);
        if (loanBook.status === 'fulfilled') setLoans(loanBook.value);
        if ([memberList, savingsBook, loanBook].some(result => result.status === 'rejected')) {
          setError('Some dashboard information could not be loaded. You can continue using the available workflows.');
        }
        setReady(true);
      } catch {
        if (cancelled) return;
        // apiResponse already revokes the local marker and redirects on 401.
        // A permission refusal or service error must not erase a valid session.
        if (!readToken()) return;
        setError('Dashboard information could not be loaded. You can continue using the available workflows.');
        setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function signOut(): Promise<void> {
    try {
      await logoutSession();
    } finally {
      router.replace('/login');
    }
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
        <button className="btn secondary" onClick={() => void signOut()}>
          Sign out
        </button>
      </header>
      <Nav />
      <TodayStrip />
      {error && <p role="alert">{error}</p>}

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 14 }}>
        <div className="card">
          <p className="stat-label">Members</p>
          <p className="stat-value">{ready && memberCount !== null ? memberCount : ready ? '—' : '…'}</p>
        </div>
        <div className="card">
          <p className="stat-label">Member savings (₦)</p>
          <p className="stat-value">
            {ready && savings ? reportMoney(savings.totalBalanceDecimal ?? savings.totalBalance).replace('₦','') : ready ? '—' : '…'}
          </p>
        </div>
        <div className="card">
          <p className="stat-label">Outstanding loans (₦)</p>
          <p className="stat-value">
            {ready && loans ? reportMoney(loans.outstandingTotalDecimal ?? loans.outstandingTotal).replace('₦','') : ready ? '—' : '…'}
          </p>
        </div>
        <div className="card">
          <p className="stat-label">Active loans</p>
          <p className="stat-value">{ready && loans ? loans.disbursedCount : ready ? '—' : '…'}</p>
        </div>
      </section>

      <section className="card" style={{ marginTop: 20 }}>
        <h2 style={{ margin: '0 0 10px', fontSize: 17 }}>Recent members</h2>
        {ready && memberCount !== null ? (
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
          <p style={{ color: '#5b6772' }}>{ready ? 'Member information is unavailable.' : 'Loading…'}</p>
        )}
      </section>
    </main>
  );
}
