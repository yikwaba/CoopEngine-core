'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
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

interface VirtualAccount {
  id: string;
  provider: string;
  accountNumber: string;
  accountName: string;
  bankName: string;
  status: string;
}

interface MemberPayment {
  id: string;
  paymentReference: string;
  amount: number;
  paidAt: string;
  status: string;
}

const naira = (n: number): string =>
  `₦${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

export default function MemberDashboardPage() {
  const router = useRouter();
  const [data, setData] = useState<Dashboard | null>(null);
  const [vAccount, setVAccount] = useState<VirtualAccount | null>(null);
  const [funding, setFunding] = useState<MemberPayment[]>([]);
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
        const [dash, acc, payments] = await Promise.all([
          apiFetch<Dashboard>('/member/dashboard', token),
          apiFetch<VirtualAccount | null>('/member/virtual-account', token),
          apiFetch<MemberPayment[]>('/member/payments', token),
        ]);
        if (!cancelled) {
          setData(dash);
          setVAccount(acc);
          setFunding(payments);
        }
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
    Promise.all([
      apiFetch<Dashboard>('/member/dashboard', token),
      apiFetch<VirtualAccount | null>('/member/virtual-account', token),
      apiFetch<MemberPayment[]>('/member/payments', token),
    ])
      .then(([dash, acc, payments]) => {
        setData(dash);
        setVAccount(acc);
        setFunding(payments);
      })
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
          <Link href="/loans" style={{ fontSize: 13, padding: '6px 10px', background: '#eef4ff', borderRadius: 8, color: '#123a6b' }}>
            Loans
          </Link>
          <button onClick={refresh} style={{ fontSize: 13, padding: '6px 10px' }}>
            ↻
          </button>
          <button onClick={signOut} style={{ fontSize: 13, padding: '6px 10px' }}>
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

      {vAccount && (
        <section
          className="card"
          style={{
            marginTop: 14,
            background: '#0a6c2e',
            color: '#fff',
          }}
        >
          <h2 style={{ margin: '0 0 6px', fontSize: 15 }}>My collection account</h2>
          <p style={{ margin: '2px 0', fontSize: 15 }}>
            Transfer to <strong>{vAccount.accountNumber}</strong> — {vAccount.bankName}
          </p>
          <p style={{ margin: '2px 0', opacity: 0.9, fontSize: 13 }}>
            {vAccount.accountName} · funds credit your savings automatically
          </p>
        </section>
      )}

      <section className="card" style={{ marginTop: 14 }}>
        <h2 style={{ margin: '0 0 8px', fontSize: 15 }}>Recent activity</h2>
        {data ? (
          data.recentTransactions.length === 0 && funding.length === 0 ? (
            <p style={{ color: '#5b6772', margin: 0 }}>No transactions yet.</p>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {funding.map((p) => (
                <li
                  key={`fund-${p.id}`}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    padding: '9px 0',
                    borderBottom: '1px solid #eef1f5',
                    fontSize: 14,
                  }}
                >
                  <span>Transfer received — {p.paymentReference}</span>
                  <span style={{ fontWeight: 600, color: '#067647' }}>
                    +{naira(p.amount)}
                  </span>
                </li>
              ))}
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
