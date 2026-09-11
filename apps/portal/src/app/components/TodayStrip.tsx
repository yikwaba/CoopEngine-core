'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { apiFetch, readToken } from '../../lib/api';

interface WithdrawalRow {
  id: string;
  status: string;
  amount: string | number;
  member_name?: string;
}

interface ArrearsRow {
  daysLate?: number;
  amount?: string | number;
  member?: string;
  loanId?: string;
}

/** /loans/arrears answers with { buckets, rows, total } — not a bare array. */
interface ArrearsResponse {
  rows?: ArrearsRow[];
}

/**
 * The "what needs me today" strip. Deliberately tiny: two numbers that matter and
 * four things an officer actually does. Everything else lives one click away.
 */
export default function TodayStrip() {
  const [pending, setPending] = useState<WithdrawalRow[]>([]);
  const [arrears, setArrears] = useState<ArrearsRow[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const token = readToken();
    if (!token) return;
    let cancelled = false;
    (async () => {
      // Each call is independent: one failing module must not blank the strip.
      const [w, a] = await Promise.allSettled([
        apiFetch<WithdrawalRow[]>('/savings/withdrawals?status=PENDING', token),
        apiFetch<ArrearsResponse | ArrearsRow[]>('/loans/arrears', token),
      ]);
      if (cancelled) return;
      if (w.status === 'fulfilled') setPending(Array.isArray(w.value) ? w.value : []);
      if (a.status === 'fulfilled') {
        const value = a.value;
        setArrears(Array.isArray(value) ? value : (value?.rows ?? []));
      }
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const overdue = arrears.filter((r) => Number(r.daysLate ?? 0) > 0).length;
  const money = (v: string | number | undefined): string =>
    `₦${Number(v ?? 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const tile: React.CSSProperties = {
    flex: '1 1 190px',
    border: '1px solid #e5e7eb',
    borderRadius: 10,
    padding: '12px 14px',
    textDecoration: 'none',
    color: 'inherit',
    background: '#fff',
  };

  return (
    <section style={{ marginBottom: 24 }}>
      <h2 style={{ margin: '0 0 10px', fontSize: 18 }}>Today</h2>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <Link href="/front-desk" style={{ ...tile, background: '#1d4ed8', color: '#fff', border: 'none' }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>Front desk →</div>
          <div style={{ fontSize: 13, opacity: 0.9 }}>Find a member · take money · print a statement</div>
        </Link>

        <Link href="/withdrawals" style={{ ...tile, borderColor: loaded && pending.length ? '#f59e0b' : '#e5e7eb' }}>
          <div style={{ fontSize: 13, color: '#666' }}>Withdrawals awaiting a second officer</div>
          <div style={{ fontSize: 22, fontWeight: 600, color: loaded && pending.length ? '#b45309' : '#111' }}>
            {loaded ? pending.length : '—'}
          </div>
          {loaded && pending.length > 0 && (
            <div style={{ fontSize: 12, color: '#666' }}>
              {money(pending.reduce((a, r) => a + Number(r.amount ?? 0), 0))} in total
            </div>
          )}
        </Link>

        <Link href="/loans" style={{ ...tile, borderColor: loaded && overdue ? '#f59e0b' : '#e5e7eb' }}>
          <div style={{ fontSize: 13, color: '#666' }}>Loans with missed instalments</div>
          <div style={{ fontSize: 22, fontWeight: 600, color: loaded && overdue ? '#b45309' : '#111' }}>
            {loaded ? overdue : '—'}
          </div>
          {loaded && overdue > 0 && (
            <div style={{ fontSize: 12, color: '#666' }}>
              {money(arrears.reduce((a, r) => a + Number(r.amount ?? 0), 0))} overdue
            </div>
          )}
        </Link>

        <Link href="/month-end" style={tile}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>Close the month →</div>
          <div style={{ fontSize: 13, color: '#666' }}>Checklist, board pack, lock the books</div>
        </Link>
      </div>
    </section>
  );
}
