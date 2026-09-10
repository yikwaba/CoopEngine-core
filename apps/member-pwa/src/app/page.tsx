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

interface MyGoal {
  id: string;
  name: string;
  targetAmount: number;
  targetDate: string | null;
  progress: number;
  percent: number;
  status: string;
}

interface StandingInstruction {
  id: string;
  amount: number;
  frequency: string;
  nextRunDate: string;
  status: string;
  note: string | null;
}

interface MyDocument {
  id: string;
  docType: string;
  fileName: string;
  status: string;
  createdAt: string;
}

interface MemberNotification {
  id: string;
  type: string;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
}

interface DividendPayout {
  periodLabel: string;
  amount: number;
  postedAt: string;
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
  const [dividends, setDividends] = useState<DividendPayout[]>([]);
  const [notes, setNotes] = useState<MemberNotification[]>([]);
  const [docs, setDocs] = useState<MyDocument[]>([]);
  const [goals, setGoals] = useState<MyGoal[]>([]);
  const [instructions, setInstructions] = useState<StandingInstruction[]>([]);
  const [goalForm, setGoalForm] = useState({ name: '', target: '' });
  const [uploading, setUploading] = useState(false);
  const [docMsg, setDocMsg] = useState<string | null>(null);
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


  async function uploadDocument(file: File): Promise<void> {
    const token = readMemberToken();
    if (!token) return;
    setUploading(true);
    setDocMsg(null);
    try {
      const buffer = await file.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buffer);
      for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i] as number);
      const contentBase64 = window.btoa(binary);
      const docType = /pdf$/i.test(file.name)
        ? 'UTILITY_BILL'
        : /(id|nin|licen)/i.test(file.name)
          ? 'ID_CARD'
          : 'OTHER';
      await apiFetch('/member/documents', token, {
        method: 'POST',
        body: JSON.stringify({
          docType,
          fileName: file.name,
          mimeType: file.type || 'application/octet-stream',
          contentBase64,
        }),
      });
      setDocMsg('Document uploaded — awaiting verification.');
      await refresh();
    } catch (e) {
      setDocMsg(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

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

      {dividends.length > 0 && (
        <section className="card" style={{ marginTop: 14 }}>
          <h2 style={{ margin: '0 0 8px', fontSize: 15 }}>Dividends received</h2>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {dividends.map((d) => (
              <li
                key={`${d.periodLabel}-${d.postedAt}`}
                style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: 14 }}
              >
                <span>{d.periodLabel} distribution</span>
                <strong style={{ color: '#0a6c2e' }}>+₦{d.amount.toLocaleString()}</strong>
              </li>
            ))}
          </ul>
        </section>
      )}

      {data && data.recentTransactions.length > 1 && (
        <section className="card" style={{ marginTop: 14 }}>
          <h2 style={{ margin: '0 0 8px', fontSize: 15 }}>Savings trend</h2>
          <svg viewBox="0 0 300 60" width="100%" height="60" role="img" aria-label="Savings balance trend">
            <polyline
              fill="none"
              stroke="#0a6c2e"
              strokeWidth="2"
              points={data.recentTransactions
                .slice()
                .reverse()
                .map((t, i, arr) => {
                  const max = Math.max(...arr.map((x) => x.runningBalance), 1);
                  const x = arr.length > 1 ? (i / (arr.length - 1)) * 296 + 2 : 150;
                  const y = 58 - (t.runningBalance / max) * 54;
                  return `${x},${y}`;
                })
                .join(' ')}
            />
          </svg>
        </section>
      )}

      <section className="card" style={{ marginTop: 14 }}>
        <h2 style={{ margin: '0 0 8px', fontSize: 15 }}>Savings goals</h2>
        {goals.map((g) => (
          <div key={g.id} style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
              <strong>{g.name}</strong>
              <span>
                ₦{g.progress.toLocaleString()} / ₦{g.targetAmount.toLocaleString()}
              </span>
            </div>
            <div style={{ background: '#eef1f4', borderRadius: 6, height: 8, marginTop: 4 }}>
              <div
                style={{
                  width: `${g.percent}%`,
                  height: 8,
                  borderRadius: 6,
                  background: g.status === 'ACHIEVED' ? '#0a6c2e' : '#1d4ed8',
                }}
              />
            </div>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: '#5b6772' }}>
              {g.percent}% · {g.status}
              {g.targetDate ? ` · by ${g.targetDate}` : ''}
            </p>
          </div>
        ))}
        {goals.length === 0 && <p style={{ fontSize: 13, color: '#5b6772' }}>No goals yet.</p>}
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <input
            placeholder="Goal name (e.g. Rent)"
            value={goalForm.name}
            onChange={(e) => setGoalForm({ ...goalForm, name: e.target.value })}
            style={{ flex: 1, padding: 8, borderRadius: 8, border: '1px solid #cfd6de' }}
          />
          <input
            placeholder="Target ₦"
            inputMode="decimal"
            value={goalForm.target}
            onChange={(e) => setGoalForm({ ...goalForm, target: e.target.value })}
            style={{ width: 110, padding: 8, borderRadius: 8, border: '1px solid #cfd6de' }}
          />
          <button
            disabled={!goalForm.name || !goalForm.target}
            onClick={() => {
              const token = readMemberToken();
              if (!token) return;
              void apiFetch('/member/goals', token, {
                method: 'POST',
                body: JSON.stringify({
                  name: goalForm.name,
                  targetAmount: Number(goalForm.target),
                }),
              })
                .then(() => {
                  setGoalForm({ name: '', target: '' });
                  return refresh();
                })
                .catch(() => undefined);
            }}
          >
            Add
          </button>
        </div>
      </section>

      {instructions.length > 0 && (
        <section className="card" style={{ marginTop: 14 }}>
          <h2 style={{ margin: '0 0 8px', fontSize: 15 }}>Standing contributions</h2>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {instructions.map((i) => (
              <li key={i.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '4px 0' }}>
                <span>{i.frequency.toLowerCase()} · ₦{i.amount.toLocaleString()}</span>
                <span style={{ color: '#5b6772', fontSize: 13 }}>next {i.nextRunDate}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card" style={{ marginTop: 14 }}>
        <h2 style={{ margin: '0 0 8px', fontSize: 15 }}>My documents (KYC)</h2>
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp,application/pdf"
          disabled={uploading}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void uploadDocument(file);
          }}
        />
        {docMsg && <p style={{ fontSize: 13, color: '#5b6772' }}>{docMsg}</p>}
        <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0' }}>
          {docs.map((d) => (
            <li key={d.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 0' }}>
              <span>
                {d.docType} · {d.fileName}
              </span>
              <strong style={{ color: d.status === 'VERIFIED' ? '#0a6c2e' : d.status === 'REJECTED' ? '#b42318' : '#8a6d00' }}>
                {d.status}
              </strong>
            </li>
          ))}
          {docs.length === 0 && <li style={{ fontSize: 13, color: '#5b6772' }}>No documents uploaded yet.</li>}
        </ul>
      </section>

      {notes.length > 0 && (
        <section className="card" style={{ marginTop: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={{ margin: '0 0 8px', fontSize: 15 }}>Notifications</h2>
            <button
              style={{ fontSize: 12, padding: '4px 8px' }}
              onClick={() => {
                const token = readMemberToken();
                if (!token) return;
                void apiFetch('/member/notifications/read', token, {
                  method: 'POST',
                  body: JSON.stringify({}),
                })
                  .then(() => refresh())
                  .catch(() => undefined);
              }}
            >
              Mark all read
            </button>
          </div>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {notes.slice(0, 5).map((n) => (
              <li
                key={n.id}
                style={{
                  padding: '8px 0',
                  borderBottom: '1px solid #eef1f4',
                  opacity: n.readAt ? 0.6 : 1,
                }}
              >
                <strong style={{ fontSize: 14 }}>{n.title}</strong>
                <p style={{ margin: '2px 0 0', fontSize: 13, color: '#5b6772' }}>{n.body}</p>
              </li>
            ))}
          </ul>
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
