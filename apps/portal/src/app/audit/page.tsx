'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiFetch, clearSession, readToken, API_BASE } from '../../lib/api';

interface AuditRow {
  id: string;
  actorEmail: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

const PAGE = 25;

export default function AuditPage() {
  const router = useRouter();
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [action, setAction] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (act: string, off: number) => {
      const token = readToken();
      if (!token) {
        router.replace('/login');
        return;
      }
      try {
        const q = new URLSearchParams({ limit: String(PAGE), offset: String(off) });
        if (act) q.set('action', act);
        const res = await fetch(`${API_BASE}/reports/audit-logs?${q.toString()}`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store',
        });
        if (!res.ok) throw new Error(`Request failed (${res.status})`);
        const body = (await res.json()) as AuditRow[];
        setRows(body);
        setTotal(Number(res.headers.get('x-total-count') ?? body.length));
        setError(null);
      } catch (err) {
        clearSession();
        setError(err instanceof Error ? err.message : 'Failed to load audit log');
        router.replace('/login');
      }
    },
    [router],
  );

  useEffect(() => {
    void load('', 0);
  }, [load]);

  const pages = Math.max(1, Math.ceil(total / PAGE));
  const page = Math.floor(offset / PAGE) + 1;

  return (
    <main style={{ maxWidth: 1100, margin: '0 auto', padding: 28 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ margin: 0 }}>Audit log</h1>
        <Link href="/" style={{ fontSize: 14 }}>
          ← Dashboard
        </Link>
      </div>
      <p style={{ color: '#5b6772', fontSize: 14 }}>{total} events</p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          setOffset(0);
          void load(action, 0);
        }}
        style={{ display: 'flex', gap: 8, margin: '12px 0' }}
      >
        <input
          className="field"
          value={action}
          onChange={(e) => setAction(e.target.value)}
          placeholder="Filter by action (e.g. member.status.exited, journal.auto.posted)"
          style={{ maxWidth: 420 }}
        />
        <button className="btn" type="submit">
          Filter
        </button>
      </form>

      {error && <p style={{ color: '#b42318' }}>{error}</p>}

      <div className="card">
        <table className="data">
          <thead>
            <tr>
              <th>When</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Entity</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ color: '#5b6772' }}>
                  No events.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id}>
                  <td style={{ whiteSpace: 'nowrap', fontSize: 13 }}>
                    {new Date(r.createdAt).toLocaleString()}
                  </td>
                  <td style={{ fontSize: 13 }}>{r.actorEmail ?? 'system'}</td>
                  <td>
                    <code style={{ fontSize: 12 }}>{r.action}</code>
                  </td>
                  <td style={{ fontSize: 13 }}>
                    {r.entityType ?? '—'}
                    {r.entityId ? ` · ${r.entityId.slice(0, 8)}…` : ''}
                  </td>
                  <td style={{ fontSize: 12, fontFamily: 'monospace', color: '#5b6772' }}>
                    {r.metadata ? JSON.stringify(r.metadata).slice(0, 90) : ''}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 14, alignItems: 'center' }}>
        <button
          className="btn secondary"
          disabled={page <= 1}
          onClick={() => {
            const off = Math.max(0, offset - PAGE);
            setOffset(off);
            void load(action, off);
          }}
        >
          ← Prev
        </button>
        <span style={{ fontSize: 14, color: '#5b6772' }}>
          Page {page} of {pages}
        </span>
        <button
          className="btn secondary"
          disabled={page >= pages}
          onClick={() => {
            const off = offset + PAGE;
            setOffset(off);
            void load(action, off);
          }}
        >
          Next →
        </button>
      </div>
    </main>
  );
}
