'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiFetch, clearSession, readToken, API_BASE } from '../../lib/api';
import Nav from '../components/Nav';

interface DocRow {
  id: string;
  memberId: string;
  docType: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  status: string;
  reviewNotes: string | null;
  createdAt: string;
}

export default function DocumentsPage() {
  const router = useRouter();
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [status, setStatus] = useState('PENDING');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const token = readToken();
    if (!token) {
      router.replace('/login');
      return;
    }
    try {
      const query = status ? `?status=${status}` : '';
      setDocs(await apiFetch<DocRow[]>(`/documents${query}`, token));
      setError(null);
    } catch (e) {
      if (String(e).includes('401')) {
        clearSession();
        router.replace('/login');
        return;
      }
      setError(e instanceof Error ? e.message : 'Could not load documents');
    }
  }, [router, status]);

  useEffect(() => {
    void load();
  }, [load]);

  async function review(id: string, decision: 'VERIFIED' | 'REJECTED') {
    const token = readToken();
    if (!token) return;
    const notes =
      decision === 'REJECTED' ? (window.prompt('Reason for rejection (optional):') ?? '') : '';
    setBusy(true);
    try {
      await apiFetch(`/documents/${id}/verify`, token, {
        method: 'POST',
        body: JSON.stringify({ status: decision, notes: notes || undefined }),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Review failed');
    } finally {
      setBusy(false);
    }
  }

  async function openDoc(id: string) {
    const token = readToken();
    if (!token) return;
    const res = await fetch(`${API_BASE}/documents/${id}/download`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      setError(`Download failed (${res.status})`);
      return;
    }
    const blob = await res.blob();
    window.open(URL.createObjectURL(blob), '_blank');
  }

  const cell: React.CSSProperties = { padding: '6px 10px', borderBottom: '1px solid #e6e9ee', fontSize: 13 };

  return (
    <main style={{ maxWidth: 1000, margin: '0 auto', padding: 20 }}>
      <h1 style={{ marginBottom: 4 }}>KYC documents</h1>
      <p style={{ color: '#5b6772', marginTop: 0 }}>Verification queue for member documents.</p>
      <Nav />

      {error && <p style={{ background: '#fdecea', color: '#8a1c1c', padding: 10, borderRadius: 6 }}>{error}</p>}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 12 }}>
        <label style={{ fontSize: 13, color: '#5b6772' }}>Status</label>
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ padding: 6 }}>
          <option value="PENDING">Pending</option>
          <option value="VERIFIED">Verified</option>
          <option value="REJECTED">Rejected</option>
          <option value="">All</option>
        </select>
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 14 }}>
        <thead>
          <tr style={{ textAlign: 'left', color: '#5b6772', fontSize: 12 }}>
            <th style={cell}>Type</th>
            <th style={cell}>File</th>
            <th style={cell}>Size</th>
            <th style={cell}>Status</th>
            <th style={cell}>Uploaded</th>
            <th style={cell} />
          </tr>
        </thead>
        <tbody>
          {docs.map((d) => (
            <tr key={d.id}>
              <td style={cell}>{d.docType}</td>
              <td style={cell}>{d.fileName}</td>
              <td style={cell}>{Math.round(d.sizeBytes / 1024)} KB</td>
              <td style={cell}>{d.status}</td>
              <td style={cell}>{new Date(d.createdAt).toLocaleString()}</td>
              <td style={cell}>
                <button disabled={busy} onClick={() => void openDoc(d.id)}>
                  Open
                </button>{' '}
                {d.status === 'PENDING' && (
                  <>
                    <button disabled={busy} onClick={() => void review(d.id, 'VERIFIED')}>
                      Verify
                    </button>{' '}
                    <button disabled={busy} onClick={() => void review(d.id, 'REJECTED')}>
                      Reject
                    </button>
                  </>
                )}
              </td>
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
