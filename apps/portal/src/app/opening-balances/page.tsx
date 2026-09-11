'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiFetch, clearSession, readToken } from '../../lib/api';
import Nav from '../components/Nav';

interface PreviewRow {
  row: number;
  memberRef: string;
  memberName: string | null;
  savings: number;
  shares: number;
  loanOutstanding: number;
  loanTermMonths: number | null;
  errors: string[];
}

interface PreviewResult {
  batchId: string | null;
  totals: { rows: number; valid: number; invalid: number };
  validTotals: { savings: number; shares: number; loans: number };
  rows: PreviewRow[];
}

interface Batch {
  id: string;
  label: string;
  status: string;
  memberCount: number;
  savingsTotal: number;
  sharesTotal: number;
  loansTotal: number;
  createdAt: string;
  postedAt: string | null;
}

const SAMPLE = `memberEmail,savings,shares,loanOutstanding,loanTermMonths,loanRatePa
ada@example.com,50000,10000,0,,
bola@example.com,0,0,20000,6,15`;

export default function OpeningBalancesPage() {
  const router = useRouter();
  const [label, setLabel] = useState('');
  const [csv, setCsv] = useState(SAMPLE);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadBatches = useCallback(async () => {
    const token = readToken();
    if (!token) {
      router.replace('/login');
      return;
    }
    try {
      setBatches(await apiFetch<Batch[]>('/migrations/opening-balances', token));
    } catch (e) {
      if (String(e).includes('401')) {
        clearSession();
        router.replace('/login');
      }
    }
  }, [router]);

  useEffect(() => {
    void loadBatches();
  }, [loadBatches]);

  async function runPreview() {
    const token = readToken();
    if (!token) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await apiFetch<PreviewResult>('/migrations/opening-balances/preview', token, {
        method: 'POST',
        body: JSON.stringify({ label: label || 'Opening balances', filename: 'opening-balances.csv', csv }),
      });
      setPreview(result);
      if (!result.batchId) {
        setError('Nothing valid to migrate — fix the rows flagged below and preview again.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Preview failed');
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    const token = readToken();
    if (!token || !preview?.batchId) return;
    if (!window.confirm('Post these balances to the ledger? This cannot be undone.')) return;
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<{ members: number; savings: number; shares: number; loans: number; entryNo: number }>(
        `/migrations/opening-balances/${preview.batchId}/commit`,
        token,
        { method: 'POST', body: JSON.stringify({}) },
      );
      setMessage(
        `Posted ${result.members} member(s) — savings ₦${result.savings.toLocaleString()}, ` +
          `shares ₦${result.shares.toLocaleString()}, loans ₦${result.loans.toLocaleString()} ` +
          `(journal entry #${result.entryNo}).`,
      );
      setPreview(null);
      await loadBatches();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Posting failed');
    } finally {
      setBusy(false);
    }
  }

  const cell: React.CSSProperties = { padding: '6px 10px', borderBottom: '1px solid #e6e9ee', fontSize: 13 };

  return (
    <main style={{ maxWidth: 1000, margin: '0 auto', padding: 20 }}>
      <h1 style={{ marginBottom: 4 }}>Opening balances</h1>
      <p style={{ color: '#5b6772', marginTop: 0 }}>
        Bring a cooperative&apos;s existing savings, share capital and live loans onto the platform.
        Preview first — nothing is written to the ledger until you post.
      </p>
      <Nav />

      {message && <p style={{ background: '#e8f5ec', color: '#0a6c2e', padding: 10, borderRadius: 6 }}>{message}</p>}
      {error && <p style={{ background: '#fdecea', color: '#8a1c1c', padding: 10, borderRadius: 6 }}>{error}</p>}

      <label style={{ display: 'block', fontSize: 13, color: '#5b6772', marginTop: 12 }}>Batch label</label>
      <input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Legacy balances at cut-over"
        style={{ width: '100%', padding: 8, border: '1px solid #cfd6de', borderRadius: 6, marginTop: 4 }}
      />

      <label style={{ display: 'block', fontSize: 13, color: '#5b6772', marginTop: 12 }}>
        CSV — memberEmail (or memberNo), savings, shares, loanOutstanding, loanTermMonths, loanRatePa
      </label>
      <textarea
        value={csv}
        onChange={(e) => setCsv(e.target.value)}
        rows={8}
        style={{ width: '100%', padding: 8, border: '1px solid #cfd6de', borderRadius: 6, marginTop: 4, fontFamily: 'monospace', fontSize: 12 }}
      />

      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button disabled={busy} onClick={() => void runPreview()}>
          Preview
        </button>
        <button disabled={busy || !preview?.batchId} onClick={() => void commit()}>
          Post to ledger
        </button>
        {preview?.batchId && (
          <span style={{ fontSize: 13, color: '#5b6772', alignSelf: 'center' }}>
            batch {preview.batchId.slice(0, 8)} · {preview.totals.valid} valid / {preview.totals.invalid} invalid
          </span>
        )}
      </div>

      {preview && (
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 14 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: '#5b6772', fontSize: 12 }}>
              <th style={cell}>Row</th>
              <th style={cell}>Member</th>
              <th style={cell}>Savings</th>
              <th style={cell}>Shares</th>
              <th style={cell}>Loan</th>
              <th style={cell}>Issues</th>
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((r) => (
              <tr key={r.row} style={{ background: r.errors.length ? '#fff6f6' : undefined }}>
                <td style={cell}>{r.row}</td>
                <td style={cell}>{r.memberName ?? r.memberRef}</td>
                <td style={cell}>{r.savings.toLocaleString()}</td>
                <td style={cell}>{r.shares.toLocaleString()}</td>
                <td style={cell}>{r.loanOutstanding.toLocaleString()}</td>
                <td style={cell}>{r.errors.join('; ') || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 style={{ marginTop: 24, fontSize: 16 }}>Migration batches</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', color: '#5b6772', fontSize: 12 }}>
            <th style={cell}>Label</th>
            <th style={cell}>Status</th>
            <th style={cell}>Members</th>
            <th style={cell}>Savings</th>
            <th style={cell}>Shares</th>
            <th style={cell}>Loans</th>
            <th style={cell}>Created</th>
          </tr>
        </thead>
        <tbody>
          {batches.map((b) => (
            <tr key={b.id}>
              <td style={cell}>{b.label}</td>
              <td style={cell}>{b.status}</td>
              <td style={cell}>{b.memberCount}</td>
              <td style={cell}>{b.savingsTotal.toLocaleString()}</td>
              <td style={cell}>{b.sharesTotal.toLocaleString()}</td>
              <td style={cell}>{b.loansTotal.toLocaleString()}</td>
              <td style={cell}>{new Date(b.createdAt).toLocaleString()}</td>
            </tr>
          ))}
          {batches.length === 0 && (
            <tr>
              <td style={cell} colSpan={7}>
                No migrations yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <p style={{ marginTop: 22 }}>
        <Link href="/">← Dashboard</Link>
      </p>
    </main>
  );
}
