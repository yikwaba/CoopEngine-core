'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { apiFetch, clearSession, readToken } from '../../../lib/api';

interface LoanDetail {
  id: string;
  memberNo?: number;
  memberName?: string | null;
  productCode: string;
  principal: number;
  termMonths: number;
  interestRatePa: number;
  status: string;
  outstandingPrincipal: number;
  rejectionReason: string | null;
  createdAt: string;
}

interface ScheduleRow {
  seq: number;
  dueDate: string;
  principalDue: number;
  interestDue: number;
  paidPrincipal: number;
  paidInterest: number;
  status: string;
}

interface PaymentEvent {
  entryNo: number;
  entryDate: string;
  description: string;
  principalPortion: number;
  interestPortion: number;
  postedAt: string;
}

interface GuarantorRow {
  id: string;
  memberNo: number;
  memberName: string;
  status: string;
}

const naira = (n: number): string => `₦${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

async function restructureLoan(loanId: string, months: number, reason: string, token: string) {
  await apiFetch(`/loans/${loanId}/restructure`, token, {
    method: 'POST',
    body: JSON.stringify({ newTermMonths: months, reason }),
  });
}

export default function LoanDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const loanId = params.id;
  const [loan, setLoan] = useState<LoanDetail | null>(null);
  const [schedule, setSchedule] = useState<ScheduleRow[]>([]);
  const [payments, setPayments] = useState<PaymentEvent[]>([]);
  const [guarantors, setGuarantors] = useState<GuarantorRow[]>([]);
  const [repayAmount, setRepayAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const token = readToken();
    if (!token) {
      router.replace('/login');
      return;
    }
    try {
      const [l, s, p, g] = await Promise.all([
        apiFetch<LoanDetail>(`/loans/${loanId}`, token),
        apiFetch<ScheduleRow[]>(`/loans/${loanId}/schedule`, token),
        apiFetch<PaymentEvent[]>(`/loans/${loanId}/payments`, token),
        apiFetch<GuarantorRow[]>(`/loans/${loanId}/guarantors`, token),
      ]);
      setLoan(l);
      setSchedule(s);
      setPayments(p);
      setGuarantors(g);
      setError(null);
    } catch (err) {
      clearSession();
      setError(err instanceof Error ? err.message : 'Failed to load loan');
      router.replace('/login');
    }
  }, [router, loanId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(action: 'approve' | 'disburse'): Promise<void> {
    const token = readToken();
    if (!token) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`/loans/${loanId}/${action}`, token, { method: 'POST' });
      setNotice(`Loan ${action}d.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : `${action} failed`);
    } finally {
      setBusy(false);
    }
  }

  async function captureRepayment(): Promise<void> {
    const token = readToken();
    const amount = Number(repayAmount);
    if (!token || !amount) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await apiFetch<{ loan: LoanDetail }>(`/loans/${loanId}/repayments`, token, {
        method: 'POST',
        body: JSON.stringify({ amount }),
      });
      setNotice(`Repaid ${naira(amount)} — outstanding ${naira(result.loan.outstandingPrincipal)}.`);
      setRepayAmount('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Repayment failed');
    } finally {
      setBusy(false);
    }
  }

  if (!loan) {
    return (
      <main style={{ maxWidth: 900, margin: '0 auto', padding: 28 }}>
        <p>{error ?? 'Loading…'}</p>
      </main>
    );
  }

  const nextDue = schedule.find((r) => r.status === 'PENDING' || r.status === 'PARTIAL');

  return (
    <main style={{ maxWidth: 980, margin: '0 auto', padding: 28 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <p style={{ margin: 0, color: '#5b6772', fontSize: 13 }}>
            {loan.productCode} · {loan.status} {loan.memberName ? `· ${loan.memberName} (${loan.memberNo})` : ''}
          </p>
          <h1 style={{ margin: '2px 0 0', fontSize: 22 }}>
            {naira(loan.principal)} over {loan.termMonths} months @ {loan.interestRatePa}%
          </h1>
        </div>
        {['DISBURSED', 'DEFAULTED'].includes(loan.status) && (
          <button
            onClick={() => {
              const monthsRaw = window.prompt('New term (months, 1-60):', '6');
              if (!monthsRaw) return;
              const reason = window.prompt('Reason for restructuring (min 5 chars):');
              if (!reason) return;
              const token = readToken();
              if (!token) return;
              void restructureLoan(loanId, Number(monthsRaw), reason, token)
                .then(() => load())
                .catch((e) => setError(e instanceof Error ? e.message : 'Restructure failed'));
            }}
          >
            Restructure
          </button>
        )}
        <Link href="/loans" style={{ fontSize: 14 }}>
          ← Loans
        </Link>
      </div>

      {notice && <p style={{ background: '#ecfdf3', color: '#067647', borderRadius: 8, padding: '10px 12px', marginTop: 14 }}>{notice}</p>}
      {error && <p style={{ background: '#fdecea', color: '#b42318', borderRadius: 8, padding: '10px 12px', marginTop: 14 }}>{error}</p>}

      <section style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        {loan.status === 'PENDING' && (
          <button className="btn" disabled={busy} onClick={() => void act('approve')}>
            Approve
          </button>
        )}
        {(loan.status === 'PENDING' || loan.status === 'APPROVED') && (
          <button className="btn secondary" disabled={busy} onClick={() => void act('disburse')}>
            Disburse
          </button>
        )}
        {(loan.status === 'DISBURSED' || loan.status === 'DEFAULTED') && (
          <>
            <input
              className="field"
              type="number"
              min="0"
              value={repayAmount}
              onChange={(e) => setRepayAmount(e.target.value)}
              placeholder={nextDue ? `Next due ${naira(nextDue.principalDue + nextDue.interestDue)}` : 'Amount'}
              style={{ maxWidth: 220 }}
            />
            <button className="btn" disabled={busy || !repayAmount} onClick={() => void captureRepayment()}>
              Record repayment
            </button>
          </>
        )}
      </section>

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginTop: 18 }}>
        <div className="card">
          <p className="stat-label">Outstanding</p>
          <p className="stat-value">{naira(loan.outstandingPrincipal)}</p>
        </div>
        <div className="card">
          <p className="stat-label">Next due</p>
          <p className="stat-value" style={{ fontSize: 16 }}>
            {nextDue ? `${naira(nextDue.principalDue + nextDue.interestDue)} on ${nextDue.dueDate}` : '—'}
          </p>
        </div>
        <div className="card">
          <p className="stat-label">Guarantors</p>
          <p className="stat-value">{guarantors.length}</p>
        </div>
        <div className="card">
          <p className="stat-label">Repayments</p>
          <p className="stat-value">{payments.length}</p>
        </div>
      </section>

      <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 16 }}>
        <div className="card">
          <h2 style={{ margin: '0 0 10px', fontSize: 16 }}>Schedule</h2>
          <table className="data">
            <thead>
              <tr>
                <th>#</th>
                <th>Due</th>
                <th>Principal</th>
                <th>Interest</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {schedule.map((r) => (
                <tr key={r.seq}>
                  <td>{r.seq}</td>
                  <td>{r.dueDate}</td>
                  <td>{naira(r.principalDue)}</td>
                  <td>{naira(r.interestDue)}</td>
                  <td>{r.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="card">
            <h2 style={{ margin: '0 0 10px', fontSize: 16 }}>Repayment history</h2>
            {payments.length === 0 ? (
              <p style={{ color: '#5b6772' }}>No repayments yet.</p>
            ) : (
              <table className="data">
                <thead>
                  <tr>
                    <th>Entry</th>
                    <th>Date</th>
                    <th>Principal</th>
                    <th>Interest</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p) => (
                    <tr key={p.entryNo}>
                      <td>#{p.entryNo}</td>
                      <td>{p.entryDate}</td>
                      <td>{naira(p.principalPortion)}</td>
                      <td>{naira(p.interestPortion)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div className="card">
            <h2 style={{ margin: '0 0 10px', fontSize: 16 }}>Guarantors</h2>
            {guarantors.length === 0 ? (
              <p style={{ color: '#5b6772' }}>None.</p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {guarantors.map((g) => (
                  <li key={g.id} style={{ fontSize: 14, marginBottom: 4 }}>
                    {g.memberName} (#{g.memberNo}) — {g.status}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
