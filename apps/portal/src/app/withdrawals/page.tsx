'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiFetch, clearSession, readToken } from '../../lib/api';
import Nav from '../components/Nav';

interface WithdrawalRequest {
  id: string;
  memberName: string | null;
  memberNo: number | null;
  amount: number;
  description: string | null;
  status: string;
  source: string;
  requestedBy: string | null;
  requestedAt: string;
  decisionNotes: string | null;
}

export default function WithdrawalApprovalsPage() {
  const router = useRouter();
  const [rows, setRows] = useState<WithdrawalRequest[]>([]);
  const [threshold, setThreshold] = useState<string>('');
  const [policy, setPolicy] = useState<number | null>(null);
  const [status, setStatus] = useState('PENDING');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const token = readToken();
    if (!token) {
      router.replace('/login');
      return;
    }
    try {
      const [list, pol] = await Promise.all([
        apiFetch<WithdrawalRequest[]>(`/savings/withdrawals${status ? `?status=${status}` : ''}`, token),
        apiFetch<{ threshold: number | null }>('/savings/settings/withdrawal-approval', token),
      ]);
      setRows(list);
      setPolicy(pol.threshold);
      setThreshold(pol.threshold === null ? '' : String(pol.threshold));
    } catch (e) {
      if (String(e).includes('401')) {
        clearSession();
        router.replace('/login');
      } else {
        setError(e instanceof Error ? e.message : 'Could not load withdrawals');
      }
    }
  }, [router, status]);

  useEffect(() => {
    void load();
  }, [load]);

  async function savePolicy() {
    const token = readToken();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const value = threshold.trim() === '' ? null : Number(threshold);
      const res = await apiFetch<{ threshold: number | null }>(
        '/savings/settings/withdrawal-approval',
        token,
        { method: 'PATCH', body: JSON.stringify({ threshold: value }) },
      );
      setPolicy(res.threshold);
      setMessage(
        res.threshold === null
          ? 'Approvals disabled — withdrawals post immediately.'
          : res.threshold === 0
            ? 'Every withdrawal now needs a second approval.'
            : `Withdrawals above ₦${res.threshold.toLocaleString()} now need approval.`,
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the policy');
    } finally {
      setBusy(false);
    }
  }

  async function decide(id: string, action: 'approve' | 'reject') {
    const token = readToken();
    if (!token) return;
    if (action === 'approve' && !window.confirm('Post this withdrawal to the ledger?')) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/savings/withdrawals/${id}/${action}`, token, {
        method: 'POST',
        body: JSON.stringify(action === 'reject' ? { notes: 'rejected from the portal' } : {}),
      });
      setMessage(action === 'approve' ? 'Withdrawal posted.' : 'Withdrawal rejected.');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  }

  const cell: React.CSSProperties = { padding: '6px 10px', borderBottom: '1px solid #e6e9ee', fontSize: 13 };

  return (
    <main style={{ maxWidth: 1000, margin: '0 auto', padding: 20 }}>
      <h1 style={{ marginBottom: 4 }}>Withdrawal approvals</h1>
      <p style={{ color: '#5b6772', marginTop: 0 }}>
        Maker-checker control for savings withdrawals. A request can never be approved by the person
        who raised it.
      </p>
      <Nav />

      {message && <p style={{ background: '#e8f5ec', color: '#0a6c2e', padding: 10, borderRadius: 6 }}>{message}</p>}
      {error && <p style={{ background: '#fdecea', color: '#8a1c1c', padding: 10, borderRadius: 6 }}>{error}</p>}

      <section style={{ border: '1px solid #e6e9ee', borderRadius: 8, padding: 12, marginTop: 12 }}>
        <h2 style={{ fontSize: 15, marginTop: 0 }}>Policy</h2>
        <p style={{ fontSize: 13, color: '#5b6772' }}>
          Currently:{' '}
          {policy === null
            ? 'no approval required (withdrawals post immediately)'
            : policy === 0
              ? 'every withdrawal needs approval'
              : `withdrawals above ₦${policy.toLocaleString()} need approval`}
        </p>
        <label style={{ fontSize: 13, color: '#5b6772' }}>
          Threshold (blank = approvals off, 0 = always require)
        </label>
        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          <input
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            placeholder="e.g. 50000"
            style={{ padding: 8, border: '1px solid #cfd6de', borderRadius: 6, width: 200 }}
          />
          <button disabled={busy} onClick={() => void savePolicy()}>
            Save policy
          </button>
        </div>
      </section>

      <div style={{ display: 'flex', gap: 8, marginTop: 16, alignItems: 'center' }}>
        <label style={{ fontSize: 13, color: '#5b6772' }}>Status</label>
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ padding: 6, borderRadius: 6, border: '1px solid #cfd6de' }}>
          <option value="PENDING">Pending</option>
          <option value="APPROVED">Approved</option>
          <option value="REJECTED">Rejected</option>
          <option value="">All</option>
        </select>
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 10 }}>
        <thead>
          <tr style={{ textAlign: 'left', color: '#5b6772', fontSize: 12 }}>
            <th style={cell}>Member</th>
            <th style={cell}>Amount</th>
            <th style={cell}>Reason</th>
            <th style={cell}>Raised by</th>
            <th style={cell}>Status</th>
            <th style={cell} />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td style={cell}>
                {r.memberName ?? '—'}
                {r.memberNo ? ` (#${r.memberNo})` : ''}
              </td>
              <td style={cell}>₦{r.amount.toLocaleString()}</td>
              <td style={cell}>{r.description ?? '—'}</td>
              <td style={cell}>
                {r.source === 'MEMBER' ? 'member self-service' : (r.requestedBy ?? '—')}
              </td>
              <td style={cell}>{r.status}</td>
              <td style={cell}>
                {r.status === 'PENDING' && (
                  <span style={{ display: 'flex', gap: 6 }}>
                    <button disabled={busy} onClick={() => void decide(r.id, 'approve')}>
                      Approve
                    </button>
                    <button disabled={busy} onClick={() => void decide(r.id, 'reject')}>
                      Reject
                    </button>
                  </span>
                )}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td style={cell} colSpan={6}>
                Nothing to show.
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
