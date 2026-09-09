'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiFetch, clearSession, readToken, API_BASE } from '../../lib/api';

interface LoanRow {
  id: string;
  memberNo?: number;
  memberName?: string | null;
  productCode: string;
  principal: number;
  termMonths: number;
  interestRatePa: number;
  status: string;
  outstandingPrincipal: number;
  createdAt: string;
}

interface ScheduleRow {
  seq: number;
  dueDate: string;
  principalDue: number;
  interestDue: number;
  status: string;
}

const STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'DISBURSED', 'DEFAULTED', 'COMPLETED'];
const naira = (n: number): string => `₦${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

export default function LoansPage() {
  const router = useRouter();
  const [loans, setLoans] = useState<LoanRow[]>([]);
  const [filter, setFilter] = useState('');
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (status: string) => {
      const token = readToken();
      if (!token) {
        router.replace('/login');
        return;
      }
      try {
        const res = await fetch(
          `${API_BASE}/loans?limit=200${status ? `&status=${status}` : ''}`,
          { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
        );
        if (!res.ok) throw new Error(`Request failed (${res.status})`);
        const body = (await res.json()) as LoanRow[];
        setLoans(body);
        setTotal(Number(res.headers.get('x-total-count') ?? body.length));
        setError(null);
      } catch (err) {
        clearSession();
        setError(err instanceof Error ? err.message : 'Failed to load loans');
        router.replace('/login');
      }
    },
    [router],
  );

  useEffect(() => {
    void load('');
  }, [load]);

  async function act(loan: LoanRow, action: 'approve' | 'disburse'): Promise<void> {
    const token = readToken();
    if (!token) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`/loans/${loan.id}/${action}`, token, { method: 'POST' });
      setNotice(`Loan ${action}d (#${loan.id.slice(0, 8)}…)`);
      await load(filter);
    } catch (err) {
      setError(err instanceof Error ? err.message : `${action} failed`);
    } finally {
      setBusy(false);
    }
  }

  /** Captures the earliest unpaid installment as a repayment. */
  async function repay(loan: LoanRow): Promise<void> {
    const token = readToken();
    if (!token) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const schedule = await apiFetch<ScheduleRow[]>(`/loans/${loan.id}/schedule`, token);
      const due = schedule.find((r) => r.status === 'PENDING' || r.status === 'PARTIAL');
      if (!due) throw new Error('No installment due on this loan');
      const amount = due.principalDue + due.interestDue;
      const result = await apiFetch<{ loan: LoanRow }>(`/loans/${loan.id}/repayments`, token, {
        method: 'POST',
        body: JSON.stringify({ amount }),
      });
      const remaining = result.loan.outstandingPrincipal;
      setNotice(
        `Repaid ${naira(amount)} on #${loan.memberNo ?? loan.id.slice(0, 8)} — outstanding now ${naira(remaining)}`,
      );
      await load(filter);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Repayment failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 1080, margin: '0 auto', padding: 28 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ margin: 0 }}>Loans</h1>
        <Link href="/" style={{ fontSize: 14 }}>
          ← Dashboard
        </Link>
      </div>

      <div style={{ display: 'flex', gap: 8, margin: '16px 0', alignItems: 'center' }}>
        <button className={`btn ${filter === '' ? '' : 'secondary'}`} onClick={() => { setFilter(''); void load(''); }}>
          All ({filter === '' ? total : '…'})
        </button>
        {STATUSES.map((s) => (
          <button
            key={s}
            className={`btn ${filter === s ? '' : 'secondary'}`}
            onClick={() => { setFilter(s); void load(s); }}
          >
            {s}
          </button>
        ))}
      </div>

      {notice && <p style={{ background: '#ecfdf3', color: '#067647', borderRadius: 8, padding: '10px 12px' }}>{notice}</p>}
      {error && <p style={{ background: '#fdecea', color: '#b42318', borderRadius: 8, padding: '10px 12px' }}>{error}</p>}

      <div className="card" style={{ marginTop: 6 }}>
        <table className="data">
          <thead>
            <tr>
              <th>Member</th>
              <th>Product</th>
              <th>Principal</th>
              <th>Outstanding</th>
              <th>Rate</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loans.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ color: '#5b6772' }}>
                  No loans{filter ? ` with status ${filter}` : ''}.
                </td>
              </tr>
            ) : (
              loans.map((l) => (
                <tr key={l.id}>
                  <td>
                    {l.memberName ?? '—'}
                    {l.memberNo ? <span style={{ color: '#5b6772' }}> (#{l.memberNo})</span> : null}
                  </td>
                  <td>{l.productCode}</td>
                  <td>{naira(l.principal)}</td>
                  <td>{l.status === 'DISBURSED' || l.status === 'DEFAULTED' ? naira(l.outstandingPrincipal) : '—'}</td>
                  <td>{l.interestRatePa}%</td>
                  <td>{l.status}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <Link href={`/loans/${l.id}`} style={{ fontSize: 14, marginRight: 8 }}>
                      Open →
                    </Link>
                    {l.status === 'PENDING' && (
                      <>
                        <button className="btn" style={{ padding: '5px 10px', marginRight: 6 }} disabled={busy} onClick={() => void act(l, 'approve')}>
                          Approve
                        </button>
                        <button className="btn secondary" style={{ padding: '5px 10px' }} disabled={busy} onClick={() => void act(l, 'disburse')}>
                          Disburse
                        </button>
                      </>
                    )}
                    {l.status === 'APPROVED' && (
                      <button className="btn" style={{ padding: '5px 10px' }} disabled={busy} onClick={() => void act(l, 'disburse')}>
                        Disburse
                      </button>
                    )}
                    {(l.status === 'DISBURSED' || l.status === 'DEFAULTED') && (
                      <button className="btn secondary" style={{ padding: '5px 10px' }} disabled={busy} onClick={() => void repay(l)}>
                        Record repayment
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
