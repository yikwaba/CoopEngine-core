'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  apiFetch,
  clearMemberSession,
  readMemberInfo,
  readMemberToken,
} from '../lib/api';

interface Dashboard {
  member: { id: string; memberNo: number; firstName: string; lastName: string; email: string | null; status: string };
  savingsTotal: number;
  shareBalance: number;
  loansOutstandingTotal: number;
  nextDue: { dueDate: string; amount: number } | null;
  recentTransactions: {
    type: string;
    signedAmount: number;
    runningBalance: number;
    description: string;
    createdAt: string;
  }[];
}

const naira = (n: number): string =>
  `₦${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

export default function MemberDashboardPage() {
  const router = useRouter();
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const info = readMemberInfo();

  useEffect(() => {
    const token = readMemberToken();
    if (!token) {
      router.replace('/login');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const dash = await apiFetch<Dashboard>('/member/dashboard', token);
        if (!cancelled) setData(dash);
      } catch (err) {
        if (cancelled) return;
        clearMemberSession();
        setError(err instanceof Error ? err.message : 'Failed to load your account');
        router.replace('/login');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  function refresh(): void {
    const token = readMemberToken();
    if (!token) return;
    setData(null);
    void apiFetch<Dashboard>('/member/dashboard', token)
      .then(setData)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Refresh failed');
      });
  }

  function signOut(): void {
    clearMemberSession();
    router.replace('/login');
  }

  if (error) {
    return (
      <main style={{ padding: 24 }}>
        <p>{error}</p>
        <button className="btn secondary" onClick={signOut}>
          Back to sign in
        </button>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 560, margin: '0 auto', padding: 20 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <p style={{ margin: 0, color: '#5b6772', fontSize: 13 }}>
            Member #{(data?.member.memberNo ?? info?.memberNo) ?? '…'} · Co-opEngine
          </p>
          <h1 style={{ margin: '2px 0 0', fontSize: 22 }}>
            {data ? `${data.member.firstName} ${data.member.lastName}` : 'Loading…'}
          </h1>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn secondary" onClick={refresh} title="Refresh balances">
            ↻ Refresh
          </button>
          <button className="btn secondary" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>

      <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 18 }}>
        <div className="card">
          <p className="stat-label">My savings</p>
          <p className="stat-value">{data ? naira(data.savingsTotal) : '…'}</p>
        </div>
        <div className="card">
          <p className="stat-label">My shares</p>
          <p className="stat-value">{data ? naira(data.shareBalance) : '…'}</p>
        </div>
        <div className="card">
          <p className="stat-label">Loan outstanding</p>
          <p className="stat-value">{data ? naira(data.loansOutstandingTotal) : '…'}</p>
        </div>
        <div className="card">
          <p className="stat-label">Next due</p>
          <p className="stat-value" style={{ fontSize: 17 }}>
            {data
              ? data.nextDue
                ? `${naira(data.nextDue.amount)} on ${data.nextDue.dueDate}`
                : 'None'
              : '…'}
          </p>
        </div>
      </section>

      <section className="card" style={{ marginTop: 14 }}>
        <h2 style={{ margin: '0 0 8px', fontSize: 15 }}>Recent activity</h2>
        {data ? (
          data.recentTransactions.length === 0 ? (
            <p style={{ color: '#5b6772', margin: 0 }}>No transactions yet.</p>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {data.recentTransactions.map((t, i) => (
                <li
                  key={i}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    padding: '9px 0',
                    borderBottom: '1px solid #eef1f5',
                    fontSize: 14,
                  }}
                >
                  <span>
                    {t.type === 'DEPOSIT'
                      ? 'Deposit'
                      : t.type === 'WITHDRAWAL'
                        ? 'Withdrawal'
                        : t.type === 'INTEREST'
                          ? 'Interest earned'
                          : t.type === 'CLOSING_PAYOUT'
                            ? 'Closing payout'
                            : t.type}{' '}
                    — {t.description}
                  </span>
                  <span style={{ fontWeight: 600, color: t.signedAmount >= 0 ? '#067647' : '#b42318' }}>
                    {t.signedAmount >= 0 ? '+' : ''}
                    {naira(t.signedAmount)}
                  </span>
                </li>
              ))}
            </ul>
          )
        ) : (
          <p style={{ color: '#5b6772' }}>Loading…</p>
        )}
      </section>
    </main>
  );
}
