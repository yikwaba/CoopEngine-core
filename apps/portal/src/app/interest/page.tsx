'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiFetch, clearSession, readToken } from '../../lib/api';

interface AccrualRow {
  memberNo: number;
  member: string;
  productCode: string;
  productName: string;
  ratePa: number;
  balance: number;
  amount: number;
}

interface PreviewResponse {
  period: string;
  total: number;
  rows: AccrualRow[];
}

const naira = (n: number): string => `₦${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

export default function InterestPage() {
  const router = useRouter();
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function runPreview(): Promise<void> {
    const token = readToken();
    if (!token) {
      router.replace('/login');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const data = await apiFetch<PreviewResponse>('/savings/interest/preview', token);
      if (data.total === 0 && data.rows.length === 0) {
        setError('Nothing to post — no ACTIVE balances on a product with a rate > 0.');
      }
      setPreview(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Preview failed');
    } finally {
      setBusy(false);
    }
  }

  async function runPost(): Promise<void> {
    const token = readToken();
    if (!token) return;
    if (preview && !confirm(`Post ${naira(preview.total)} of savings interest for ${preview.period}?`)) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await apiFetch<{ period: string; total: number; accounts: number; entryNo: number }>(
        '/savings/interest/post',
        token,
        { method: 'POST' },
      );
      setNotice(
        `Posted ${naira(result.total)} to ${result.accounts} account(s) for ${result.period} (journal #${result.entryNo}).`,
      );
      setPreview(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Posting failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 900, margin: '0 auto', padding: 28 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ margin: 0 }}>Savings interest</h1>
        <Link href="/" style={{ fontSize: 14 }}>
          ← Dashboard
        </Link>
      </div>

      <p style={{ color: '#5b6772', marginTop: 8 }}>
        One month of accrual on ACTIVE balances at each product&apos;s annual rate. Posting is
        idempotent per month and books <code>Dr 5000 / Cr 2000</code> through the ledger.
      </p>

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button className="btn" disabled={busy} onClick={() => void runPreview()}>
          Preview current month
        </button>
        <button className="btn secondary" disabled={busy || !preview} onClick={() => void runPost()}>
          Post interest
        </button>
      </div>

      {notice && <p style={{ background: '#ecfdf3', color: '#067647', borderRadius: 8, padding: '10px 12px', marginTop: 14 }}>{notice}</p>}
      {error && <p style={{ background: '#fdecea', color: '#b42318', borderRadius: 8, padding: '10px 12px', marginTop: 14 }}>{error}</p>}

      {preview && (
        <>
          <div className="card" style={{ marginTop: 14 }}>
            <p style={{ margin: 0 }}>
              <strong>{preview.period}</strong> — {preview.rows.length} account(s), total{' '}
              <strong>{naira(preview.total)}</strong>
            </p>
          </div>
          <div className="card" style={{ marginTop: 10 }}>
            <table className="data">
              <thead>
                <tr>
                  <th>Member</th>
                  <th>Product</th>
                  <th>Rate p.a.</th>
                  <th>Balance</th>
                  <th>Monthly</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={`${r.memberNo}-${r.productCode}`}>
                    <td>
                      {r.member} (#{r.memberNo})
                    </td>
                    <td>{r.productName}</td>
                    <td>{r.ratePa}%</td>
                    <td>{naira(r.balance)}</td>
                    <td>
                      <strong>{naira(r.amount)}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  );
}
