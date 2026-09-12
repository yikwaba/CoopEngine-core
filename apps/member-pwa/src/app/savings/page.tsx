'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiFetch, downloadMemberPdf, readMemberToken, clearMemberSession } from '../../lib/api';

interface Account {
  id: string;
  accountNo: string;
  balance: number;
  status: string;
  productCode: string;
  productName: string;
}

interface Movement {
  id: string;
  accountId: string;
  type: string;
  amount: number;
  runningBalance: number;
  description: string | null;
  date: string;
}

interface SavingsResponse {
  accounts: Account[];
  totalBalance: number;
  transactions: Movement[];
}

const money = (v: number | undefined): string => {
  const n = Number(v ?? 0);
  const sign = n < 0 ? '-' : '';
  return `${sign}₦${Math.abs(n).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const day = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-NG', { day: '2-digit', month: 'short', year: 'numeric' });

export default function SavingsPage() {
  const router = useRouter();
  const [data, setData] = useState<SavingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const token = readMemberToken();
    if (!token) {
      router.replace('/login');
      return;
    }
    try {
      setData(await apiFetch<SavingsResponse>('/member/savings', token));
      setError(null);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not load your savings.';
      if (/unauthor|invalid token|expired|401/i.test(message)) {
        clearMemberSession();
        router.replace('/login');
        return;
      }
      setError(message);
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function download(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await downloadMemberPdf('/member/statements/savings.pdf', 'savings-statement.pdf');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not prepare the statement.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: 20 }}>
      <p style={{ fontSize: 14, marginTop: 0 }}>
        <Link href="/">← Back to dashboard</Link>
      </p>
      <h1 style={{ marginBottom: 4 }}>My savings</h1>
      <p style={{ color: '#5b6772', marginTop: 0, fontSize: 13 }}>
        Your balances and everything that has moved.
      </p>

      {error && <p style={{ background: '#fdecea', color: '#8a1c1c', padding: 10, borderRadius: 8 }}>{error}</p>}

      <section style={{ border: '1px solid #e2e6eb', borderRadius: 12, padding: 16, marginTop: 12 }}>
        <div style={{ fontSize: 13, color: '#5b6772' }}>Total savings</div>
        <div style={{ fontSize: 28, fontWeight: 700 }}>{data ? money(data.totalBalance) : '…'}</div>
        {data?.accounts.map((a) => (
          <div key={a.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, marginTop: 8 }}>
            <span style={{ color: '#5b6772' }}>
              {a.productName} · {a.accountNo}
            </span>
            <strong>{money(a.balance)}</strong>
          </div>
        ))}
        <button className="btn" style={{ marginTop: 14 }} disabled={busy} onClick={download}>
          {busy ? 'Preparing…' : 'Download statement (PDF)'}
        </button>
      </section>

      <section style={{ marginTop: 18 }}>
        <h2 style={{ fontSize: 16 }}>Recent movements</h2>
        {data && data.transactions.length === 0 && (
          <p style={{ color: '#5b6772', fontSize: 14 }}>No deposits or withdrawals yet.</p>
        )}
        {data && data.transactions.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: '#5b6772', fontSize: 12 }}>
                <th style={{ padding: '6px 0' }}>Date</th>
                <th style={{ padding: '6px 0' }}>What</th>
                <th style={{ padding: '6px 0', textAlign: 'right' }}>Amount</th>
                <th style={{ padding: '6px 0', textAlign: 'right' }}>Balance</th>
              </tr>
            </thead>
            <tbody>
              {data.transactions.map((t) => (
                <tr key={t.id} style={{ borderTop: '1px solid #eef1f4' }}>
                  <td style={{ padding: '8px 0', color: '#5b6772' }}>{day(t.date)}</td>
                  <td style={{ padding: '8px 0' }}>{t.description ?? t.type.replace(/_/g, ' ').toLowerCase()}</td>
                  <td style={{ padding: '8px 0', textAlign: 'right', color: t.amount < 0 ? '#8a1c1c' : '#0a6c2e' }}>
                    {money(t.amount)}
                  </td>
                  <td style={{ padding: '8px 0', textAlign: 'right' }}>{money(t.runningBalance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
