'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiFetch, clearSession, readToken } from '../../lib/api';
import Nav from '../components/Nav';

interface Check {
  key: string;
  label: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

interface Checklist {
  period: { code: string; status: string } | null;
  readyToClose: boolean;
  checks: Check[];
}

const badge: Record<string, React.CSSProperties> = {
  ok: { background: '#e8f5ec', color: '#0a6c2e', padding: '2px 8px', borderRadius: 999, fontSize: 12 },
  warn: { background: '#fff6e5', color: '#8a5a00', padding: '2px 8px', borderRadius: 999, fontSize: 12 },
  fail: { background: '#fdecea', color: '#8a1c1c', padding: '2px 8px', borderRadius: 999, fontSize: 12 },
};

export default function MonthEndPage() {
  const router = useRouter();
  const thisMonth = new Date().toISOString().slice(0, 7);
  const [period, setPeriod] = useState(thisMonth);
  const [data, setData] = useState<Checklist | null>(null);
  const [periodId, setPeriodId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (code: string) => {
    const token = readToken();
    if (!token) {
      router.replace('/login');
      return;
    }
    try {
      const [checklist, periods] = await Promise.all([
        apiFetch<Checklist>(`/ledger/month-end-checklist?period=${code}`, token),
        apiFetch<{ id: string; code: string; status: string }[] | { items: { id: string; code: string; status: string }[] }>(
          '/ledger/periods',
          token,
        ),
      ]);
      setData(checklist);
      const list = Array.isArray(periods) ? periods : periods.items;
      setPeriodId(list.find((p) => p.code === code)?.id ?? null);
    } catch (e) {
      if (String(e).includes('401')) {
        clearSession();
        router.replace('/login');
      } else {
        setError(e instanceof Error ? e.message : 'Could not load the checklist');
      }
    }
  }, [router]);

  useEffect(() => {
    void load(period);
  }, [load, period]);

  async function ensurePeriod() {
    const token = readToken();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch('/ledger/periods', token, {
        method: 'POST',
        body: JSON.stringify({ code: period }),
      });
      setMessage(`Period ${period} is ready.`);
      await load(period);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the period');
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(status: 'OPEN' | 'SOFT_CLOSED' | 'LOCKED') {
    const token = readToken();
    if (!token || !periodId) return;
    if (
      status !== 'OPEN' &&
      !window.confirm(
        status === 'LOCKED'
          ? 'Lock this period? It cannot be reopened — corrections would need a reversing entry.'
          : 'Soft-close this period? No new entries can be posted into it until it is reopened.',
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/ledger/periods/${periodId}/status`, token, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      setMessage(`Period is now ${status.replace('_', ' ').toLowerCase()}.`);
      setData(null);
      await load(period);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Status change refused');
    } finally {
      setBusy(false);
    }
  }

  const cell: React.CSSProperties = { padding: '6px 10px', borderBottom: '1px solid #e6e9ee', fontSize: 13 };

  return (
    <main style={{ maxWidth: 900, margin: '0 auto', padding: 20 }}>
      <h1 style={{ marginBottom: 4 }}>Month-end close</h1>
      <p style={{ color: '#5b6772', marginTop: 0 }}>
        Work through the checklist, then soft-close (reversible) or lock (final) the month.
      </p>
      <Nav />

      {message && <p style={{ background: '#e8f5ec', color: '#0a6c2e', padding: 10, borderRadius: 6 }}>{message}</p>}
      {error && <p style={{ background: '#fdecea', color: '#8a1c1c', padding: 10, borderRadius: 6 }}>{error}</p>}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
        <label style={{ fontSize: 13, color: '#5b6772' }}>Period</label>
        <input
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          placeholder="YYYY-MM"
          style={{ padding: 8, border: '1px solid #cfd6de', borderRadius: 6, width: 140 }}
        />
        <button disabled={busy} onClick={() => void load(period)}>
          Run checks
        </button>
        {!periodId && (
          <button disabled={busy} onClick={() => void ensurePeriod()}>
            Create period
          </button>
        )}
      </div>

      {data && (
        <>
          <p style={{ marginTop: 14, fontSize: 14 }}>
            Status:{' '}
            <strong>{data.period ? data.period.status.replace('_', ' ') : 'not created'}</strong>{' '}
            {data.readyToClose ? (
              <span style={badge.ok}>ready to close</span>
            ) : (
              <span style={badge.fail}>blocked</span>
            )}
          </p>

          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
            <tbody>
              {data.checks.map((c) => (
                <tr key={c.key}>
                  <td style={cell}>{c.label}</td>
                  <td style={cell}>
                    <span style={badge[c.status]}>{c.status}</span>
                  </td>
                  <td style={{ ...cell, color: '#5b6772' }}>{c.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {periodId && (
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button
                disabled={busy || data.period?.status !== 'OPEN'}
                onClick={() => void setStatus('SOFT_CLOSED')}
              >
                Soft-close
              </button>
              <button
                disabled={busy || data.period?.status === 'LOCKED'}
                onClick={() => void setStatus('LOCKED')}
              >
                Lock
              </button>
              <button
                disabled={busy || data.period?.status !== 'SOFT_CLOSED'}
                onClick={() => void setStatus('OPEN')}
              >
                Reopen
              </button>
            </div>
          )}
        </>
      )}

      <p style={{ marginTop: 22 }}>
        <Link href="/">← Dashboard</Link>
      </p>
    </main>
  );
}
