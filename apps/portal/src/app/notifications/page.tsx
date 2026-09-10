'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiFetch, clearSession, readToken } from '../../lib/api';
import Nav from '../components/Nav';

interface NotificationRow {
  id: string;
  memberId: string | null;
  type: string;
  title: string;
  body: string;
  channels: string[];
  status: string;
  sentAt: string | null;
  externalRef: string | null;
  error: string | null;
  createdAt: string;
}

interface NotificationList {
  items: NotificationRow[];
  total: number;
  pending: number;
}

export default function NotificationsPage() {
  const router = useRouter();
  const [data, setData] = useState<NotificationList | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const token = readToken();
    if (!token) {
      router.replace('/login');
      return;
    }
    try {
      const query = status ? `?status=${status}` : '';
      setData(await apiFetch<NotificationList>(`/notifications${query}`, token));
      setError(null);
    } catch (e) {
      if (String(e).includes('401')) {
        clearSession();
        router.replace('/login');
        return;
      }
      setError(e instanceof Error ? e.message : 'Could not load notifications');
    }
  }, [router, status]);

  useEffect(() => {
    void load();
  }, [load]);

  async function dispatch() {
    const token = readToken();
    if (!token) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await apiFetch<{ attempted: number; sent: number; failed: number }>(
        '/notifications/dispatch',
        token,
        { method: 'POST', body: JSON.stringify({}) },
      );
      setMessage(
        `Dispatched ${result.attempted} record(s) — ${result.sent} sent, ${result.failed} failed.`,
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Dispatch failed');
    } finally {
      setBusy(false);
    }
  }

  const cell: React.CSSProperties = { padding: '6px 10px', borderBottom: '1px solid #e6e9ee', fontSize: 13 };

  return (
    <main style={{ maxWidth: 1040, margin: '0 auto', padding: 20 }}>
      <h1 style={{ marginBottom: 4 }}>Notifications</h1>
      <p style={{ color: '#5b6772', marginTop: 0 }}>
        Every member message (in-app, SMS, email) with its delivery state.
        {data ? ` ${data.pending} pending.` : ''}
      </p>
      <Nav />

      {error && <p style={{ background: '#fdecea', color: '#8a1c1c', padding: 10, borderRadius: 6 }}>{error}</p>}
      {message && <p style={{ background: '#e7f6ec', color: '#0a6c2e', padding: 10, borderRadius: 6 }}>{message}</p>}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 12 }}>
        <label style={{ fontSize: 13, color: '#5b6772' }}>Status</label>
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ padding: 6 }}>
          <option value="">All</option>
          <option value="PENDING">Pending</option>
          <option value="SENT">Sent</option>
          <option value="FAILED">Failed</option>
        </select>
        <button disabled={busy} onClick={() => void dispatch()}>
          Dispatch pending
        </button>
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 14 }}>
        <thead>
          <tr style={{ textAlign: 'left', color: '#5b6772', fontSize: 12 }}>
            <th style={cell}>Created</th>
            <th style={cell}>Type</th>
            <th style={cell}>Title</th>
            <th style={cell}>Channels</th>
            <th style={cell}>Status</th>
            <th style={cell}>Reference</th>
          </tr>
        </thead>
        <tbody>
          {data?.items.map((n) => (
            <tr key={n.id}>
              <td style={cell}>{new Date(n.createdAt).toLocaleString()}</td>
              <td style={cell}>{n.type}</td>
              <td style={cell}>{n.title}</td>
              <td style={cell}>{n.channels.join(', ')}</td>
              <td style={cell}>{n.status}</td>
              <td style={cell}>{n.externalRef ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p style={{ marginTop: 22 }}>
        <Link href="/">← Dashboard</Link>
      </p>
    </main>
  );
}
