'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch, clearSession, readToken } from '../../lib/api';

interface ApprovalItem {
  type: 'WITHDRAWAL' | 'LOAN' | 'JOURNAL' | 'PAYROLL';
  id: string;
  reference: string;
  summary: string;
  amount: string | null;
  requestedBy: string | null;
  ageHours: number;
  actionBase: string;
  canAct: boolean;
  blockedReason?: string;
}

const LABEL: Record<ApprovalItem['type'], string> = {
  WITHDRAWAL: 'Withdrawal',
  LOAN: 'Loan',
  JOURNAL: 'Journal',
  PAYROLL: 'Payroll',
};

const money = (v: string | null) =>
  v == null ? '—' : `₦${Number(v).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`;

function waited(hours: number): string {
  if (hours < 1) return 'just now';
  if (hours < 24) return `${Math.round(hours)}h`;
  return `${Math.floor(hours / 24)}d ${Math.round(hours % 24)}h`;
}

/**
 * Everything waiting for a decision, in one place.
 *
 * The inbox API applies segregation of duties; this screen only shows what it says, so an officer
 * reads "someone else must decide this" instead of clicking a button that refuses them.
 */
export default function ApprovalsPage() {
  const [items, setItems] = useState<ApprovalItem[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reasonFor, setReasonFor] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<{ items: ApprovalItem[]; counts: Record<string, number> }>(
        '/approvals',
        readToken() ?? undefined,
      );
      setItems(data.items ?? []);
      setCounts(data.counts ?? {});
      setError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not load the queue';
      setError(message);
      if (/401|Not signed in/i.test(message)) {
        clearSession();
        window.location.href = '/login';
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(item: ApprovalItem, action: 'approve' | 'reject'): Promise<void> {
    const key = `${item.id}:${action}`;
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const group = item.type === 'PAYROLL' ? 'payroll' : 'journals';
      await apiFetch(`/approvals/${group}/${item.id}/${action}`, readToken() ?? undefined, {
        method: 'POST',
        body: JSON.stringify(action === 'reject' ? { reason } : {}),
      });
      setNotice(`${LABEL[item.type]} ${action === 'approve' ? 'approved' : 'rejected'}.`);
      setReasonFor(null);
      setReason('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That decision was not accepted');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack">
      <div className="row spread">
        <h1>Needs a decision</h1>
        <button className="link" onClick={() => void load()}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      <p className="muted">
        {items.length === 0
          ? 'Nothing is waiting.'
          : `${items.length} item${items.length === 1 ? '' : 's'} waiting · ` +
            Object.entries(counts)
              .map(([type, n]) => `${n} ${LABEL[type as ApprovalItem['type']] ?? type}`)
              .join(' · ')}
      </p>

      {notice && <p className="notice">{notice}</p>}
      {error && <p className="error">{error}</p>}

      {items.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Type</th>
              <th>What</th>
              <th>Amount</th>
              <th>Raised by</th>
              <th>Waiting</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={`${item.type}-${item.id}`}>
                <td>
                  <span className="pill">{LABEL[item.type]}</span>
                </td>
                <td>
                  {item.reference}
                  {!item.canAct && item.blockedReason && (
                    <div className="muted small">{item.blockedReason}</div>
                  )}
                </td>
                <td className="num">{money(item.amount)}</td>
                <td className="small">{item.requestedBy ?? '—'}</td>
                <td className="small">{waited(item.ageHours)}</td>
                <td className="actions">
                  {!item.canAct ? (
                    <a className="link" href={item.actionBase}>
                      Open
                    </a>
                  ) : item.type === 'PAYROLL' ? (
                    <div className="row">
                      <button disabled={busy !== null} onClick={() => void decide(item, 'approve')}>
                        {busy === `${item.id}:approve` ? 'Posting…' : 'Approve & post'}
                      </button>
                      <button
                        className="link"
                        onClick={() => setReasonFor(reasonFor === item.id ? null : item.id)}
                      >
                        Reject
                      </button>
                    </div>
                  ) : item.type === 'JOURNAL' ? (
                    <button disabled={busy !== null} onClick={() => void decide(item, 'approve')}>
                      {busy === `${item.id}:approve` ? 'Posting…' : 'Approve & post'}
                    </button>
                  ) : (
                    <a className="link" href={item.actionBase}>
                      Decide there
                    </a>
                  )}

                  {reasonFor === item.id && (
                    <div className="stack">
                      <input
                        placeholder="Why is it being rejected?"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                      />
                      <button
                        className="danger"
                        disabled={busy !== null || reason.trim().length === 0}
                        onClick={() => void decide(item, 'reject')}
                      >
                        {busy === `${item.id}:reject` ? 'Rejecting…' : 'Confirm rejection'}
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
